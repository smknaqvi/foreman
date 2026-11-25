/**
 * `foreman stats`: how the crew is doing, counted from GitHub's history alone (no AI, nothing written). For each
 * PR merged into the base branch in a window: its review rounds, pushes, the time from claim to merge, runs of
 * the required check (failures and flakes), and whether the base stayed green after it merged. Then a summary
 * and what's worth a look. Run it before and after changing a playbook to see whether the change helped.
 *   foreman stats [--since <date|Nd>] [--until <date|Nd>] [--json] [--pr <N>]
 * The README's "Stats" section defines every number; the definitions below follow it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const DAY = 24 * 3600e3;
// scripts/merge.sh's description for an approval it copied onto a clean rebase: a rebase, not a review round.
const CARRIED = 'Approval carried over';
// Conclusions that count as a failed run. Cancelled isn't one: that's usually a run a newer push replaced.
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);
const OPEN_TOO_LONG = 7 * DAY;
const CLAIM_TOO_LONG = 2 * DAY;
// "Worth a look" thresholds.
const MANY_ROUNDS = 3;
const MANY_FAILURES = 3;

// ---------------------------------------------------------------------------------------------------------
// The window

/**
 * --since and --until as times: a date (YYYY-MM-DD, UTC; --until means the end of that day), a full ISO time,
 * or a number of days back from now (30d). The default window is the last 30 days.
 */
export function parseWindow({ since, until } = {}, now = Date.now()) {
	const end = until ? parseTime(until, 'until', now) : now;
	const start = parseTime(since ?? '30d', 'since', now);
	if (start >= end) throw new Error(`--since (${iso(start)}) must be before --until (${iso(end)})`);
	return { since: start, until: end };
}

function parseTime(text, flag, now) {
	const days = /^(\d+)d$/.exec(text);
	if (days) return now - Number(days[1]) * DAY;
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
		const t = Date.parse(`${text}T00:00:00Z`);
		if (!Number.isNaN(t) && new Date(t).toISOString().startsWith(text)) return flag === 'until' ? t + DAY - 1000 : t;
	} else if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text))) {
		return Date.parse(text);
	}
	throw new Error(`--${flag} ${text} isn't a date (YYYY-MM-DD) or a number of days (30d)`);
}

// GitHub's search wants seconds, not milliseconds.
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------------------------------------------------
// Reading GitHub

const run = promisify(execFile);

/** gh, asynchronously (so the dashboard keeps serving while it counts), each distinct call made once per run. */
function cachedGh() {
	const cache = new Map();
	return (args) => {
		const key = args.join('\0');
		if (!cache.has(key)) cache.set(key, run('gh', args, { maxBuffer: 512 * 1024 * 1024 }).then(({ stdout }) => JSON.parse(stdout)));
		return cache.get(key);
	};
}

// GitHub charges a query by how many lists it could have to read (the `first:` of every nested list
// multiplied out), not by what comes back. So PRs are read in two steps: their timelines with commit ids only
// (cheap), then each distinct commit once, by id, with its approvals and check runs.

// Commits that were the PR's head: every commit still in it, and both sides of every force-push (a rebase or an
// amend), which is the only trace GitHub keeps of commits a force-push replaced.
const TIMELINE = 'PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,LABELED_EVENT';
const timelineFragment = `fragment T on PullRequestTimelineItems{__typename
 ...on PullRequestCommit{commit{oid committedDate}}
 ...on HeadRefForcePushedEvent{createdAt beforeCommit{oid committedDate} afterCommit{oid committedDate}}
 ...on LabeledEvent{createdAt label{name}}}`;

// The issue's claim (the working label, or foreman claim's comment) and any label for people.
const prFragment = `fragment P on PullRequest{number title url state isDraft createdAt mergedAt baseRefName headRefOid author{login} mergedBy{login}
 mergeCommit{oid committedDate parents(first:1){nodes{oid committedDate}}}
 commits(last:1){nodes{commit{oid committedDate}}}
 closingIssuesReferences(first:5){nodes{number title timelineItems(first:100,itemTypes:[LABELED_EVENT,ISSUE_COMMENT]){nodes{__typename
  ...on LabeledEvent{createdAt label{name}} ...on IssueComment{createdAt body}}}}}
 timelineItems(first:100,itemTypes:[${TIMELINE}]){pageInfo{hasNextPage endCursor} nodes{...T}}}`;

// What every commit carries: approvals (commit statuses) and runs of the required check, every attempt
// (checkType ALL: a re-run is a second check run in the same suite, which is how a flake shows).
const commitFragment = (check) => `fragment C on Commit{oid committedDate
 status{contexts{context state description createdAt creator{login}}}
 checkSuites(first:6){nodes{workflowRun{event} checkRuns(first:6,filterBy:{checkType:ALL${check ? `,checkName:${JSON.stringify(check)}` : ''}}){nodes{name status conclusion startedAt completedAt}}}}}`;

