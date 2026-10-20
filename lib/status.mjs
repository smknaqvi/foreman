/**
 * `foreman status`: where the crew stands, rebuilt from GitHub and the local machine alone (no Coordinator
 * memory needed): the base branch's CI, the issues Builders are on (the working label plus the launch
 * comment `foreman claim` wrote), each open PR's checks, approval (including one from before a rebase) and
 * risky files, PRs merged recently, and the local environments still running.
 * Run it when starting or resuming as Coordinator, e.g. after a session limit.
 */
import { existsSync } from 'node:fs';
import { loadAdapter } from './env/index.mjs';
import { gh, why } from './sh.mjs';

export async function status(config) {
	const { baseBranch: base, approvalContext: context, labels, launchComment } = config;
	let runs, issues, prs, merged, repo;
	try {
		repo = gh('repo', 'view', '--json', 'owner,name');
		runs = gh('run', 'list', '--branch', base, '--limit', '5', '--json', 'workflowName,status,conclusion,displayTitle');
		issues = gh('issue', 'list', '--label', labels.working, '--state', 'open', '--limit', '50', '--json', 'number,title,comments');
		const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
		merged = gh('pr', 'list', '--state', 'merged', '--search', `merged:>=${since}`, '--limit', '100', '--json', 'number,title,mergedAt');
		prs = gh('pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefOid,isDraft,mergeable,mergeStateStatus,statusCheckRollup,closingIssuesReferences,files');
	} catch (e) {
		console.error(`Couldn't read GitHub (is gh logged in? try: gh auth status)\n${why(e)}`);
		return 1;
	}

	const closes = (pr) => (pr.closingIssuesReferences || []).map((i) => i.number);
	const launchOf = (issue) => [...issue.comments].reverse().find((c) => c.body.startsWith(launchComment));
	const approvedHead = (pr) => (pr.statusCheckRollup || []).some((c) => c.__typename === 'StatusContext' && c.context === context && c.state === 'SUCCESS');
	const risky = (pr) => (pr.files || []).map((f) => f.path).filter((p) => config.riskyPaths.some((r) => p === r || (r.endsWith('/') && p.startsWith(r))));

	// Approvals on commits a PR had before a force-push (a rebase), for every PR not approved at its head, in
	// one query. `foreman merge --rebased-from` takes this sha.
	const approvedBefore = new Map();
	let rebaseLookupFailed = '';
	const unapproved = prs.filter((p) => !approvedHead(p));
	if (unapproved.length) {
		const pr = (n) => `p${n}:pullRequest(number:${n}){timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],last:20){nodes{...on HeadRefForcePushedEvent{beforeCommit{oid statusCheckRollup{state} status{contexts{context state}}}}}}}`;
		const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${unapproved.map((p) => pr(p.number)).join(' ')}}}`;
		try {
			const data = gh('api', 'graphql', '-f', `query=${query}`, '-f', `owner=${repo.owner.login}`, '-f', `name=${repo.name}`).data.repository;
			for (const p of unapproved) {
				const nodes = [...data[`p${p.number}`].timelineItems.nodes].reverse();
				const hit = nodes.find((n) => n.beforeCommit?.status?.contexts.some((c) => c.context === context && c.state === 'SUCCESS'));
				if (hit) approvedBefore.set(p.number, { sha: hit.beforeCommit.oid, green: hit.beforeCommit.statusCheckRollup?.state === 'SUCCESS' });
			}
		} catch (e) {
			rebaseLookupFailed = why(e);
		}
	}

	function prState(pr) {
		const rollup = pr.statusCheckRollup || [];
		const checks = rollup.filter((c) => c.__typename === 'CheckRun');
		const failed = [
			...checks.filter((c) => c.status === 'COMPLETED' && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion)).map((c) => c.name),
			...rollup.filter((c) => c.__typename === 'StatusContext' && ['FAILURE', 'ERROR'].includes(c.state)).map((c) => c.context),
		];
		const running = checks.filter((c) => c.status !== 'COMPLETED').map((c) => c.name);
		const head = approvedHead(pr);
		const prior = head ? null : approvedBefore.get(pr.number);
		const before = prior?.sha ?? '';
		const checkText = failed.length ? `checks FAILED (${failed.join(', ')})` : running.length ? `checks running (${running.join(', ')})` : checks.length ? 'checks passed' : 'no checks yet';
		const approval = head ? `approved at ${pr.headRefOid}` : before ? `approved at ${before}, before a later push (fine if that push was only a rebase)` : 'not approved';
		const extra = [pr.isDraft && 'draft', pr.mergeable === 'CONFLICTING' ? 'has conflicts: rebase' : pr.mergeStateStatus === 'BEHIND' && `behind ${base}: rebase first`].filter(Boolean);
		const riskyFiles = risky(pr);
		if (riskyFiles.length) extra.push(`RISKY: ${riskyFiles.slice(0, 3).join(', ')}${riskyFiles.length > 3 ? '…' : ''} (stricter review)`);
		// Always name the approved commit: after the rebase that's usually needed first, the head is a new commit.
		const approvedSha = head ? pr.headRefOid : before;
		const merge = approvedSha ? `npx foreman merge ${pr.number} --rebased-from ${approvedSha}` : '';
		// A clean rebase of an approved commit reuses that commit's checks; an approved head needs its own.
		// foreman merge re-checks all of this and refuses if the push after approval was more than a rebase.
		const ready = merge && !failed.length && !pr.isDraft && pr.mergeable !== 'CONFLICTING' && (before ? prior.green : checks.length && !running.length);
		return { text: [checkText, approval, ...extra].join(' · '), ready, merge };
	}

	const states = new Map(prs.map((p) => [p.number, prState(p)]));
	if (rebaseLookupFailed) console.log(`(Couldn't check for approvals from before a rebase: ${rebaseLookupFailed}. "not approved" below may be wrong.)\n`);

	console.log(base);
	const latest = [...new Map([...runs].reverse().map((r) => [r.workflowName, r])).values()].reverse(); // Newest run of each workflow.
	if (!latest.length) console.log('  no CI runs');
	for (const r of latest) console.log(`  ${r.workflowName}: ${r.status === 'completed' ? r.conclusion : r.status} · ${r.displayTitle.slice(0, 70)}`);

	console.log(`\nIssues a Builder is on (label "${labels.working}")`);
	if (!issues.length) console.log('  none');
	const linked = new Set();
	for (const issue of issues) {
		console.log(`  #${issue.number} ${issue.title}`);
		const launch = launchOf(issue);
		console.log(`    ${launch ? `${launch.body.split('\n')[0]} (${launch.createdAt.slice(0, 16).replace('T', ' ')} UTC)` : `no "${launchComment}" comment`}`);
		const mine = prs.filter((p) => closes(p).includes(issue.number));
		if (!mine.length) console.log('    no PR yet: still building, or the Builder stopped (check its worktree)');
		for (const pr of mine) {
			linked.add(pr.number);
			console.log(`    PR #${pr.number}: ${states.get(pr.number).text}`);
		}
	}

	const others = prs.filter((p) => !linked.has(p.number));
	console.log('\nOther open PRs');
	if (!others.length) console.log('  none');
	for (const pr of others) console.log(`  #${pr.number} ${pr.title.slice(0, 70)}\n    ${states.get(pr.number).text}${closes(pr).length ? ` · closes #${closes(pr).join(', #')}` : ''}`);

	// Merged recently, maybe while this session was away: their "Plan updates" may still need applying.
	const day = Date.now() - 24 * 3600 * 1000;
	const recent = merged.filter((p) => Date.parse(p.mergedAt) > day).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
	console.log(`\nMerged in the last 24 hours${config.planFile ? ` (apply their "Plan updates" to ${config.planFile} if you haven't)` : ''}`);
	if (!recent.length) console.log('  none');
	for (const p of recent) console.log(`  #${p.number} ${p.title.slice(0, 70)} (${p.mergedAt.slice(0, 16).replace('T', ' ')} UTC)`);

	const ready = prs.filter((p) => states.get(p.number).ready);
	if (ready.length) {
		console.log('\nApproved, waiting to merge (its Builder runs this; if the Builder is gone, the Coordinator rebases and runs it. foreman merge refuses if anything changed)');
		for (const pr of ready) console.log(`  #${pr.number}: ${states.get(pr.number).merge}`);
	}

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
		const owner = env.port ? issues.find((i) => new RegExp(`\\bport ${env.port}\\b`).test(launchOf(i)?.body ?? '')) : null;
		const who = owner ? `Builder for #${owner.number}` : env.folder && !existsSync(env.folder) ? 'ORPHANED: its folder is gone, safe to remove' : 'no labeled issue: the Coordinator\'s own, another workspace\'s, or left over';
		console.log(`  port ${env.port || '?'}  ${env.folder || env.name}\n    ${who}`);
	}
	return 0;
}
