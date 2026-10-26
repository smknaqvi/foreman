#!/usr/bin/env node
/**
 * A stand-in for the GitHub CLI, for test/merge.test.mjs. It answers exactly the calls scripts/merge.sh
 * makes, from a JSON state file ($FAKE_GH_STATE) the test controls, and records approvals and merges there.
 *   { repo, pr: { number, state, isDraft, head, mergeable, branch? }, approved: [sha], verify: { sha: conclusion },
 *     failed: { sha: "names" }, checksPass, merged, origin? }
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

if (a === 'repo' && b === 'view') out(s.repo);
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