const PRS_PER_QUERY = 20;
const COMMITS_PER_QUERY = 40;
const PARALLEL = 3;

/** `fn` over `items` in chunks of `size`, a few chunks at a time; the results in order, flattened. */
async function chunked(items, size, fn) {
	const chunks = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	const out = [];
	for (let i = 0; i < chunks.length; i += PARALLEL) out.push(...(await Promise.all(chunks.slice(i, i + PARALLEL).map(fn))).flat());
	return out;
}

/** Every commit object a PR (as read above) refers to, so they can be filled in from the second step. */
function commitRefs(p) {
	const refs = [];
	for (const n of p.timelineItems?.nodes ?? []) refs.push(n.commit, n.beforeCommit, n.afterCommit);
	for (const n of p.commits?.nodes ?? []) refs.push(n.commit);
	if (p.mergeCommit) refs.push(p.mergeCommit, ...(p.mergeCommit.parents?.nodes ?? []));
	return refs.filter((c) => c?.oid);
}

/**
 * Everything the numbers come from: the merged PRs in the window (or the one PR asked for), the base branch's
 * commits in the window (reverts, commits without a PR), and what's open now. Read-only.
 */
export async function collect(config, window, { pr, gh = cachedGh() } = {}) {
	const repo = await gh(['repo', 'view', '--json', 'owner,name']);
	const owner = repo.owner.login, name = repo.name, slug = `${owner}/${name}`;
	const graphql = async (query, vars = {}) => {
		const args = ['api', 'graphql', '-f', `query=${query}`];
		for (const [k, v] of Object.entries(vars)) if (v !== null && v !== undefined) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
		return (await gh(args)).data;
	};
	const inRepo = (body) => `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${body}}}`;
	const details = async (numbers) => {
		const prs = await chunked(numbers, PRS_PER_QUERY, async (nums) => {
			const data = (await graphql(`${inRepo(nums.map((n) => `p${n}:pullRequest(number:${n}){...P}`).join(' '))} ${prFragment} ${timelineFragment}`, { owner, name })).repository;
			return nums.map((n) => data[`p${n}`]).filter(Boolean);
		});
		for (const p of prs) await moreTimeline(graphql, { owner, name }, p);
		// Step two: each distinct commit once, then filled in wherever it appears.
		const oids = [...new Set(prs.flatMap(commitRefs).map((c) => c.oid))].filter((oid) => /^[0-9a-f]{40}$/.test(oid)); // Ids go into the query text.
		const full = new Map((await chunked(oids, COMMITS_PER_QUERY, async (list) => {
			const data = (await graphql(`${inRepo(list.map((oid, i) => `c${i}:object(oid:"${oid}"){...C}`).join(' '))} ${commitFragment(config.requiredCheck)}`, { owner, name })).repository;
			return list.map((_, i) => data[`c${i}`]).filter(Boolean);
		})).map((c) => [c.oid, c]));
		for (const c of prs.flatMap(commitRefs)) Object.assign(c, full.get(c.oid));
		return prs;
	};

	if (pr) return { repo: slug, prs: await details([Number(pr)]), history: [], open: null, warnings: [] };

	const warnings = [];
	const numbers = await mergedNumbers(graphql, slug, config.baseBranch, window, warnings);
	const [prs, history, open] = await Promise.all([
		details(numbers),
		baseHistory(graphql, { owner, name }, config.baseBranch, window),
		openNow(graphql, { owner, name }, config),
	]);
	return { repo: slug, prs: prs.filter((p) => p.mergedAt && inWindow(p.mergedAt, window)), history, open, warnings };
}

const inWindow = (at, w) => Date.parse(at) >= w.since && Date.parse(at) <= w.until;

/** The numbers of the PRs merged into the base in the window, from GitHub's search (paged; it stops at 1000). */
async function mergedNumbers(graphql, slug, base, window, warnings) {
	const q = `repo:${slug} is:pr is:merged base:${base} merged:${iso(window.since)}..${iso(window.until)}`;
	const out = [];
	let after = null;
	do {
		const data = await graphql(`query($q:String!,$after:String){search(query:$q,type:ISSUE,first:100,after:$after){issueCount pageInfo{hasNextPage endCursor} nodes{...on PullRequest{number}}}}`, { q, after });
		out.push(...data.search.nodes.map((n) => n.number).filter(Boolean));
		if (data.search.issueCount > 1000 && !after) warnings.push(`GitHub's search returns at most 1000 PRs and ${data.search.issueCount} match: narrow the window with --since/--until.`);
		after = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null;
	} while (after);
	return [...new Set(out)];
}

