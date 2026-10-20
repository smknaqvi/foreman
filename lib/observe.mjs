/**
 * `foreman observe`: prints one line per change worth acting on: PRs opened or closed, check results,
 * failures on the base branch's CI, Docker memory pressure. The Coordinator runs it under Claude Code's
 * Monitor tool. Nothing here decides anything.
 * State is kept in this checkout's git directory, so a restart (Monitor re-arming it) doesn't repeat old
 * news, and observers in two worktrees don't share it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { dockerUp, memory } from './env/docker.mjs';
import { loadAdapter } from './env/index.mjs';
import { gh, git } from './sh.mjs';

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'error', 'action_required', 'startup_failure']);
const PENDING = new Set(['pending', 'expected', 'queued', 'in_progress', 'waiting', 'requested']);

export async function observe(config, { once = false } = {}) {
	const dir = resolve(config.root, git('-C', config.root, 'rev-parse', '--git-dir'), 'foreman');
	mkdirSync(dir, { recursive: true });
	const file = join(dir, 'observer.json');
	const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { prs: null, checks: {}, main: {}, mem: 'ok' };
	const adapter = await loadAdapter(config);
	const { intervalSeconds, memoryHigh, memoryCritical } = config.observe;

	for (;;) {
		for (const line of await tick(config, state, adapter, { memoryHigh, memoryCritical })) console.log(line);
		writeFileSync(file, JSON.stringify(state));
		if (once) return 0;
		await sleep(intervalSeconds * 1000);
	}
}

/** One round: updates `state` and returns the lines to print. */
export async function tick(config, state, adapter, { memoryHigh, memoryCritical }) {
	const out = [];
	// Open PRs with their checks. If gh fails (network, rate limit), skip this part of the round: an empty
	// answer would look like every PR closed.
	let prs = null;
	try {
		prs = gh('pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,statusCheckRollup');
	} catch {}
	if (prs) {
		const open = prs.map((p) => p.number);
		if (state.prs) {
			for (const n of open) if (!state.prs.includes(n)) out.push(`PR opened: #${n}`);
			for (const n of state.prs) if (!open.includes(n)) out.push(`PR closed or merged: #${n}`);
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
			if (anyFailed || !anyPending) out.push(`checks: #${p.number} ${p.headRefName} ${anyFailed ? 'FAILED' : 'passed'} (${summary})`);
		}
		state.checks = checks;
	}

	// The base branch's CI: the latest run of each workflow. Only failures that are new.
	try {
		const runs = gh('run', 'list', '--branch', config.baseBranch, '--limit', '10', '--json', 'workflowName,conclusion,status,displayTitle,databaseId');
		const latest = {};
		for (const r of runs) latest[r.workflowName] ??= r;
		for (const [name, r] of Object.entries(latest)) {
			const key = `${r.databaseId}:${r.status}:${r.conclusion}`;
			if (state.main[name] !== key && r.status === 'completed' && FAILED.has(r.conclusion)) out.push(`${config.baseBranch.toUpperCase()} CI: ${name} ${r.conclusion} · ${r.displayTitle.slice(0, 60)}`);
			state.main[name] = key;
		}
	} catch {}

	// Docker memory (sum of container usage against the VM's total) and how many environments are running.
	if (adapter.usesDocker) {
		if (!dockerUp()) {
			if (state.mem !== 'down') out.push('DOCKER DOWN: docker info failed');
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
						out.push(`DOCKER MEMORY ${level}: ${used}MiB of ${total}MiB (${pct}%), ${envs} environments running`);
					}
					state.mem = level;
				}
			} catch {}
		}
	}
	return out;
}
