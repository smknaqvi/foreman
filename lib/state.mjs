/**
 * Where the crew stands, read from GitHub alone (no Coordinator memory needed): the base branch's CI, the
 * issues Builders are on (the working label plus the launch comment `foreman claim` wrote), each open PR's
 * checks and approval (including one from before a rebase), and PRs merged recently. `foreman status`
 * prints it; `foreman tick` and the watchdog act on it.
 */
import { gh, why } from './sh.mjs';

export async function readCrew(config) {
	const { baseBranch: base, approvalContext: context, labels, launchComment } = config;
	let runs, workflows, issues, prs, merged, repo;
	try {
		repo = gh('repo', 'view', '--json', 'owner,name');
		runs = readRuns(base);
		workflows = readWorkflows();
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
	let approvedBefore = new Map();
	let rebaseLookupFailed = '';
	const unapproved = prs.filter((p) => !approvedHead(p));
	try {
		approvedBefore = approvalsBeforeRebase(config, repo, unapproved.map((p) => p.number));
	} catch (e) {
		rebaseLookupFailed = why(e);
	}

	for (const pr of prs) {
		const rollup = pr.statusCheckRollup || [];
		const checks = rollup.filter((c) => c.__typename === 'CheckRun');
		// The same rule auto-approve uses (commitGreen): the newest run of each check, every status.
		const green = commitGreen(config, rollupChecks(rollup));
		const { failed, pending: running } = green;
		const queued = checks.filter((c) => c.status === 'QUEUED').map((c) => c.name);
		const head = approvedHead(pr);
		const prior = head ? null : approvedBefore.get(pr.number);
		// Always name the approved commit: after the rebase that's usually needed first, the head is a new commit.
		const approvedSha = head ? pr.headRefOid : prior?.sha ?? '';
		// A clean rebase of an approved commit reuses that commit's checks; an approved head needs its own.
		// foreman merge re-checks all of this and refuses if the push after approval was more than a rebase.
		const ready = Boolean(approvedSha) && !pr.isDraft && pr.mergeable !== 'CONFLICTING' && (prior ? prior.green && !failed.length : !green.problem);
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
	const holding = baseWorkflows(config, workflows);
	return { repo, runs: latest(runs), baseWorkflows: holding, baseRuns: baseRuns(config, runs, holding), issues, prs, merged, rebaseLookupFailed };
}

/** Conclusions that count as passing, for check runs and workflow runs alike. */
export const PASSING = ['success', 'skipped', 'neutral'];

/** The base branch's recent workflow runs, newest first (`gh run list`). */
export const readRuns = (base) => gh('run', 'list', '--branch', base, '--limit', '30', '--json', 'workflowName,status,conclusion,displayTitle,event,databaseId,url');

/** The newest run of each workflow, newest first (from runs listed newest first). */
export const latest = (list) => [...new Map([...list].reverse().map((r) => [r.workflowName, r])).values()].reverse();

/** The repo's workflows ([{ name, path }]), or null if they can't be read. */
export function readWorkflows() {
	try { return gh('workflow', 'list', '--json', 'name,path'); } catch { return null; }
}

/**
 * Which workflows hold merges back, from the repo's workflow list: `baseWorkflows` if the config lists them,
 * otherwise the workflow named like requiredCheck, ignoring case ("Verify" for verify). If none is (or the list
 * can't be read), every workflow's push runs: { all: true }. `why` says which, for printing.
 */
export function baseWorkflows(config, workflows) {
	if (config.baseWorkflows?.length) return { names: config.baseWorkflows, all: false, why: `${config.baseWorkflows.join(', ')} (baseWorkflows)` };
	const want = (config.requiredCheck ?? '').toLowerCase();
	const names = want ? (workflows ?? []).map((w) => w.name).filter((n) => n.toLowerCase() === want) : [];
	if (names.length) return { names, all: false, why: `${names.join(', ')} (the workflow named like ${config.requiredCheck})` };
	return { names: [], all: true, why: `every workflow's push runs (none is named like ${config.requiredCheck || 'requiredCheck'}; set baseWorkflows to choose)` };
}

/**
 * The runs that say whether the base branch is red: the newest run of each base workflow (baseWorkflows) started
 * by a push or by hand (workflow_dispatch, as after a merge made with a CI token, which starts no push runs).
 * Other workflows (a deploy, a scheduled job) don't count. When no workflow is known to make requiredCheck, the
 * newest push run of every workflow counts instead. `crew.baseRuns` holds these; tick, auto-approve, observe and
 * notify all go by them, so what holds merges back is what gets reported.
 */
export function baseRuns(config, runs, holding = baseWorkflows(config, readWorkflows())) {
	if (holding.all) return latest(runs.filter((r) => r.event === 'push'));
	return latest(runs.filter((r) => holding.names.includes(r.workflowName) && (r.event === 'push' || r.event === 'workflow_dispatch')));
}

/** Of those runs (baseRuns), the ones that failed: the base branch's CI is red if there are any. */
export const baseFailing = (runs) => runs.filter((r) => r.status === 'completed' && !PASSING.includes(r.conclusion));

/**
 * Is this commit green? The one rule tick (through readCrew) and auto-approve both use: the newest run of each
 * check (by `key`, its workflow, or app, and name; a check with any run not finished is pending) and every commit status but the
 * approval must have passed, and requiredCheck, if set, must be among them. `foreman merge` (scripts/merge.sh)
 * then checks again at merge time, under its lock: requiredCheck by name on the commit, and `gh pr checks` for
 * everything else on the PR's head. Input, lowercase: { checks: [{ key, name, status, conclusion, order }],
 * statuses: [{ context, state }] }. Returns { problem: '' or why not, approved, none: no checks at all, failed,
 * pending (names) }.
 */
export function commitGreen(config, { checks, statuses }, sha = '') {
	const byKey = new Map();
	for (const c of checks) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
	// A check with any run not finished (a queued re-run has no start time to order by) is pending; otherwise its
	// newest run counts.
	const runs = [...byKey.values()].map((list) => list.find((c) => c.status !== 'completed') ?? list.reduce((a, b) => (b.order > a.order ? b : a)));
	const others = statuses.filter((s) => s.context !== config.approvalContext);
	const approved = statuses.some((s) => s.context === config.approvalContext && s.state === 'success');
	const failed = [...runs.filter((r) => r.status === 'completed' && !PASSING.includes(r.conclusion)).map((r) => r.name), ...others.filter((s) => ['failure', 'error'].includes(s.state)).map((s) => s.context)];
	const pending = [...runs.filter((r) => r.status !== 'completed').map((r) => r.name), ...others.filter((s) => s.state === 'pending').map((s) => s.context)];
	const at = sha ? ` on ${sha.slice(0, 7)}` : '';
	const none = !runs.length && !others.length;
	let problem = '';
	if (failed.length) problem = `checks failed${at}: ${failed.join(', ')}`;
	else if (pending.length) problem = `checks are still running${at}: ${pending.join(', ')}`;
	else if (config.requiredCheck && !runs.some((r) => r.name === config.requiredCheck && r.conclusion === 'success')) problem = `${config.requiredCheck} hasn't passed${at} yet`;
	else if (none) problem = `no checks have run${at}`;
	return { problem, approved, none, failed, pending };
}

/** A PR's statusCheckRollup (GraphQL, from gh pr list) in commitGreen's shape. */
export function rollupChecks(rollup) {
	const low = (x) => (x ?? '').toLowerCase();
	return {
		checks: rollup.filter((c) => c.__typename === 'CheckRun').map((c, i) => ({ key: `${c.workflowName ?? ''}/${c.name}`, name: c.name, status: low(c.status), conclusion: low(c.conclusion), order: Date.parse(c.startedAt ?? '') || i })),
		statuses: rollup.filter((c) => c.__typename === 'StatusContext').map((c) => ({ context: c.context, state: low(c.state) })),
	};
}

/**
 * commitGreen for one commit, read from the REST API. A check run is keyed like the rollup's, by its workflow (the
 * workflow run of its check suite) and name, so same-named jobs in two workflows stay apart; a check from another
 * app, by the app and name. Newest by id.
 */
export function readCommitGreen(config, repo, sha) {
	const cr = gh('api', '-X', 'GET', `repos/${repo}/commits/${sha}/check-runs`, '-f', 'per_page=100');
	const st = gh('api', '-X', 'GET', `repos/${repo}/commits/${sha}/status`, '-f', 'per_page=100');
	if ((cr.total_count ?? 0) > (cr.check_runs ?? []).length) return { problem: `it has more checks on ${sha.slice(0, 7)} than one page shows`, approved: false, none: false, failed: [], pending: [] };
	const wr = gh('api', '-X', 'GET', `repos/${repo}/actions/runs`, '-f', `head_sha=${sha}`, '-f', 'per_page=100');
	const workflowOf = new Map((wr.workflow_runs ?? []).map((w) => [w.check_suite_id, w.name]));
	const keyOf = (r) => (workflowOf.has(r.check_suite?.id) ? `${workflowOf.get(r.check_suite.id)}/${r.name}` : `app:${r.app?.slug ?? r.app?.id ?? ''}/${r.name}`);
	const checks = (cr.check_runs ?? []).map((r) => ({ key: keyOf(r), name: r.name, status: r.status, conclusion: r.conclusion ?? '', order: r.id }));
	return commitGreen(config, { checks, statuses: (st.statuses ?? []).map((x) => ({ context: x.context, state: x.state })) }, sha);
}

/**
 * Approvals on the commits PRs had before a force-push (a rebase), in one GraphQL query: Map of PR number to
 * { sha, green, description } for the newest approved one. `repo`: { owner: { login }, name }.
 */
export function approvalsBeforeRebase(config, repo, numbers) {
	const found = new Map();
	if (!numbers.length) return found;
	const pr = (n) => `p${n}:pullRequest(number:${n}){timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],last:20){nodes{...on HeadRefForcePushedEvent{beforeCommit{oid statusCheckRollup{state} status{contexts{context state description}}}}}}}`;
	const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${numbers.map(pr).join(' ')}}}`;
	const data = gh('api', 'graphql', '-f', `query=${query}`, '-f', `owner=${repo.owner.login}`, '-f', `name=${repo.name}`).data.repository;
	for (const n of numbers) {
		const nodes = [...data[`p${n}`].timelineItems.nodes].reverse();
		const approval = (node) => node.beforeCommit?.status?.contexts.find((c) => c.context === config.approvalContext && c.state === 'SUCCESS');
		const hit = nodes.find(approval);
		if (hit) found.set(n, { sha: hit.beforeCommit.oid, green: hit.beforeCommit.statusCheckRollup?.state === 'SUCCESS', description: approval(hit).description ?? '' });
	}
	return found;
}

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
