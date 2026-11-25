#!/usr/bin/env node
/**
 * A stand-in for the GitHub CLI, for test/merge.test.mjs (and the merged-PR list `foreman memory updates`
 * reads, test/memory.test.mjs). It answers exactly the calls scripts/merge.sh makes, from a JSON state file
 * ($FAKE_GH_STATE) the test controls, and records approvals and merges there. `pr list` returns `mergedPrs`
 * and records the call in `calls`. `api graphql` answers `foreman stats` (test/stats.test.mjs) from `stats`,
 * logging each query to <state file>.calls:
 *   { repo, pr: { number, state, isDraft, head, mergeable, branch? }, approved: [sha], verify: { sha: conclusion },
 *     failed: { sha: "names" }, checksPass, merged, origin?,
 *     stats?: { prs: [PR as GitHub's GraphQL gives it], history: [commit], mainChain: [base commit, newest first],
 *       open: [PR], claimed: [issue], searchExtra: [PR number], pageSize?, suitePage?, runPage?, issuePage? } }
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_GH_STATE;
const s = JSON.parse(readFileSync(file, 'utf8'));
// With { origin, pr.branch }, the PR's head follows its branch on the origin, as on GitHub after a push.
if (s.origin && s.pr.branch) {
	try { s.pr.head = execFileSync('git', ['-C', s.origin, 'rev-parse', `refs/heads/${s.pr.branch}`], { encoding: 'utf8' }).trim(); } catch {}
}
const args = process.argv.slice(2);
const save = () => writeFileSync(file, JSON.stringify(s));
const out = (x) => process.stdout.write(`${x}\n`);
const [a, b] = args;

if (a === 'repo' && b === 'view') out(args.includes('owner,name') ? JSON.stringify({ owner: { login: s.repo.split('/')[0] }, name: s.repo.split('/')[1] }) : s.repo);
else if (a === 'api' && b === 'graphql') graphql();
else if (a === 'api') {
	const ep = args.slice(1).find((x) => x.startsWith('repos/'));
	let m;
	if ((m = ep.match(/commits\/(\w+)\/statuses$/))) out(s.approved.includes(m[1]) ? 'success' : '');
	else if ((m = ep.match(/\/statuses\/(\w+)$/))) { s.approved.push(m[1]); save(); }
	else if ((m = ep.match(/commits\/(\w+)\/check-runs$/)) && args.includes('-f')) {
		const name = args[args.indexOf('-f') + 1].replace(/^check_name=/, '');
		out(name === (s.checkName ?? 'verify') ? s.verify[m[1]] ?? '' : '');
	} else if ((m = ep.match(/commits\/(\w+)\/check-runs$/))) { if (s.failed[m[1]]) out(s.failed[m[1]].split(', ').join('\n')); }
	else { process.stderr.write(`fake gh: unexpected api call ${ep}\n`); process.exit(2); }
} else if (a === 'pr' && b === 'view') {
	const json = args[args.indexOf('--json') + 1];
	if (json === 'state') out(s.merged ? 'MERGED' : s.pr.state);
	else if (json === 'headRefOid') out(JSON.stringify({ headRefOid: s.pr.head }));
	else out(`${s.pr.state} ${s.pr.isDraft} ${s.pr.head} ${s.pr.mergeable}`);
} else if (a === 'pr' && b === 'list') {
	s.calls = [...(s.calls ?? []), args.join(' ')];
	save();
	out(JSON.stringify(s.mergedPrs ?? []));
} else if (a === 'pr' && b === 'checks') process.exit(s.checksPass ? 0 : 1);
else if (a === 'pr' && b === 'merge') {
	const head = args[args.indexOf('--match-head-commit') + 1];
	if (head !== s.pr.head) process.exit(1);
	s.merged = true;
	save();
} else {
	process.stderr.write(`fake gh: unexpected call ${args.join(' ')}\n`);
	process.exit(2);
}

/**
 * The GraphQL queries `foreman stats` makes, answered from `s.stats`, keyed on what each query asks for. A PR
 * that isn't there is null plus a NOT_FOUND error, and gh exits 1 after printing the answer, as GitHub's does.
 * With `suitePage`, `runPage` or `issuePage` set, those lists come a page of that size at a time.
 */