/** The rest of a long PR timeline (more than 100 commits and force-pushes). */
async function moreTimeline(graphql, vars, p) {
	let page = p.timelineItems.pageInfo;
	while (page?.hasNextPage) {
		const query = `query($owner:String!,$name:String!,$n:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$n){timelineItems(first:100,after:$after,itemTypes:[${TIMELINE}]){pageInfo{hasNextPage endCursor} nodes{...T}}}}} ${timelineFragment}`;
		const more = (await graphql(query, { ...vars, n: p.number, after: page.endCursor })).repository.pullRequest.timelineItems;
		p.timelineItems.nodes.push(...more.nodes);
		page = more.pageInfo;
	}
}

/** The base branch's commits in the window: their first line, and the PR each came from (if any). */
async function baseHistory(graphql, vars, base, window) {
	const out = [];
	let after = null;
	do {
		const data = await graphql(`query($owner:String!,$name:String!,$ref:String!,$since:GitTimestamp!,$until:GitTimestamp!,$after:String){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{...on Commit{history(first:100,since:$since,until:$until,after:$after){pageInfo{hasNextPage endCursor} nodes{oid messageHeadline committedDate associatedPullRequests(first:1){nodes{number}}}}}}}}}`,
			{ ...vars, ref: `refs/heads/${base}`, since: iso(window.since), until: iso(window.until), after });
		const history = data.repository.ref?.target?.history;
		if (!history) break;
		out.push(...history.nodes);
		after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
	} while (after);
	return out;
}

/** Open PRs, and open issues a Builder claimed (with their claims): for "now" numbers, whatever the window. */
async function openNow(graphql, vars, config) {
	const claimItems = 'timelineItems(last:50,itemTypes:[LABELED_EVENT,ISSUE_COMMENT]){nodes{__typename ...on LabeledEvent{createdAt label{name}} ...on IssueComment{createdAt body}}}';
	const data = await graphql(`query($owner:String!,$name:String!,$working:String!){repository(owner:$owner,name:$name){
 openPrs:pullRequests(states:OPEN,first:100,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number title url createdAt isDraft baseRefName closingIssuesReferences(first:5){nodes{number}}}}
 claimed:issues(states:OPEN,labels:[$working],first:100){nodes{number title url ${claimItems}}}}}`, { ...vars, working: config.labels.working });
	return { prs: data.repository.openPrs.nodes, claimed: data.repository.claimed.nodes };
}

// ---------------------------------------------------------------------------------------------------------
// The numbers

export const median = (xs) => {
	const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
	if (!s.length) return null;
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const t = (at) => (at ? Date.parse(at) : null);
const short = (sha) => (sha ?? '').slice(0, 7);
const runsOf = (c) => (c?.checkSuites?.nodes ?? []).flatMap((s) => s.checkRuns?.nodes ?? []);
const decided = (r) => r.status === 'COMPLETED' && (r.conclusion === 'SUCCESS' || FAILED.has(r.conclusion));

/**
 * One commit's runs of the required check: the latest decided run per check name gives its result ('failed' if
 * any name's latest failed; else 'running', 'cancelled' or 'none'); a failed run followed by a passing one of the
 * same name is a flake.
 */
function checkResult(c) {
	const byName = new Map();
	for (const r of runsOf(c).filter(decided).sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))) {
		if (!byName.has(r.name)) byName.set(r.name, []);
		byName.get(r.name).push(r);
	}
	let flakes = 0;
	for (const list of byName.values()) list.forEach((r, i) => { if (FAILED.has(r.conclusion) && list.slice(i + 1).some((x) => x.conclusion === 'SUCCESS')) flakes++; });
	const latest = [...byName.values()].map((list) => list.at(-1));
	const all = runsOf(c);
	const result = latest.length ? (latest.some((r) => FAILED.has(r.conclusion)) ? 'failed' : 'passed')
		: all.some((r) => r.status !== 'COMPLETED') ? 'running'
		: all.some((r) => r.conclusion === 'CANCELLED') ? 'cancelled' // On the base: usually the next merge's run replaced it.
		: 'none';
	return { result, flakes };
}

/** Claim times on an issue: the working label being added, or the comment `foreman claim` writes. */
function claimTimes(config, issue) {
	return (issue.timelineItems?.nodes ?? [])
		.filter((n) => (n.__typename === 'LabeledEvent' ? n.label?.name === config.labels.working : n.__typename === 'IssueComment' && (n.body ?? '').startsWith(config.launchComment)))
		.map((n) => t(n.createdAt));
}

