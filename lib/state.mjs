/**
 * Where the crew stands, read from GitHub alone (no Coordinator memory needed): the base branch's CI, the
 * issues Builders are on (the working label plus the launch comment `foreman claim` wrote), each open PR's
 * checks and approval (including one from before a rebase), and PRs merged recently. `foreman status`
 * prints it; `foreman tick` and the watchdog act on it.
 */
import { gh, why } from './sh.mjs';

export async function readCrew(config) {
	const { baseBranch: base, approvalContext: context, labels, launchComment } = config;
	let runs, issues, prs, merged, repo;
	try {
		repo = gh('repo', 'view', '--json', 'owner,name');
		runs = gh('run', 'list', '--branch', base, '--limit', '10', '--json', 'workflowName,status,conclusion,displayTitle,event');
		issues = gh('issue', 'list', '--label', labels.working, '--state', 'open', '--limit', '50', '--json', 'number,title,comments');
		const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
		merged = gh('pr', 'list', '--state', 'merged', '--search', `merged:>=${since}`, '--limit', '100', '--json', 'number,title,mergedAt');
		prs = gh('pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,headRefOid,isCrossRepository,isDraft,mergeable,mergeStateStatus,statusCheckRollup,closingIssuesReferences,files');
	} catch (e) {
		throw new Error(`Couldn't read GitHub (is gh logged in? try: gh auth status): ${why(e)}`);
	}

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

	for (const pr of prs) {
		const rollup = pr.statusCheckRollup || [];
		const checks = rollup.filter((c) => c.__typename === 'CheckRun');
		const failed = [
			...checks.filter((c) => c.status === 'COMPLETED' && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion)).map((c) => c.name),
			...rollup.filter((c) => c.__typename === 'StatusContext' && ['FAILURE', 'ERROR'].includes(c.state)).map((c) => c.context),
		];
		const running = checks.filter((c) => c.status !== 'COMPLETED').map((c) => c.name);
		const queued = checks.filter((c) => c.status === 'QUEUED').map((c) => c.name);
		const head = approvedHead(pr);
		const prior = head ? null : approvedBefore.get(pr.number);
		// Always name the approved commit: after the rebase that's usually needed first, the head is a new commit.
		const approvedSha = head ? pr.headRefOid : prior?.sha ?? '';
		// A clean rebase of an approved commit reuses that commit's checks; an approved head needs its own.
		// foreman merge re-checks all of this and refuses if the push after approval was more than a rebase.
		const ready = Boolean(approvedSha) && !failed.length && !pr.isDraft && pr.mergeable !== 'CONFLICTING' && Boolean(prior ? prior.green : checks.length && !running.length);
		pr.foreman = {
			closes: (pr.closingIssuesReferences || []).map((i) => i.number),
			failed, running, queued, checks: checks.length,
			approvedAtHead: head, approvedBefore: prior?.sha ?? '', approvedSha, ready,
			merge: approvedSha ? `npx --no-install foreman merge ${pr.number} --rebased-from ${approvedSha}` : '',
			risky: risky(pr),
		};
	}

	for (const issue of issues) {
		const launch = [...issue.comments].reverse().find((c) => c.body.startsWith(launchComment));
		issue.launch = launch ?? null;
		issue.branch = launch?.body.match(/branch `([^`]+)`/)?.[1] ?? '';
		issue.port = launch?.body.match(/\bport (\d+)\b/)?.[1] ?? '';
	}

	const day = Date.now() - 24 * 3600 * 1000;
	merged = merged.filter((p) => Date.parse(p.mergedAt) > day).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
	// The newest run of each workflow, newest first.
	const latest = [...new Map([...runs].reverse().map((r) => [r.workflowName, r])).values()].reverse();
	return { repo, runs: latest, issues, prs, merged, rebaseLookupFailed };
}

/** The base branch's CI is red: the latest push run of some workflow failed (scheduled jobs don't count). */
export const baseFailing = (crew) => crew.runs.filter((r) => r.event === 'push' && r.status === 'completed' && !['success', 'skipped', 'neutral'].includes(r.conclusion));

/**
 * Work that's under way and would stop if every agent stopped: issues a Builder claimed, and approved PRs.
 * `key` changes whenever any of it moves (a new push, a new claim, a merge).
 */
export function inFlight(crew) {
	const items = [
		...crew.issues.map((i) => `#${i.number}`),
		...crew.prs.filter((p) => p.foreman.approvedSha || p.foreman.closes.some((n) => crew.issues.some((i) => i.number === n))).map((p) => `PR #${p.number}@${p.headRefOid.slice(0, 7)}`),
	];
	return { items, key: [...new Set(items)].sort().join(' ') };
}