function graphql() {
	const query = args.find((x) => x.startsWith('query=')).slice(6);
	const v = Object.fromEntries(args.filter((x, i) => ['-f', '-F'].includes(args[i - 1]) && !x.startsWith('query=')).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
	const st = s.stats ?? {};
	// stats makes these in parallel: each call is one appended line, never a rewrite of the state file.
	appendFileSync(`${file}.calls`, `${query.includes('search(') ? `search ${v.q}` : query.slice(0, 400).replace(/\s+/g, ' ')}\n`);
	const errors = [];
	const done = (data) => {
		process.stdout.write(`${JSON.stringify(errors.length ? { data, errors } : { data })}\n`);
		if (errors.length) { process.stderr.write(`gh: ${errors[0].message}\n`); process.exitCode = 1; } // Not exit(): stdout must drain first.
	};
	const cursor = (x) => (x === undefined || x === null ? 0 : Number(x));
	const page = (list, size, start = 0) => ({ nodes: list.slice(start, size ? start + size : undefined), pageInfo: { hasNextPage: Boolean(size) && start + size < list.length, endCursor: String(start + (size || list.length)) } });
	const suitePage = (suite, start = 0) => ({ ...suite, checkRuns: page(suite.checkRuns.nodes, st.runPage, start) });
	const fullCommit = (c, start = 0) => c && { ...c, checkSuites: (() => { const p = page(c.checkSuites.nodes, st.suitePage, start); return { ...p, nodes: p.nodes.map((x) => suitePage(x)) }; })() };
	const issuePage = (issue) => { // From the end, like timelineItems(last:).
		const all = issue.timelineItems.nodes, size = st.issuePage ?? all.length;
		const end = v.before === undefined ? all.length : Number(v.before);
		const from = Math.max(0, end - size);
		return { ...issue, timelineItems: { nodes: all.slice(from, end), pageInfo: { hasPreviousPage: from > 0, startCursor: String(from) } } };
	};
	const commits = new Map(), suites = new Map();
	const walk = (x) => {
		if (!x || typeof x !== 'object') return;
		if (x.oid && (x.status !== undefined || x.checkSuites)) commits.set(x.oid, x);
		if (x.id && x.checkRuns) suites.set(x.id, x);
		Object.values(x).forEach(walk);
	};
	walk([st.prs, st.mainChain]);

	if (query.includes('search(')) { // Only the PRs merged in the query's range, a page at a time.
		const [, from, to] = v.q.match(/merged:(\S+)\.\.(\S+)/);
		const hits = (st.prs ?? []).filter((p) => Date.parse(p.mergedAt) >= Date.parse(from) && Date.parse(p.mergedAt) <= Date.parse(to)).map((p) => p.number).concat(st.searchExtra ?? []);
		const size = st.pageSize ?? 100, start = cursor(v.after);
		return done({ search: { issueCount: hits.length, pageInfo: { hasNextPage: start + size < hits.length, endCursor: String(start + size) }, nodes: hits.slice(start, start + size).map((number) => ({ number })) } });
	}
	if (query.startsWith('query{')) { // More runs of check suites, by suite id.
		const data = {};
		for (const [, alias, id, after] of query.matchAll(/(s\d+):node\(id:"([^"]+)"\)\{\.\.\.on CheckSuite\{checkRuns\(first:\d+,after:"(\d+)"/g)) data[alias] = { checkRuns: page(suites.get(id).checkRuns.nodes, st.runPage, Number(after)) };
		return done(data);
	}
	const repository = {};
	for (const [, alias, n] of query.matchAll(/(p(\d+)):pullRequest\(number:\d+\)/g)) {
		const pr = (st.prs ?? []).concat(st.open ?? []).find((p) => p.number === Number(n));
		repository[alias] = pr ? { ...pr, closingIssuesReferences: { nodes: pr.closingIssuesReferences.nodes.map(issuePage) } } : null;
		if (!pr) errors.push({ type: 'NOT_FOUND', path: ['repository', alias], message: `Could not resolve to a PullRequest with the number of ${n}.` });
	}
	if (query.includes('issue(number:$n)')) { // Earlier claims, read backwards.
		const issue = (st.prs ?? []).flatMap((p) => p.closingIssuesReferences.nodes).find((i) => i.number === Number(v.n));
		repository.issue = issuePage(issue);
	}
	for (const [, alias, oid, rest] of query.matchAll(/(c\d+):object\(oid:"(\w+)"\)(\{\.\.\.on Commit\{checkSuites\(first:\d+,after:"(\d+)")?/g)) {
		const after = rest ? Number(rest.match(/after:"(\d+)"/)[1]) : 0;
		const c = commits.get(oid);
		if (rest) { const p = page(c.checkSuites.nodes, st.suitePage, after); repository[alias] = { checkSuites: { ...p, nodes: p.nodes.map((x) => suitePage(x)) } }; }
		else repository[alias] = fullCommit(c) ?? null;
	}
	const ancestor = query.match(/h0:object\(oid:"(\w+)"\)/);
	if (ancestor) { // The base's history from a commit, newest first, the commit itself included.
		const chain = st.mainChain ?? [];
		const from = chain.findIndex((c) => c.oid === ancestor[1]);
		const p = page(from < 0 ? [] : chain.slice(from), 2, cursor(v.after));
		repository.h0 = { history: { ...p, nodes: p.nodes.map((c) => fullCommit(c)) } };
	} else if (query.includes('history(')) {
		repository.ref = { target: { history: { pageInfo: { hasNextPage: false }, nodes: (st.history ?? []).filter((c) => c.committedDate >= v.since && c.committedDate <= v.until) } } };
	}
	if (query.includes('openPrs:')) { repository.openPrs = { nodes: st.open ?? [] }; repository.claimed = { nodes: st.claimed ?? [] }; }
	return done({ repository });
}