/** One PR's numbers and timeline. Works for an open PR too (no merge numbers then). */
export function analyzePr(config, p) {
	const created = t(p.createdAt), merged = t(p.mergedAt);
	const items = p.timelineItems?.nodes ?? [];
	const events = [];

	// Every commit we can see, and whether it was ever the head. `at`: when it became the head (a force-push's
	// time), or else when it was committed, which for a normal push is just before it.
	const commits = new Map();
	const see = (c, { pushedAt = null, head = false } = {}) => {
		if (!c?.oid) return;
		const was = commits.get(c.oid) ?? { c, at: t(c.committedDate), head: false };
		if (pushedAt !== null && (was.pushedAt === undefined || pushedAt < was.pushedAt)) { was.pushedAt = pushedAt; was.at = pushedAt; }
		was.head ||= head;
		commits.set(c.oid, was);
	};
	let forcePushes = 0;
	for (const n of items) {
		if (n.__typename === 'PullRequestCommit') see(n.commit);
		else if (n.__typename === 'HeadRefForcePushedEvent') {
			forcePushes++;
			see(n.beforeCommit, { head: true });
			see(n.afterCommit, { head: true, pushedAt: t(n.createdAt) });
			events.push({ at: t(n.createdAt), what: `force-pushed ${short(n.beforeCommit?.oid)} → ${short(n.afterCommit?.oid)} (a rebase or an amend)` });
		}
	}
	for (const n of p.commits?.nodes ?? []) see(n.commit, { head: true });
	// A commit CI ran for, or that was approved, was a head: CI runs for the commit a push leaves at the tip.
	for (const x of commits.values()) {
		const approval = (x.c.status?.contexts ?? []).some((s) => s.context === config.approvalContext);
		x.head ||= approval || runsOf(x.c).length > 0 || (x.c.checkSuites?.nodes ?? []).some((s) => s.workflowRun);
	}
	const heads = [...commits.values()].filter((x) => x.head);
	const pushed = heads.filter((x) => x.at !== null && x.at > created);
	for (const x of pushed) if (x.pushedAt === undefined) events.push({ at: x.at, what: `pushed ${short(x.c.oid)}` });

	// Review rounds: commits that got a fresh approval. One carried over by foreman merge is a rebase.
	const approvals = [...commits.values()].flatMap(({ c }) => (c.status?.contexts ?? [])
		.filter((s) => s.context === config.approvalContext && s.state === 'SUCCESS')
		.map((s) => ({ sha: c.oid, at: s.createdAt, by: s.creator?.login ?? '', carried: (s.description ?? '').startsWith(CARRIED) })))
		.sort((a, b) => a.at.localeCompare(b.at));
	const fresh = approvals.filter((a) => !a.carried);
	for (const a of approvals) events.push({ at: t(a.at), what: a.carried ? `approval carried over to ${short(a.sha)} (clean rebase)` : `approved at ${short(a.sha)}${a.by ? ` by ${a.by}` : ''}` });
	const firstApproval = t((fresh[0] ?? approvals[0])?.at);
	const lastApproval = t(approvals.at(-1)?.at);
	const headStatus = commits.get(p.headRefOid)?.c.status?.contexts ?? [];
	const approvedAtHead = headStatus.some((s) => s.context === config.approvalContext && s.state === 'SUCCESS');

	// Checks: every decided run of the required check on any of the PR's commits.
	let checkRuns = 0, checkFailures = 0, flakes = 0, cancelled = 0;
	const durations = [];
	for (const { c } of commits.values()) {
		for (const r of runsOf(c)) {
			if (r.status === 'COMPLETED' && r.conclusion === 'CANCELLED') cancelled++;
			if (!decided(r)) continue;
			checkRuns++;
			if (FAILED.has(r.conclusion)) checkFailures++;
			if (r.startedAt && r.completedAt) durations.push(t(r.completedAt) - t(r.startedAt));
			events.push({ at: t(r.completedAt ?? r.startedAt), what: `${r.name} ${r.conclusion === 'SUCCESS' ? 'passed' : `failed (${r.conclusion.toLowerCase()})`} on ${short(c.oid)}${r.startedAt && r.completedAt ? ` in ${duration(t(r.completedAt) - t(r.startedAt))}` : ''}` });
		}
		flakes += checkResult(c).flakes;
	}

	// The claim: the last one before the PR opened (an issue claimed again later restarts the clock), else the first.
	const issues = p.closingIssuesReferences?.nodes ?? [];
	const claims = issues.flatMap((i) => claimTimes(config, i).map((at) => ({ at, issue: i.number })));
	const before = claims.filter((x) => x.at <= created).sort((a, b) => b.at - a.at);
	const claim = before[0] ?? claims.sort((a, b) => a.at - b.at)[0] ?? null;
	if (claim) events.push({ at: claim.at, what: `#${claim.issue} claimed` });
	events.push({ at: created, what: `opened by ${p.author?.login ?? 'someone'}` });

	// Labels for people, on the PR or its issue.
	const people = new Set();
	for (const n of [...items, ...issues.flatMap((i) => i.timelineItems?.nodes ?? [])]) {
		if (n.__typename === 'LabeledEvent' && [config.labels.needsInput, config.labels.decision].includes(n.label?.name)) {
			if (!people.has(n.label.name)) events.push({ at: t(n.createdAt), what: `labeled "${n.label.name}"` });
			people.add(n.label.name);
		}
	}

	// After the merge: the required check on the merge commit, and on the commit before it.
	let afterMerge = null;
	if (merged) {
		events.push({ at: merged, what: `merged${p.mergedBy?.login ? ` by ${p.mergedBy.login}` : ''}${approvedAtHead ? '' : ' (no approval on its last commit)'}` });
		const m = p.mergeCommit;
		if (m) {
			const after = checkResult(m), parent = m.parents?.nodes?.[0];
			const beforeResult = parent ? checkResult(parent).result : 'none';
			afterMerge = { sha: m.oid, result: after.result, flaky: after.flakes > 0, before: beforeResult, turnedRed: after.result === 'failed' && beforeResult !== 'failed' };
			for (const r of runsOf(m).filter(decided)) events.push({ at: t(r.completedAt ?? r.startedAt), what: `${config.baseBranch}: ${r.name} ${r.conclusion === 'SUCCESS' ? 'passed' : 'FAILED'} on the merge commit ${short(m.oid)}` });
		}
	}

	const span = (a, b) => (a !== null && b !== null && b >= a ? b - a : null);
	const out = {
		number: p.number, title: p.title, url: p.url, author: p.author?.login ?? '', state: p.state,
		createdAt: p.createdAt, mergedAt: p.mergedAt ?? null, mergedBy: p.mergedBy?.login ?? '',
		closes: issues.map((i) => i.number),
		claimedAt: claim ? iso(claim.at) : null,
		firstApprovalAt: firstApproval ? iso(firstApproval) : null,
		rounds: fresh.length,
		carriedOver: approvals.length - fresh.length,
		pushes: pushed.length,
		forcePushes,
		heads: heads.length,
		approvals,
		approvedAtMergedHead: merged ? approvedAtHead : null,
		times: {
			claimToOpenMs: span(claim?.at ?? null, created),
			openToApprovalMs: span(created, firstApproval),
			approvalToMergeMs: span(firstApproval, merged),
			lastApprovalToMergeMs: span(lastApproval, merged),
			openToMergeMs: span(created, merged),
			claimToMergeMs: span(claim?.at ?? null, merged),
		},
		checks: { runs: checkRuns, failed: checkFailures, flakes, cancelled, medianMs: median(durations), durationsMs: durations },
		afterMerge,
		people: [...people],
		revertedBy: null,
		events: events.filter((e) => e.at !== null).sort((a, b) => a.at - b.at).map((e) => ({ at: iso(e.at), what: e.what })),
	};
	return out;
}

