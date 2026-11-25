/**
 * `foreman stats` against a fake GitHub (test/fake-gh.mjs): review rounds (a carried-over approval isn't one),
 * flakes, merges that turned the base red, time medians, the window, --json and --pr.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { median, parseWindow, revertedPr, summaryRows } from '../lib/stats.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };

const bin = temp('foreman-bin-');
copyFileSync(join(ROOT, 'test/fake-gh.mjs'), join(bin, 'gh'));
chmodSync(join(bin, 'gh'), 0o755);

// Times as hours from a start ten days ago, so "now" numbers (open PRs, claims) hold whenever the test runs.
const START = Math.floor((Date.now() - 10 * 24 * 3600e3) / 3600e3) * 3600e3;
const at = (h) => new Date(Math.round(START + h * 3600e3)).toISOString();
const HOUR = 3600e3;
const hours = (x) => Math.round(x * HOUR);
const sha = (x) => x.repeat(40).slice(0, 40); // 'a1' → a full, hex commit id.

const run = (conclusion, start, minutes = 10) => ({ name: 'verify', status: 'COMPLETED', conclusion, startedAt: at(start), completedAt: at(start + minutes / 60) });
const approval = (h, carried = false) => ({ context: 'coordinator-review', state: 'SUCCESS', description: carried ? 'Approval carried over: clean rebase of 1111111' : 'Approved after review', createdAt: at(h), creator: { login: 'coord' } });
// suites: [[event, runs]]; `runs` alone is one pull_request suite. Every commit also has an app's empty suite.
const commit = (id, committed, { runs = [], suites = runs.length ? [['pull_request', runs]] : [], statuses = [] } = {}) => ({
	oid: sha(id), committedDate: at(committed), status: statuses.length ? { contexts: statuses } : null,
	checkSuites: { nodes: [{ id: `${id}-app`, workflowRun: null, checkRuns: { nodes: [] } }, ...suites.map(([event, list], i) => ({ id: `${id}-${i}`, workflowRun: { event }, checkRuns: { nodes: list } }))] },
});
const labeled = (name, h) => ({ __typename: 'LabeledEvent', createdAt: at(h), label: { name } });
function pr(number, { created, merged, commits = [], forced = [], labels = [], issue = null, head, mergeCommit }) {
	return {
		number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, state: 'MERGED', isDraft: false,
		createdAt: at(created), mergedAt: at(merged), baseRefName: 'main', headRefOid: head.oid, author: { login: 'builder' }, mergedBy: { login: 'builder' },
		mergeCommit,
		commits: { nodes: [{ commit: head }] },
		closingIssuesReferences: { nodes: issue ? [issue] : [] },
		timelineItems: {
			pageInfo: { hasNextPage: false },
			nodes: [
				...commits.map((c) => ({ __typename: 'PullRequestCommit', commit: c })),
				...forced.map(([before, afterCommit, h]) => ({ __typename: 'HeadRefForcePushedEvent', createdAt: at(h), beforeCommit: before, afterCommit })),
				...labels,
			],
		},
	};
}

// #1: claimed, approved, changed after review and approved again (2 rounds), then rebased: the approval carried
// over is not a third. Its second commit's check failed, then passed on a re-run with no new push: a flake.
const a1 = commit('a1', -0.5, { runs: [run('SUCCESS', 0.1)], statuses: [approval(1)] });
const b2 = commit('b2', 2, { runs: [run('FAILURE', 2.1), run('SUCCESS', 2.5)], statuses: [approval(3)] });
const c3 = commit('c3', 3.9, { statuses: [approval(4.2, true)] });
const main0 = commit('d0', -5, { runs: [run('SUCCESS', -5)] });
const main1 = commit('d1', 4.3, { runs: [run('SUCCESS', 4.4)] });
// Claimed long before, again just before the PR opened (the claim that counts), and again after it opened.
const launched = (h) => ({ __typename: 'IssueComment', createdAt: at(h), body: 'Builder launched: branch `b`, port 1.' });
const issue1 = { number: 11, title: 'Issue 11', timelineItems: { nodes: [labeled('agent: working', -50), labeled('agent: working', -1), launched(-0.99), labeled('agent: working', 10)] } };
const pr1 = pr(1, { created: 0, merged: 4.3, commits: [a1, b2], forced: [[b2, c3, 4]], issue: issue1, head: c3, mergeCommit: main1 });

// #2: one round, labeled for people, and the base's check failed on its merge commit. The commit before it only
// has a cancelled run; the one before that passed: it turned the base red.
const e4 = commit('e4', 4.9, { runs: [run('SUCCESS', 5.1)], statuses: [approval(5.5)] });
const mid = commit('d9', 5.8, { runs: [run('CANCELLED', 5.85)] });
const main2 = commit('d2', 6, { runs: [run('FAILURE', 6.1)] });
const pr2 = pr(2, { created: 5, merged: 6, commits: [e4], labels: [labeled('needs team input', 5.2)], head: e4, mergeCommit: main2 });

// #3: merged without an approval, onto a base that was already red: red after merging, but it didn't turn it red.
const f5 = commit('f5', 6.4, { runs: [run('SUCCESS', 6.6)] });
const main3 = commit('d3', 7, { runs: [run('FAILURE', 7.1)] });
const pr3 = pr(3, { created: 6.5, merged: 7, commits: [f5], head: f5, mergeCommit: main3 });

// #4: merged long before the default window.
const g6 = commit('a6', -500, { statuses: [approval(-499)] });
const pr4 = pr(4, { created: -500, merged: -499, commits: [g6], head: g6, mergeCommit: commit('d4', -499) });

const STATE = {
	repo: 'o/r', pr: {}, approved: [], verify: {}, failed: {},
	stats: {
		prs: [pr1, pr2, pr3, pr4],
		mainChain: [main3, main2, mid, main1, main0],
		history: [
			{ oid: sha('d2'), messageHeadline: 'PR 2 (#2)', committedDate: at(6), associatedPullRequests: { nodes: [{ number: 2 }] } },
			{ oid: sha('e7'), messageHeadline: 'Revert "PR 2 (#2)" (#5)', committedDate: at(8), associatedPullRequests: { nodes: [{ number: 5 }] } },
			{ oid: sha('e8'), messageHeadline: 'Hotfix straight on main', committedDate: at(9), associatedPullRequests: { nodes: [] } },
		],
		open: [
			{ number: 20, title: 'Old open PR', url: 'u', createdAt: at(-24 * 8), isDraft: false, baseRefName: 'main', closingIssuesReferences: { nodes: [] } },
			{ number: 21, title: 'Fresh open PR', url: 'u', createdAt: at(200), isDraft: false, baseRefName: 'main', closingIssuesReferences: { nodes: [{ number: 31 }] } },
		],
		claimed: [
			{ number: 30, title: 'Claimed long ago, no PR', url: 'u', timelineItems: { nodes: [labeled('agent: working', 24 * 5)] } },
			{ number: 31, title: 'Claimed long ago, has a PR', url: 'u', timelineItems: { nodes: [labeled('agent: working', 24 * 5)] } },
			{ number: 32, title: 'Claimed just now', url: 'u', timelineItems: { nodes: [labeled('agent: working', 24 * 10 - 1)] } },
		],
	},
};

function stats(args, state = STATE) {
	const dir = temp('foreman-stats-');
	const stateFile = join(dir, 'gh-state.json');
	writeFileSync(stateFile, JSON.stringify(state));
	writeFileSync(join(dir, 'foreman.config.json'), '{}');
	const r = spawnSync('node', [join(ROOT, 'bin/foreman.mjs'), 'stats', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: stateFile } });
	return { code: r.status, out: r.stdout + r.stderr, calls: existsSync(`${stateFile}.calls`) ? readFileSync(`${stateFile}.calls`, 'utf8').trim().split('\n') : [] };
}
const json = (args, state) => { const r = stats([...args, '--json'], state); assert.equal(r.code, 0, r.out); return JSON.parse(r.out); };

test('stats: rounds count fresh approvals only; a carried-over approval is a rebase, not a round', () => {
	const r = json([]);
	const [p1, p2, p3] = r.prs;
	assert.deepEqual(r.prs.map((p) => p.number), [1, 2, 3], 'merged in the last 30 days, oldest first; #4 is outside');
	assert.equal(p1.rounds, 2);
	assert.equal(p1.carriedOver, 1);
	assert.equal(p1.pushes, 2, 'b2 after opening, and the force-push to c3; a1 was there when it opened');
	assert.equal(p1.forcePushes, 1);
	assert.equal(p2.rounds, 1);
	assert.equal(p3.rounds, 0);
	assert.equal(r.summary.medianRounds, 1);
	assert.equal(r.summary.carriedOver, 1);
	assert.equal(p1.approvedAtMergedHead, true, 'the carried-over approval is on the merged head');
	assert.equal(p3.approvedAtMergedHead, false);
	assert.deepEqual(r.summary.mergedWithoutApproval, [3]);
});

test('stats: a check that failed, then passed when re-run (same suite, same commit), is a flake', () => {
	const r = json([]);
	assert.deepEqual(r.prs[0].checks, { runs: 3, failed: 1, flakes: 1, cancelled: 0, medianMs: 10 * 60e3, durationsMs: [10 * 60e3, 10 * 60e3, 10 * 60e3] });
	assert.equal(r.prs[1].checks.flakes, 0);
	assert.equal(r.summary.checkRuns, 5);
	assert.equal(r.summary.flakes, 1);
	assert.equal(r.summary.flakeRate, 1 / 5);
	assert.equal(r.summary.medianCheckMs, 10 * 60e3);
	// A failure fixed by a new commit is not a flake.
	const fixed = structuredClone(STATE);
	const c = fixed.stats.prs[0].timelineItems.nodes[1].commit;
	c.checkSuites.nodes[1].checkRuns.nodes = [run('FAILURE', 2.1)];
	fixed.stats.prs[0].timelineItems.nodes[2].beforeCommit = c; // The same commit, as the force-push's before.
	fixed.stats.prs[0].timelineItems.nodes.push({ __typename: 'PullRequestCommit', commit: commit('b9', 2.4, { runs: [run('SUCCESS', 2.5)] }) });
	assert.equal(json([], fixed).prs[0].checks.flakes, 0);
	// Nor is a pull_request run failing and a push run (another suite) passing on the same commit.
	const twoEvents = structuredClone(STATE);
	twoEvents.stats.prs[0].timelineItems.nodes[1].commit = commit('b2', 2, { suites: [['pull_request', [run('FAILURE', 2.1)]], ['push', [run('SUCCESS', 2.2)]]], statuses: [approval(3)] });
	twoEvents.stats.prs[0].timelineItems.nodes[2].beforeCommit = twoEvents.stats.prs[0].timelineItems.nodes[1].commit;
	const te = json([], twoEvents).prs[0].checks;
	assert.equal(te.flakes, 0);
	assert.equal(te.failed, 1);
});

test('stats: a merge whose base check failed after passing before it turned the base red; one onto a red base didn\'t', () => {
	const r = json([]);
	assert.deepEqual(r.prs[1].afterMerge, { sha: sha('d2'), result: 'failed', flaky: false, before: 'passed', beforeSha: sha('d1'), turnedRed: true, alreadyRed: false }, 'the cancelled run just before it is skipped');
	assert.deepEqual(r.prs[2].afterMerge, { sha: sha('d3'), result: 'failed', flaky: false, before: 'failed', beforeSha: sha('d2'), turnedRed: false, alreadyRed: true });
	assert.deepEqual(r.summary.turnedMainRed, [2]);
	assert.deepEqual(r.summary.alreadyRed, [3]);
	assert.deepEqual(r.summary.redAfterMerge, [2, 3]);
	assert.deepEqual(r.prs[0].afterMerge, { sha: sha('d1'), result: 'passed', flaky: false, before: null, beforeSha: null, turnedRed: false, alreadyRed: false });
	// No decided check anywhere before it: can't tell, so it isn't counted as turning the base red.
	const lone = structuredClone(STATE);
	lone.stats.mainChain = [main3, mid];
	const l = json([], lone);
	assert.equal(l.prs[2].afterMerge.before, 'unknown');
	assert.equal(l.prs[2].afterMerge.turnedRed, false);
	assert.deepEqual(l.summary.redUnknownBefore, [2, 3]);
	// Reverts and commits without a PR, from the base branch's history.
	assert.equal(r.summary.reverts, 1);
	assert.equal(r.prs[1].revertedBy, '#5');
	assert.equal(r.summary.withoutPr, 1);
	assert.ok(r.worthALook.findIndex((w) => w.kind === 'red') < r.worthALook.findIndex((w) => w.kind === 'flakes'), 'most serious first');
});

test('stats: times from claim to merge, and their medians', () => {
	const r = json([]);
	const t = r.prs[0].times;
	assert.equal(r.prs[0].claimedAt, at(-0.99).replace('.000Z', 'Z'), 'the nearest claim before the PR opened, not the first or a later one');
	assert.equal(t.claimToOpenMs, hours(0.99));
	assert.equal(t.openToApprovalMs, hours(1), 'to the first fresh approval');
	assert.equal(t.approvalToMergeMs, hours(4.3) - hours(1));
	assert.equal(t.lastApprovalToMergeMs, hours(4.3) - hours(4.2), 'the carried-over one is the last');
	assert.equal(t.openToMergeMs, hours(4.3));
	assert.equal(r.prs[1].times.claimToMergeMs, null, 'no issue, no claim');
	assert.equal(r.summary.medianOpenToMergeMs, hours(1), 'of 4.3 h, 1 h and 0.5 h');
	assert.equal(r.summary.medianOpenToApprovalMs, (hours(1) + hours(5.5) - hours(5)) / 2, '#3 was never approved');
	assert.deepEqual(r.summary.slowest.map((x) => x.number), [1, 2, 3]);
	assert.deepEqual(r.summary.waitedOnPeople, [2]);
	assert.deepEqual(r.prs[1].people, ['needs team input']);
	// Now: the old open PR, and the issue claimed days ago with no PR (not the one with a PR, nor the fresh claim).
	assert.deepEqual(r.summary.openOlderThan7Days.map((p) => p.number), [20]);
	assert.deepEqual(r.summary.claimedWithoutPr.map((i) => i.number), [30]);
});

test('stats: --since and --until pick the window, as dates or days back', () => {
	const r = stats(['--since', at(4.5).slice(0, 19) + 'Z', '--json']);
	assert.deepEqual(JSON.parse(r.out).prs.map((p) => p.number), [2, 3]);
	assert.match(r.calls.find((c) => c.startsWith('search')), /^search repo:o\/r is:pr is:merged base:main merged:\S+Z\.\.\S+Z$/);
	assert.deepEqual(json(['--since', '30d', '--until', at(5).slice(0, 19) + 'Z']).prs.map((p) => p.number), [1]);
	assert.deepEqual(json(['--since', '1000d']).prs.map((p) => p.number), [4, 1, 2, 3]);

	const now = Date.parse('2026-03-31T12:00:00Z');
	assert.deepEqual(parseWindow({}, now), { since: now - 30 * 24 * HOUR, until: now });
	assert.deepEqual(parseWindow({ since: '2026-03-01', until: '2026-03-02' }, now), { since: Date.parse('2026-03-01T00:00:00Z'), until: Date.parse('2026-03-02T23:59:59Z') });
	assert.equal(parseWindow({ since: '7d' }, now).since, now - 7 * 24 * HOUR);
	assert.throws(() => parseWindow({ since: 'last week' }, now), /isn't a date \(YYYY-MM-DD\) or a number of days/);
	assert.throws(() => parseWindow({ since: '2026-02-30' }, now), /isn't a date/);
	assert.throws(() => parseWindow({ since: '2026-04-01' }, now), /must be before/);
	assert.match(stats(['--since', 'yesterday']).out, /--since yesterday isn't a date/);
});

test('stats: --json has the summary, every PR and what\'s worth a look', () => {
	const r = json([]);
	for (const k of ['repo', 'base', 'requiredCheck', 'approvalContext', 'window', 'generatedAt', 'summary', 'prs', 'reverts', 'withoutPr', 'worthALook', 'warnings']) assert.ok(k in r, k);
	assert.equal(r.repo, 'o/r');
	assert.equal(r.summary.merged, 3);
	for (const k of ['number', 'title', 'url', 'createdAt', 'mergedAt', 'mergedBy', 'closes', 'claimedAt', 'firstApprovalAt', 'rounds', 'carriedOver', 'pushes', 'approvals', 'approvedAtMergedHead', 'times', 'checks', 'afterMerge', 'people', 'revertedBy', 'events']) assert.ok(k in r.prs[0], k);
	assert.deepEqual(r.prs[0].approvals.map((a) => a.carried), [false, false, true]);
	assert.deepEqual(r.prs[0].closes, [11]);
});

test('stats: the human summary, table and worth-a-look lines', () => {
	const r = stats([]);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /^o\/r · main · PRs merged /);
	assert.match(r.out, /3 PRs merged\. The typical one \(median\): 1 review round, 0 pushes after it opened, 1\.0 h from opened to merged/);
	assert.match(r.out, /1 approval carried over a clean rebase \(not counted as rounds\)/);
	assert.match(r.out, /Checks \("verify"\): 5 runs, 1 failed; 1 flake .*20\.0% of runs\)/);
	assert.match(r.out, /1 merge turned main red \(#2\); 1 more landed on main that was already red \(#3\)\. 1 revert\./);
	assert.match(r.out, /1 PR merged without an approval on the last commit, so not through foreman merge \(#3\)/);
	assert.match(r.out, /Now: 1 open PR older than 7 days \(#20\); 1 claimed issue with no PR for over 2 days \(#30\)\./);
	assert.match(r.out, /\n {2}#1 +PR 1 +2 +2 +4\.3 h +1 +1 flake; 1 carried over\n/);
	assert.match(r.out, /Worth a look\n {2}#2 turned main red: verify failed on the merge commit d2d2d2d\n {2}#2 was reverted \(#5\)\n {2}#3 merged without an approval/);
	assert.match(r.out, /1 commit reached main without a PR: e8e8e8e "Hotfix straight on main"/);
	assert.match(r.out, / {2}#1: verify failed, then passed when re-run on the same commit/);
});

test('stats: an empty window says so, and --json still has the whole shape', () => {
	const r = stats(['--since', '2000-01-01', '--until', '2000-01-02']);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /No PRs merged into main in this window\./);
	assert.doesNotMatch(r.out, /Rounds|Worth a look\n {2}#/);
	const j = json(['--since', '2000-01-01', '--until', '2000-01-02']);
	assert.equal(j.summary.merged, 0);
	assert.equal(j.summary.medianRounds, null);
	assert.equal(j.summary.flakeRate, null);
	assert.deepEqual(j.prs, []);
});

test('stats: search results come a page at a time', () => {
	const paged = structuredClone(STATE);
	paged.stats.pageSize = 1;
	const r = stats(['--json'], paged);
	assert.deepEqual(JSON.parse(r.out).prs.map((p) => p.number), [1, 2, 3]);
	assert.equal(r.calls.filter((c) => c.startsWith('search')).length, 3);
});

test('stats --pr: one PR\'s timeline', () => {
	const r = stats(['--pr', '1']);
	assert.equal(r.code, 0, r.out);
	const lines = r.out.split('\n');
	const order = ['#11 claimed', 'opened by builder', 'verify passed on a1a1a1a', 'approved at a1a1a1a by coord', 'pushed b2b2b2b', 'verify failed (failure) on b2b2b2b', 'verify passed on b2b2b2b', 'approved at b2b2b2b', 'force-pushed b2b2b2b → c3c3c3c', 'approval carried over to c3c3c3c', 'merged by builder', 'main: verify passed on the merge commit d1d1d1d'];
	let last = -1;
	for (const what of order) {
		const i = lines.findIndex((l) => l.includes(what));
		assert.ok(i > last, `"${what}" in order:\n${r.out}`);
		last = i;
	}
	assert.match(r.out, /Review rounds 2 \(\+1 carried over a rebase\) · 2 pushes after opening \(1 force-push\) · verify: 3 runs, 1 failed, 1 flake/);
	assert.equal(json(['--pr', '2']).afterMerge.turnedRed, true);
	assert.match(stats(['--pr', '2']).out, /main after the merge: failed \(turned it red: it passed on d1d1d1d before\)/);
	assert.match(stats(['--pr', 'x']).out, /--pr takes a PR number/);
	const missing = stats(['--pr', '99']);
	assert.equal(missing.code, 1);
	assert.match(missing.out, /no PR #99 in o\/r/);
});

test('stats: medians and revert titles', () => {
	assert.equal(median([]), null);
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 2, 3]), 2.5);
	assert.equal(median([null, 5]), 5);
	assert.equal(revertedPr('Revert "Fix the header (#12)" (#14)'), 12);
	assert.equal(revertedPr('Revert "Fix the header"'), null);
	assert.equal(revertedPr('Fix (#12)'), null);
});

test('stats: a PR number that doesn\'t resolve doesn\'t fail the rest of its batch', () => {
	const ghost = structuredClone(STATE);
	ghost.stats.searchExtra = [77];
	assert.deepEqual(json([], ghost).prs.map((p) => p.number), [1, 2, 3]);
});

test('stats: suites, runs and issue timelines are paged to the end, giving the same numbers', () => {
	const paged = structuredClone(STATE);
	Object.assign(paged.stats, { suitePage: 1, runPage: 1, issuePage: 1 });
	const r = stats(['--json'], paged);
	const strip = (x) => ({ ...x, generatedAt: '', window: '' });
	assert.deepEqual(strip(JSON.parse(r.out)), strip(json([])));
	assert.ok(r.calls.some((c) => c.startsWith('query{s0:node')), 'more runs of a suite');
	assert.ok(r.calls.some((c) => /checkSuites\(first:10,after:/.test(c)), 'more suites of a commit');
	assert.ok(r.calls.some((c) => c.includes('issue(number:$n)')), 'earlier issue timeline');
});

test('stats: the dashboard gets the summary as formatted rows', () => {
	const rows = summaryRows(json([]).summary);
	const row = (label) => rows.find((x) => x.label === label);
	assert.equal(row('PRs merged').value, '3');
	assert.equal(row('Opened → merged').value, '1.0 h');
	assert.equal(row('Flake rate').value, '20.0% of 5 runs');
	assert.deepEqual(row('Turned base red'), { label: 'Turned base red', value: '1 (#2)', attention: true });
	assert.equal(row('Claimed, no PR > 2 days').value, '1 (#30)');
});
