#!/usr/bin/env node
/**
 * A stand-in for the GitHub CLI, for test/merge.test.mjs, test/watchdog.test.mjs and test/auto.test.mjs. It answers exactly the calls scripts/merge.sh
 * makes, from a JSON state file ($FAKE_GH_STATE) the test controls, and records approvals and merges there.
 *   { repo, pr: { number, state, isDraft, head, mergeable, branch? }, approved: [sha], verify: { sha: conclusion },
 *     failed: { sha: "names" }, checksPass, merged, origin?, runs? (gh run list on the base),
 *     checks?: { sha: [check run] } (instead of the ones verify and failed imply), statuses?: { sha: [status] },
 *     prCommits? (the PR's commits; default: one by GitHub Actions' bot at its head), pr.author?,
 *     forcePushes? (GraphQL force-push timeline), dispatched (gh workflow run calls, recorded), dispatchFails?,
 *     mergeFails? (gh pr merge refuses), workflows? (gh workflow list), workflowRuns? (the head's workflow runs),
 *     apiCalls (REST reads, recorded) }
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

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

const jq = args.includes('--jq');
if (a === 'repo' && b === 'view') out(jq ? s.repo : JSON.stringify({ nameWithOwner: s.repo }));
else if (a === 'pr' && b === 'list') out(JSON.stringify([{ number: s.pr.number ?? 7, headRefName: s.pr.branch, headRefOid: s.pr.head, isCrossRepository: false, isDraft: s.pr.isDraft, baseRefName: 'main', author: s.pr.author ?? { login: 'app/github-actions', is_bot: true } }]));
else if (a === 'run' && b === 'list') out(JSON.stringify(s.runs ?? []));
else if (a === 'api' && b === 'graphql') {
	// Force-push timelines (approvals before a rebase): s.forcePushes, [{ beforeCommit: { oid, status: { contexts } } }].
	const q = args.find((x) => x.startsWith('query=')) ?? '';
	const repository = Object.fromEntries([...q.matchAll(/p(\d+):pullRequest/g)].map(([, n]) => [`p${n}`, { timelineItems: { nodes: s.forcePushes ?? [] } }]));
	out(JSON.stringify({ data: { repository } }));
} else if (a === 'workflow' && b === 'list') out(JSON.stringify(s.workflows ?? []));
else if (a === 'workflow' && b === 'run') { (s.dispatched ??= []).push(args.slice(2).join(' ')); save(); if (s.dispatchFails) process.exit(1); }
else if (a === 'api') {
	const ep = args.slice(1).find((x) => x.startsWith('repos/'));
	if (ep && !ep.includes('/statuses/')) { (s.apiCalls ??= []).push(ep); save(); }
	let m;
	if ((m = ep.match(/commits\/(\w+)\/statuses$/))) out(s.approved.includes(m[1]) ? 'success' : '');
	else if ((m = ep.match(/\/statuses\/(\w+)$/))) { s.approved.push(m[1]); save(); }
	else if ((m = ep.match(/commits\/(\w+)\/check-runs$/)) && args.includes('-f') && !args[args.indexOf('-f') + 1].startsWith('check_name=')) {
		// Every check run on the commit (foreman auto-approve).
		const runs = s.checks?.[m[1]] ?? [
			...(s.verify[m[1]] ? [{ id: 1, name: s.checkName ?? 'verify', status: 'completed', conclusion: s.verify[m[1]] }] : []),
			...(s.failed[m[1]] ? s.failed[m[1]].split(', ').map((name, i) => ({ id: 100 + i, name, status: 'completed', conclusion: 'failure' })) : []),
		];
		out(JSON.stringify({ total_count: runs.length, check_runs: runs }));
	} else if (ep.endsWith('/actions/runs')) out(JSON.stringify({ workflow_runs: s.workflowRuns ?? [] })); // By head_sha: which workflow each check suite is.
	else if ((m = ep.match(/commits\/(\w+)\/status$/))) {
		const approval = s.approved.includes(m[1]) ? [{ context: 'coordinator-review', state: 'success' }] : [];
		out(JSON.stringify({ statuses: [...(s.statuses?.[m[1]] ?? []), ...approval] }));
	} else if ((m = ep.match(/pulls\/(\d+)\/commits$/))) {
		const bot = { login: 'github-actions[bot]' };
		out(JSON.stringify(s.prCommits ?? [{ sha: s.pr.head, author: bot, committer: bot }]));
	} else if ((m = ep.match(/compare\/(.+)\.\.\.(\w+)$/))) {
		// From the origin repo's own git, shaped like GitHub's: per file a status and (unless binary) a patch.
		const g = (...x) => execFileSync('git', ['-C', s.origin, ...x], { encoding: 'utf8' });
		const range = `${m[1]}...${m[2]}`;
		const files = g('diff', '--name-status', '--no-renames', range).split('\n').filter(Boolean).map((l) => {
			const [st, filename] = l.split('\t');
			const diff = g('diff', '--no-renames', range, '--', filename);
			const hunk = diff.indexOf('\n@@');
			const status = /\nold mode /.test(diff) && hunk < 0 ? 'changed' : ({ M: 'modified', A: 'added', D: 'removed' })[st[0]];
			return { filename, status, ...(hunk >= 0 ? { patch: diff.slice(hunk + 1).replace(/\n$/, '') } : {}) };
		});
		out(JSON.stringify({ files }));
	} else if ((m = ep.match(/commits\/(\w+)\/check-runs$/)) && args.includes('-f')) {
		const name = args[args.indexOf('-f') + 1].replace(/^check_name=/, '');
		const conclusion = name === (s.checkName ?? 'verify') ? s.verify[m[1]] ?? '' : '';
		out(jq ? conclusion : JSON.stringify({ check_runs: conclusion ? [{ status: 'completed', conclusion }] : [] }));
	} else if ((m = ep.match(/commits\/(\w+)\/check-runs$/))) { if (s.failed[m[1]]) out(s.failed[m[1]].split(', ').join('\n')); }
	else { process.stderr.write(`fake gh: unexpected api call ${ep}\n`); process.exit(2); }
} else if (a === 'pr' && b === 'view') {
	const json = args[args.indexOf('--json') + 1];
	if (json === 'state') out(s.merged ? 'MERGED' : s.pr.state);
	else if (json === 'headRefOid') out(JSON.stringify({ headRefOid: s.pr.head }));
	else out(`${s.pr.state} ${s.pr.isDraft} ${s.pr.head} ${s.pr.mergeable}`);
} else if (a === 'pr' && b === 'checks') process.exit(s.checksPass ? 0 : 1);
else if (a === 'pr' && b === 'merge') {
	const head = args[args.indexOf('--match-head-commit') + 1];
	if (head !== s.pr.head || s.mergeFails) process.exit(1);
	s.merged = true;
	save();
} else {
	process.stderr.write(`fake gh: unexpected call ${args.join(' ')}\n`);
	process.exit(2);
}