/** 'Revert "Fix the header (#12)" (#14)' → 12. */
export function revertedPr(headline) {
	const inner = /^Revert "(.*)"/.exec(headline)?.[1] ?? '';
	const m = /\(#(\d+)\)\s*$/.exec(inner);
	return m ? Number(m[1]) : null;
}

/** The whole picture from what `collect` read. */
export function analyze(config, data, window, now = Date.now()) {
	const prs = data.prs.map((p) => analyzePr(config, p)).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
	const history = data.history ?? [];
	const reverts = history.filter((c) => /^Revert\b/.test(c.messageHeadline)).map((c) => ({
		sha: c.oid, title: c.messageHeadline, at: c.committedDate, pr: c.associatedPullRequests?.nodes?.[0]?.number ?? null, reverts: revertedPr(c.messageHeadline),
	}));
	for (const r of reverts) {
		const target = prs.find((p) => p.number === r.reverts);
		if (target) target.revertedBy = r.pr ? `#${r.pr}` : short(r.sha);
	}
	const direct = history.filter((c) => !c.associatedPullRequests?.nodes?.length).map((c) => ({ sha: c.oid, title: c.messageHeadline, at: c.committedDate }));

	// Now, whatever the window.
	const open = data.open ?? { prs: [], claimed: [] };
	const openOld = open.prs.filter((p) => p.baseRefName === config.baseBranch && now - t(p.createdAt) > OPEN_TOO_LONG)
		.map((p) => ({ number: p.number, title: p.title, url: p.url, createdAt: p.createdAt, draft: p.isDraft }));
	const withPr = new Set(open.prs.flatMap((p) => (p.closingIssuesReferences?.nodes ?? []).map((i) => i.number)));
	const claimedNoPr = open.claimed.map((i) => ({ i, at: Math.max(...claimTimes(config, i), -Infinity) }))
		.filter(({ i, at }) => !withPr.has(i.number) && Number.isFinite(at) && now - at > CLAIM_TOO_LONG)
		.map(({ i, at }) => ({ number: i.number, title: i.title, url: i.url, claimedAt: iso(at) }));

	const all = (f) => prs.map(f);
	const sum = (f) => prs.reduce((n, p) => n + f(p), 0);
	const checkRuns = sum((p) => p.checks.runs), flakes = sum((p) => p.checks.flakes);
	const red = prs.filter((p) => p.afterMerge?.turnedRed);
	const summary = {
		merged: prs.length,
		medianRounds: median(all((p) => p.rounds)),
		medianPushes: median(all((p) => p.pushes)),
		medianOpenToMergeMs: median(all((p) => p.times.openToMergeMs)),
		medianClaimToMergeMs: median(all((p) => p.times.claimToMergeMs)),
		medianClaimToOpenMs: median(all((p) => p.times.claimToOpenMs)),
		medianOpenToApprovalMs: median(all((p) => p.times.openToApprovalMs)),
		medianApprovalToMergeMs: median(all((p) => p.times.approvalToMergeMs)),
		slowest: [...prs].filter((p) => p.times.openToMergeMs !== null).sort((a, b) => b.times.openToMergeMs - a.times.openToMergeMs).slice(0, 3).map((p) => ({ number: p.number, openToMergeMs: p.times.openToMergeMs })),
		carriedOver: sum((p) => p.carriedOver),
		checkRuns,
		checkFailures: sum((p) => p.checks.failed),
		flakes,
		flakeRate: checkRuns ? flakes / checkRuns : null,
		medianCheckMs: median(prs.flatMap((p) => p.checks.durationsMs)),
		turnedMainRed: red.map((p) => p.number),
		redAfterMerge: prs.filter((p) => p.afterMerge?.result === 'failed').map((p) => p.number),
		noMainCheck: prs.filter((p) => !p.afterMerge || ['none', 'cancelled'].includes(p.afterMerge.result)).map((p) => p.number),
		reverts: reverts.length,
		waitedOnPeople: prs.filter((p) => p.people.length).map((p) => p.number),
		mergedWithoutApproval: prs.filter((p) => p.approvedAtMergedHead === false).map((p) => p.number),
		withoutPr: direct.length,
		openOlderThan7Days: openOld,
		claimedWithoutPr: claimedNoPr,
	};
	return {
		repo: data.repo, base: config.baseBranch, requiredCheck: config.requiredCheck, approvalContext: config.approvalContext,
		window: { since: iso(window.since), until: iso(window.until) }, generatedAt: iso(now),
		summary, prs, reverts, withoutPr: direct, worthALook: worthALook(config, prs, direct), warnings: data.warnings ?? [],
	};
}

function worthALook(config, prs, direct) {
	const out = [];
	// Most serious kind first; newest PR first within a kind. `foreman stats` prints flakes and failures one line each.
	const add = (kind, pr, text) => out.push({ kind, pr, text });
	for (const p of prs) {
		if (p.afterMerge?.turnedRed) add('red', p.number, `turned ${config.baseBranch} red: ${config.requiredCheck || 'its checks'} failed on the merge commit ${short(p.afterMerge.sha)}${p.afterMerge.flaky ? ' (then passed on a re-run: maybe a flake)' : ''}`);
		if (p.revertedBy) add('reverted', p.number, `was reverted (${p.revertedBy})`);
		if (p.approvedAtMergedHead === false) add('unapproved', p.number, 'merged without an approval on its last commit: it didn\'t go through foreman merge');
		if (p.rounds >= MANY_ROUNDS) add('rounds', p.number, `took ${p.rounds} review rounds: the change probably kept growing (consider splitting or simplifying such work)`);
		if (p.checks.flakes) add('flakes', p.number, `${plural(p.checks.flakes, 'flake')}: ${config.requiredCheck || 'a check'} failed, then passed on the same commit with no new push`);
		if (p.checks.failed - p.checks.flakes >= MANY_FAILURES) add('failures', p.number, `${p.checks.failed - p.checks.flakes} check runs failed (not counting flakes): pushed before the checks passed locally, or work on the checks themselves?`);
	}
	if (direct.length) add('without-pr', null, `${plural(direct.length, 'commit')} reached ${config.baseBranch} without a PR: ${direct.slice(0, 3).map((c) => `${short(c.sha)} "${c.title.slice(0, 50)}"`).join(', ')}${direct.length > 3 ? '…' : ''}`);
	return out.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || (b.pr ?? 0) - (a.pr ?? 0));
}
const KINDS = ['red', 'reverted', 'unapproved', 'without-pr', 'rounds', 'flakes', 'failures'];
const GROUPED = {
	flakes: (r) => `${r.requiredCheck || 'a check'} failed, then passed on the same commit with no new push: a flaky check or test`,
	failures: () => `${MANY_FAILURES} or more failed check runs (not counting flakes): pushed before the checks passed locally, or work on the checks themselves?`,
};

