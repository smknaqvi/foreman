/**
 * `foreman status`: where the crew stands, rebuilt from GitHub and the local machine alone (no Coordinator
 * memory needed): the base branch's CI, the issues Builders are on, each open PR's checks, approval
 * (including one from before a rebase) and risky files, PRs merged recently, self-hosted runners, the agent
 * sessions on this machine (and whether the last one stopped at a usage limit), the watchdog, and the local
 * environments still running.
 * Run it when starting or resuming as Coordinator, e.g. after a session limit.
 */
import { existsSync } from 'node:fs';
import { loadAdapter } from './env/index.mjs';
import { agentActivity, observerRound } from './sessions.mjs';
import { readCrew } from './state.mjs';
import { gh, why } from './sh.mjs';
import { observing, summary as watchdogSummary } from './watchdog.mjs';

export async function status(config) {
	const { baseBranch: base, labels, launchComment } = config;
	let crew;
	try {
		crew = await readCrew(config);
	} catch (e) {
		console.error(e.message);
		return 1;
	}
	const { issues, prs, merged } = crew;

	function prText(pr) {
		const f = pr.foreman;
		const checkText = f.failed.length ? `checks FAILED (${f.failed.join(', ')})`
			: f.queued.length && f.queued.length === f.running.length ? `checks queued, waiting for a runner (${f.queued.join(', ')})`
			: f.running.length ? `checks running (${f.running.join(', ')})` : f.checks ? 'checks passed' : 'no checks yet';
		const approval = f.approvedAtHead ? `approved at ${pr.headRefOid}` : f.approvedBefore ? `approved at ${f.approvedBefore}, before a later push (fine if that push was only a rebase)` : 'not approved';
		const extra = [pr.isDraft && 'draft', pr.mergeable === 'CONFLICTING' ? 'has conflicts: rebase' : pr.mergeStateStatus === 'BEHIND' && `behind ${base}: rebase first`].filter(Boolean);
		if (f.risky.length) extra.push(`RISKY: ${f.risky.slice(0, 3).join(', ')}${f.risky.length > 3 ? '…' : ''} (stricter review)`);
		return [checkText, approval, ...extra].join(' · ');
	}

	if (crew.rebaseLookupFailed) console.log(`(Couldn't check for approvals from before a rebase: ${crew.rebaseLookupFailed}. "not approved" below may be wrong.)\n`);

	console.log(base);
	if (!crew.runs.length) console.log('  no CI runs');
	for (const r of crew.runs) console.log(`  ${r.workflowName}: ${r.status === 'completed' ? r.conclusion : r.status === 'queued' ? 'queued (waiting for a runner)' : r.status} · ${r.displayTitle.slice(0, 70)}`);
	runners();

	console.log(`\nIssues a Builder is on (label "${labels.working}")`);
	if (!issues.length) console.log('  none');
	const linked = new Set();
	for (const issue of issues) {
		console.log(`  #${issue.number} ${issue.title}`);
		console.log(`    ${issue.launch ? `${issue.launch.body.split('\n')[0]} (${issue.launch.createdAt.slice(0, 16).replace('T', ' ')} UTC)` : `no "${launchComment}" comment`}`);
		const mine = prs.filter((p) => p.foreman.closes.includes(issue.number));
		if (!mine.length) console.log('    no PR yet: still building, or the Builder stopped (check its worktree)');
		for (const pr of mine) {
			linked.add(pr.number);
			console.log(`    PR #${pr.number}: ${prText(pr)}`);
		}
	}

	const others = prs.filter((p) => !linked.has(p.number));
	console.log('\nOther open PRs');
	if (!others.length) console.log('  none');
	for (const pr of others) console.log(`  #${pr.number} ${pr.title.slice(0, 70)}\n    ${prText(pr)}${pr.foreman.closes.length ? ` · closes #${pr.foreman.closes.join(', #')}` : ''}`);

	// Merged recently, maybe while this session was away: their "Plan updates" may still need applying.
	console.log(`\nMerged in the last 24 hours${config.planFile ? ` (apply their "Plan updates" to ${config.planFile} if you haven't)` : ''}`);
	if (!merged.length) console.log('  none');
	for (const p of merged) console.log(`  #${p.number} ${p.title.slice(0, 70)} (${p.mergedAt.slice(0, 16).replace('T', ' ')} UTC)`);

	const ready = prs.filter((p) => p.foreman.ready);
	if (ready.length) {
		console.log('\nApproved, waiting to merge (its Builder runs this; if the Builder is gone, the Coordinator rebases and runs it, or npx --no-install foreman tick does both. foreman merge refuses if anything changed)');
		for (const pr of ready) console.log(`  #${pr.number}: ${pr.foreman.merge}`);
	}

	// Agent sessions on this machine: when one last did anything, and whether the newest stopped at a limit.
	try {
		const a = agentActivity(config.root);
		if (a.lastActiveAt) {
			console.log(`\nAgents on this machine\n  last active ${Math.round((Date.now() - a.lastActiveAt) / 60000)} min ago (${a.checkout})`);
			if (a.limited) console.log(`  that session STOPPED AT A USAGE LIMIT: "${a.limited.text}"${a.limited.resetsAt ? ` (resets ${new Date(a.limited.resetsAt).toLocaleString()})` : ''}`);
		}
		const o = observerRound(config.root);
		if (o.at && Date.now() - o.at < 3600e3) console.log(`  Observer: last round ${Math.round((Date.now() - o.at) / 60000)} min ago (${o.checkout})${observing(o.at, config.observe.intervalSeconds) ? '; running, so the watchdog leaves merges to the Coordinator' : ''}`);
	} catch {}
	const wd = watchdogSummary(config);
	if (wd) console.log(`\nWatchdog (npx --no-install foreman watchdog status)\n${wd}`);

	const adapter = await loadAdapter(config);
	if (adapter.name === 'none') return 0;
	console.log(`\nLocal environments (${adapter.name})`);
	let envs;
	try {
		envs = await adapter.list();
	} catch (e) {
		console.log(`  couldn't list them: ${why(e)}${adapter.usesDocker ? ' (is Docker running?)' : ''}`);
		return 0;
	}
	if (!envs.length) console.log('  none');
	for (const env of envs) {
		const owner = env.port ? issues.find((i) => i.port === String(env.port)) : null;
		const orphan = env.folder && !existsSync(env.folder);
		const who = owner ? `Builder for #${owner.number}` : orphan ? `ORPHANED: its folder is gone, safe to remove${adapter.canRemove ? ' (npx --no-install foreman tick removes it)' : ''}` : 'no labeled issue: the Coordinator\'s own, another workspace\'s, or left over';
		console.log(`  port ${env.port || '?'}  ${env.folder || env.name}\n    ${who}`);
	}
	return 0;
}

/** Self-hosted runners, when the repo has any and gh may read them (it needs admin rights). */
function runners() {
	let list;
	try { list = gh('api', 'repos/{owner}/{repo}/actions/runners', '--jq', '[.runners[] | {name, status, busy}]'); } catch { return; }
	if (!list.length) return;
	console.log(`  self-hosted runners: ${list.map((r) => `${r.name} ${r.status}${r.busy ? ', busy' : ''}`).join('; ')}${list.every((r) => r.status !== 'online') ? ' (checks wait in the queue until one is back: that isn\'t a failure)' : ''}`);
}
