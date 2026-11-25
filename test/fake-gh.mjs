#!/usr/bin/env node
/**
 * A stand-in for the GitHub CLI, for test/merge.test.mjs (and the merged-PR list `foreman memory updates`
 * reads, test/memory.test.mjs). It answers exactly the calls scripts/merge.sh makes, from a JSON state file
 * ($FAKE_GH_STATE) the test controls, and records approvals and merges there. `pr list` returns `mergedPrs`
 * and records the call in `calls`. `api graphql` answers `foreman stats` (test/stats.test.mjs) from `stats`,
 * logging each query to <state file>.calls:
 *   { repo, pr: { number, state, isDraft, head, mergeable, branch? }, approved: [sha], verify: { sha: conclusion },
 *     failed: { sha: "names" }, checksPass, merged, origin?,
 *     stats?: { prs: [PR as GitHub's GraphQL gives it], history: [commit], open: [PR], claimed: [issue], pageSize? } }
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
else if (a === 'api' && b === 'graphql') out(JSON.stringify({ data: graphql() }));
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

/** The GraphQL queries `foreman stats` makes, answered from `s.stats`, keyed on what each query asks for. */
function graphql() {
	const query = args.find((x) => x.startsWith('query=')).slice(6);
	const v = Object.fromEntries(args.filter((x, i) => ['-f', '-F'].includes(args[i - 1]) && !x.startsWith('query=')).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
	const st = s.stats ?? {};
	// stats makes these in parallel: each call is one appended line, never a rewrite of the state file.
	appendFileSync(`${file}.calls`, `${query.includes('search(') ? `search ${v.q}` : query.slice(0, 80).replace(/\s+/g, ' ')}\n`);
	if (query.includes('search(')) { // Only the PRs merged in the query's range, a page at a time.
		const [, from, to] = v.q.match(/merged:(\S+)\.\.(\S+)/);
		const hits = (st.prs ?? []).filter((p) => Date.parse(p.mergedAt) >= Date.parse(from) && Date.parse(p.mergedAt) <= Date.parse(to));
		const size = st.pageSize ?? 100, start = Number(v.after ?? 0);
		const page = hits.slice(start, start + size);
		return { search: { issueCount: hits.length, pageInfo: { hasNextPage: start + size < hits.length, endCursor: String(start + size) }, nodes: page.map((p) => ({ number: p.number })) } };
	}
	const repository = {};
	for (const [, alias, n] of query.matchAll(/(p(\d+)):pullRequest\(number:\d+\)/g)) repository[alias] = (st.prs ?? []).concat(st.open ?? []).find((p) => p.number === Number(n)) ?? null;
	if (query.includes(':object(oid:')) { // Every commit the PRs mention, full.
		const all = new Map();
		const walk = (x) => { if (x && typeof x === 'object') { if (x.oid && (x.status !== undefined || x.checkSuites)) all.set(x.oid, x); Object.values(x).forEach(walk); } };
		walk(st.prs);
		for (const [, alias, oid] of query.matchAll(/(c\d+):object\(oid:"(\w+)"\)/g)) repository[alias] = all.get(oid) ?? null;
	}
	if (query.includes('history(')) repository.ref = { target: { history: { pageInfo: { hasNextPage: false }, nodes: (st.history ?? []).filter((c) => c.committedDate >= v.since && c.committedDate <= v.until) } } };
	if (query.includes('openPrs:')) { repository.openPrs = { nodes: st.open ?? [] }; repository.claimed = { nodes: st.claimed ?? [] }; }
	return { repository };
}