// ---------------------------------------------------------------------------------------------------------
// Output

export function duration(ms) {
	if (ms === null || ms === undefined) return '–';
	const min = ms / 60000;
	if (min < 1) return `${Math.round(ms / 1000)} s`;
	if (min < 60) return `${Math.round(min)} min`;
	if (min < 48 * 60) return `${(min / 60).toFixed(1)} h`;
	return `${(min / 1440).toFixed(1)} d`;
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const nums = (list, max = 6) => list.slice(0, max).map((n) => `#${typeof n === 'object' ? n.number : n}`).join(', ') + (list.length > max ? ', …' : '');
const day = (at) => at.slice(0, 16).replace('T', ' ');
const num = (x) => (x === null ? '–' : Number.isInteger(x) ? String(x) : x.toFixed(1));

/** The short plain summary: the numbers someone reads first. */
export function summaryLines(r) {
	const s = r.summary;
	const check = r.requiredCheck ? `"${r.requiredCheck}"` : 'every check';
	const lines = [];
	if (!s.merged) lines.push(`No PRs merged into ${r.base} in this window.`);
	else {
		lines.push(`${plural(s.merged, 'PR')} merged. The typical one (median): ${plural(s.medianRounds, 'review round')}, ${plural(s.medianPushes, 'push', 'pushes')} after it opened, ${duration(s.medianOpenToMergeMs)} from opened to merged${s.medianClaimToMergeMs !== null ? ` (${duration(s.medianClaimToMergeMs)} from claim)` : ''}.`);
		lines.push(`Time: claim → opened ${duration(s.medianClaimToOpenMs)}, opened → first approval ${duration(s.medianOpenToApprovalMs)}, first approval → merged ${duration(s.medianApprovalToMergeMs)} (medians).${s.carriedOver ? ` ${plural(s.carriedOver, 'approval')} carried over a clean rebase (not counted as rounds).` : ''}`);
		lines.push(s.checkRuns
			? `Checks (${check}): ${plural(s.checkRuns, 'run')}, ${s.checkFailures} failed; ${plural(s.flakes, 'flake')} (failed, then passed on the same commit: ${(100 * s.flakeRate).toFixed(1)}% of runs). A run takes ${duration(s.medianCheckMs)}.`
			: `Checks (${check}): no runs found on these PRs.`);
		const after = s.turnedMainRed.length ? `${plural(s.turnedMainRed.length, 'merge')} turned ${r.base} red (${nums(s.turnedMainRed)})` : `No merge turned ${r.base} red`;
		lines.push(`${after}${s.redAfterMerge.length > s.turnedMainRed.length ? `; ${s.redAfterMerge.length - s.turnedMainRed.length} more landed on an already red ${r.base}` : ''}. ${s.reverts ? `${plural(s.reverts, 'revert')}.` : 'No reverts.'}${s.noMainCheck.length ? ` (${plural(s.noMainCheck.length, 'merge')} had no finished ${check} run on ${r.base}: usually cancelled when the next merge landed, so not counted either way.)` : ''}`);
		if (s.waitedOnPeople.length) lines.push(`${plural(s.waitedOnPeople.length, 'PR')} waited on people at some point (${nums(s.waitedOnPeople)}).`);
		lines.push(s.mergedWithoutApproval.length
			? `${plural(s.mergedWithoutApproval.length, 'PR')} merged without an approval on the last commit, so not through foreman merge (${nums(s.mergedWithoutApproval)}).`
			: 'Every merge had an approval on its last commit.');
	}
	const now = [];
	if (s.openOlderThan7Days.length) now.push(`${plural(s.openOlderThan7Days.length, 'open PR')} older than 7 days (${nums(s.openOlderThan7Days)})`);
	if (s.claimedWithoutPr.length) now.push(`${plural(s.claimedWithoutPr.length, 'claimed issue')} with no PR for over 2 days (${nums(s.claimedWithoutPr)})`);
	lines.push(now.length ? `Now: ${now.join('; ')}.` : 'Now: no open PR older than 7 days, no claimed issue without a PR for over 2 days.');
	return lines;
}

export function render(r) {
	const out = [`${r.repo} · ${r.base} · PRs merged ${day(r.window.since)} to ${day(r.window.until)} UTC`, ''];
	for (const w of r.warnings) out.push(`(${w})`);
	out.push(...summaryLines(r));
	if (r.prs.length) {
		const rows = [['PR', 'Title', 'Rounds', 'Pushes', 'To merge', 'Failed', 'Notes']];
		for (const p of [...r.prs].reverse()) {
			const notes = [
				p.afterMerge?.turnedRed && `turned ${r.base} red`,
				p.revertedBy && `reverted by ${p.revertedBy}`,
				p.approvedAtMergedHead === false && 'no approval at merge',
				p.checks.flakes && plural(p.checks.flakes, 'flake'),
				p.carriedOver && `${p.carriedOver} carried over`,
				p.people.length && p.people.join(', '),
			].filter(Boolean).join('; ');
			rows.push([`#${p.number}`, p.title.length > 40 ? `${p.title.slice(0, 39)}…` : p.title, String(p.rounds), String(p.pushes), duration(p.times.openToMergeMs), String(p.checks.failed), notes]);
		}
		const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
		out.push('');
		for (const row of rows) out.push(`  ${row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ')}`.trimEnd());
		if (r.summary.slowest.length) out.push('', `Slowest from opened to merged: ${r.summary.slowest.map((x) => `#${x.number} ${duration(x.openToMergeMs)}`).join(', ')}`);
	}
	if (r.worthALook.length) {
		out.push('', 'Worth a look');
		for (const w of r.worthALook.filter((x) => !GROUPED[x.kind])) out.push(`  ${w.pr ? `#${w.pr} ` : ''}${w.text}`);
		for (const [kind, why] of Object.entries(GROUPED)) {
			const list = r.worthALook.filter((x) => x.kind === kind).map((x) => r.prs.find((p) => p.number === x.pr));
			const count = (p) => (kind === 'flakes' ? p.checks.flakes : p.checks.failed - p.checks.flakes);
			if (list.length) out.push(`  ${list.map((p) => `#${p.number}${count(p) > 1 ? ` (${count(p)})` : ''}`).join(', ')}: ${why(r)}`);
		}
	}
	return out.join('\n');
}

export function renderPr(p, config) {
	const out = [`#${p.number} ${p.title} (${p.mergedAt ? 'merged' : p.state.toLowerCase()})`, `  ${p.url}`, ''];
	for (const e of p.events) out.push(`  ${day(e.at)}  ${e.what}`);
	out.push('', `Review rounds ${p.rounds}${p.carriedOver ? ` (+${p.carriedOver} carried over a rebase)` : ''} · ${plural(p.pushes, 'push', 'pushes')} after opening (${plural(p.forcePushes, 'force-push', 'force-pushes')}) · ${config.requiredCheck || 'checks'}: ${plural(p.checks.runs, 'run')}, ${p.checks.failed} failed, ${plural(p.checks.flakes, 'flake')}`);
	const tm = p.times;
	out.push(`Claim → opened ${duration(tm.claimToOpenMs)} · opened → first approval ${duration(tm.openToApprovalMs)} · first approval → merged ${duration(tm.approvalToMergeMs)} · opened → merged ${duration(tm.openToMergeMs)}`);
	if (p.afterMerge) out.push(`${config.baseBranch} after the merge: ${p.afterMerge.result === 'none' ? `no ${config.requiredCheck || 'check'} run` : p.afterMerge.result}${p.afterMerge.turnedRed ? ' (turned it red)' : p.afterMerge.result === 'failed' ? ' (it was already red)' : ''}`);
	return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// Commands

export async function stats(config, { since, until, json = false, pr } = {}, { gh } = {}) {
	if (pr !== undefined && !/^\d+$/.test(String(pr))) throw new Error('--pr takes a PR number');
	const window = parseWindow({ since, until });
	let data;
	try {
		data = await collect(config, window, { pr, gh });
	} catch (e) {
		const text = String(e.stderr || e.message).trim().split('\n')[0];
		throw new Error(`Couldn't read GitHub: ${text}${/auth|log ?in|token|401/i.test(text) ? ' (try: gh auth status)' : ''}`);
	}
	if (pr) {
		const p = data.prs[0];
		if (!p) throw new Error(`no PR #${pr}`);
		const one = analyzePr(config, p);
		console.log(json ? JSON.stringify(one, null, 2) : renderPr(one, config));
		return 0;
	}
	const result = analyze(config, data, window);
	console.log(json ? JSON.stringify(result, null, 2) : render(result));
	return 0;
}

/** The last `days` days' summary, for the dashboard. */
export async function recentSummary(config, { days = 30, gh } = {}) {
	const window = parseWindow({ since: `${days}d` });
	return { days, ...analyze(config, await collect(config, window, { gh }), window).summary };
}
