/**
 * `foreman observe`: prints one line per change worth acting on: PRs opened or closed, check results,
 * preview deployments ready, failures on the base branch's CI, Docker memory pressure. The Coordinator runs it
 * under Claude Code's Monitor tool. Nothing here decides anything. Events a person asked to hear about
 * (`foreman notify`) are sent on too, and every few minutes it looks for issues waiting on people.
 * State is kept in this checkout's git directory, so a restart (Monitor re-arming it) doesn't repeat old
 * news, and observers in two worktrees don't share it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { dockerUp, memory } from './env/docker.mjs';
import { loadAdapter } from './env/index.mjs';
import { baseFailed, checkNow, send } from './notify.mjs';
import { previews } from './previews.mjs';
import { gh, git } from './sh.mjs';

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'error', 'action_required', 'startup_failure']);
const PENDING = new Set(['pending', 'expected', 'queued', 'in_progress', 'waiting', 'requested']);

export async function observe(config, { once = false } = {}) {
	const dir = resolve(config.root, git('-C', config.root, 'rev-parse', '--git-dir'), 'foreman');
	mkdirSync(dir, { recursive: true });
	const file = join(dir, 'observer.json');
	const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { prs: null, checks: {}, main: {}, mem: 'ok' };
	const adapter = await loadAdapter(config);

	for (;;) {
		for (const e of await round(config, state, adapter)) {
			console.log(e.text);
			if (e.notify) await send(config, e.notify);
		}
		await checkNow(config, state);
		writeFileSync(file, JSON.stringify(state));
		if (once) return 0;
		await sleep(config.observe.intervalSeconds * 1000);
	}
}

/**
 * One round: updates `state` and returns what changed: [{ kind, text, pr?, notify? }], `notify` being the
 * event for `foreman notify`, for the kinds a person may want. Kinds: pr-opened, pr-closed, checks-passed,
 * checks-failed, preview, base-failed, docker.
 */
export async function round(config, state, adapter) {
	const { memoryHigh, memoryCritical } = config.observe;
	const out = [];
	// Open PRs with their checks. If gh fails (network, rate limit), skip this part of the round: an empty
	// answer would look like every PR closed.
	let prs = null;
	try {
		prs = gh('pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,url,headRefName,headRefOid,statusCheckRollup');
	} catch {}
	if (prs) {
		const open = prs.map((p) => p.number);
		if (state.prs) {
			for (const p of prs) if (!state.prs.includes(p.number)) out.push({ kind: 'pr-opened', pr: p.number, text: `PR opened: #${p.number}` });
			for (const n of state.prs) if (!open.includes(n)) out.push({ kind: 'pr-closed', pr: n, text: `PR closed or merged: #${n}` });
		}
		state.prs = open;
		// Report a PR's checks when they change and something finished: a failure right away, even while
		// other checks are still pending; an all-clear once nothing is pending. PRs without checks are skipped.
		const checks = {};
		for (const p of prs) {
			const results = (p.statusCheckRollup || []).map((c) => [c.name ?? c.context, (c.__typename === 'CheckRun' ? (c.status === 'COMPLETED' ? c.conclusion : 'pending') : c.state ?? '').toLowerCase()]);
			if (!results.length) continue;
			const summary = results.map(([n, s]) => `${n}=${s}`).join(',');
			checks[p.number] = summary;
			if (state.checks[p.number] === summary) continue;
			const anyFailed = results.some(([, s]) => FAILED.has(s));
			const anyPending = results.some(([, s]) => PENDING.has(s));
			if (!anyFailed && anyPending) continue;
			const text = `checks: #${p.number} ${p.headRefName} ${anyFailed ? 'FAILED' : 'passed'} (${summary})`;
			out.push(anyFailed
				? { kind: 'checks-failed', pr: p.number, text, notify: { kind: 'checks-failed', key: `checks-failed:${p.number}:${p.headRefOid}`, url: p.url, title: `#${p.number} checks failed`, text: `${p.title}\n${results.filter(([, s]) => FAILED.has(s)).map(([n]) => n).join(', ')}` } }
				: { kind: 'checks-passed', pr: p.number, text });
		}
		state.checks = checks;

		// Preview deployments of each head (Vercel and the like): once per PR and URL.
		try {
			state.repo ??= gh('repo', 'view', '--json', 'owner,name');
			const seen = state.previews; // Undefined on the first round: what's already there isn't news.
			const live = previews(state.repo, prs);
			for (const p of prs) for (const { environment, url } of live[p.number] ?? []) {
				const key = `${p.headRefOid}:${url}`;
				if (!seen || (seen[p.number] ?? []).includes(key)) continue;
				out.push({ kind: 'preview', pr: p.number, text: `preview: #${p.number} ${p.headRefName} ready at ${url} (${environment})`, notify: { kind: 'preview', key: `preview:${p.number}:${key}`, url, title: `#${p.number} preview ready`, text: `${p.title}\n${url}` } });
			}
			state.previews = Object.fromEntries(prs.map((p) => [p.number, (live[p.number] ?? []).map(({ url }) => `${p.headRefOid}:${url}`)]));
		} catch {}
	}

	// The base branch's CI: the latest run of each workflow. Only failures that are new.
	try {
		const runs = gh('run', 'list', '--branch', config.baseBranch, '--limit', '10', '--json', 'workflowName,conclusion,status,displayTitle,databaseId,event,url');
		const latest = {};
		for (const r of runs) latest[r.workflowName] ??= r;
		for (const [name, r] of Object.entries(latest)) {
			const key = `${r.databaseId}:${r.status}:${r.conclusion}`;
			if (state.main[name] !== key && r.status === 'completed' && FAILED.has(r.conclusion)) out.push({ kind: 'base-failed', text: `${config.baseBranch.toUpperCase()} CI: ${name} ${r.conclusion} · ${r.displayTitle.slice(0, 60)}`, ...(r.event === 'push' ? { notify: baseFailed(config, r) } : {}) });
			state.main[name] = key;
		}
	} catch {}

	// Docker memory (sum of container usage against the VM's total) and how many environments are running.
	if (adapter.usesDocker) {
		if (!dockerUp()) {
			if (state.mem !== 'down') out.push({ kind: 'docker', text: 'DOCKER DOWN: docker info failed' });
			state.mem = 'down';
		} else {
			try {
				const { used, total } = memory();
				if (total > 0) {
					const pct = Math.round((used * 100) / total);
					const level = pct >= memoryCritical ? 'critical' : pct >= memoryHigh ? 'high' : 'ok';
					if (level !== state.mem && level !== 'ok') {
						let envs = '?';
						try { envs = (await adapter.list()).length; } catch {}
						out.push({ kind: 'docker', text: `DOCKER MEMORY ${level}: ${used}MiB of ${total}MiB (${pct}%), ${envs} environments running` });
					}
					state.mem = level;
				}
			} catch {}
		}
	}
	return out;
}
