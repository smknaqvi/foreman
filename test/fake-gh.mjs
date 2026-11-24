#!/usr/bin/env node
/**
 * A stand-in for the GitHub CLI, for test/merge.test.mjs. It answers exactly the calls scripts/merge.sh
 * makes (and the merged-PR list `foreman memory updates` reads), from a JSON state file ($FAKE_GH_STATE) the
 * test controls, and records approvals and merges there.
 *   { repo, pr: { number, state, isDraft, head, mergeable, branch? }, approved: [sha], memoryApproved?: [sha],
 *     verify: { sha: conclusion },
 *     failed: { sha: "names" }, checksPass, merged, origin?, mergedPrs?: [{ number, title, body, mergedAt, headRefName }] }
 * For `foreman tick` (lib/state.mjs's readCrew): { openPrs?: [PRs as `gh pr list --json` gives them],
 * forcePushes?, prFiles?: [every file of a PR with 100+] }; runs and issues are empty.
 * `pr list` calls are recorded in `calls`, so a test can check what was asked.
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

if (a === 'repo' && b === 'view') out(args.includes('owner,name') ? JSON.stringify({ owner: { login: s.repo.split('/')[0] }, name: s.repo.split('/')[1] }) : s.repo);
else if ((a === 'run' || a === 'issue') && b === 'list') out('[]');
else if (a === 'api' && b === 'graphql') { // Approvals from before a force-push: none.
	const query = args.find((x) => x.startsWith('query=')) ?? '';
	// forcePushes?: { "<PR number>": [{ oid, contexts: [status contexts that succeeded on it], description? }] }.
	// The head's statuses come from openPrs' statusCheckRollup (a description there, or foreman's wording).
	const MEMORY = 'Memory approved by foreman approve';
	const ctx = (context, description) => ({ context, state: 'SUCCESS', description: description ?? (/-memory$/.test(context) ? MEMORY : '') });
	const node = ({ oid, contexts, description }) => ({ beforeCommit: { oid, statusCheckRollup: { state: 'SUCCESS' }, status: { contexts: contexts.map((c) => ctx(c, description)) } } });
	const head = (n) => {
		const pr = (s.openPrs ?? []).find((p) => String(p.number) === n);
		const contexts = (pr?.statusCheckRollup ?? []).filter((c) => c.__typename === 'StatusContext' && c.state === 'SUCCESS').map((c) => ctx(c.context, c.description));
		return { nodes: [{ commit: { oid: pr?.headRefOid, status: { contexts } } }] };
	};
	const repository = Object.fromEntries([...query.matchAll(/\bp(\d+):pullRequest/g)].map(([, n]) => [`p${n}`, { commits: head(n), timelineItems: { nodes: (s.forcePushes?.[n] ?? []).map(node) } }]));
	out(JSON.stringify({ data: { repository } }));
} else if (a === 'api') {
	const ep = args.slice(1).find((x) => x.startsWith('repos/'));
	let m;
	// Two approvals: the Coordinator's (approved) and its memory approval (a context ending in -memory).
	const list = (ctx) => (/-memory$/.test(ctx) ? (s.memoryApproved ??= []) : s.approved);
	const field = (name) => args.flatMap((x, i) => (args[i - 1] === '-f' && x.startsWith(`${name}=`) ? [x.slice(name.length + 1)] : []))[0] ?? '';
	if ((m = ep.match(/commits\/(\w+)\/statuses$/))) {
		const jq = args[args.indexOf('--jq') + 1];
		const ctx = jq.match(/\.context=="([^"]+)"/)?.[1] ?? '';
		const ok = list(ctx).includes(m[1]);
		// With the description asked for: memoryDesc[sha], or the wording foreman approve --memory writes.
		out(!ok ? '' : jq.includes('.description') ? `success ${s.memoryDesc?.[m[1]] ?? 'Memory approved by foreman approve'}` : 'success');
	} else if ((m = ep.match(/\/statuses\/(\w+)$/))) {
		if (field('context') === s.failStatus) { process.stderr.write('fake gh: HTTP 502\n'); process.exit(1); } // failStatus: that write fails.
		list(field('context')).push(m[1]);
		if (/-memory$/.test(field('context'))) (s.memoryDesc ??= {})[m[1]] = field('description');
		save();
	}
	else if ((m = ep.match(/commits\/(\w+)\/check-runs$/)) && args.includes('-f')) {
		const name = args[args.indexOf('-f') + 1].replace(/^check_name=/, '');
		out(name === (s.checkName ?? 'verify') ? s.verify[m[1]] ?? '' : '');
	} else if ((m = ep.match(/commits\/(\w+)\/check-runs$/))) { if (s.failed[m[1]]) out(s.failed[m[1]].split(', ').join('\n')); }
	else if (/\/pulls\/\d+\/files$/.test(ep)) { s.calls = [...(s.calls ?? []), args.join(' ')]; save(); if (s.prFilesFail) process.exit(1); out((s.prFiles ?? []).join('\n')); } // Every file, past gh pr list's 100.
	else { process.stderr.write(`fake gh: unexpected api call ${ep}\n`); process.exit(2); }
} else if (a === 'pr' && b === 'view') {
	const json = args[args.indexOf('--json') + 1];
	if (json === 'state') out(s.merged ? 'MERGED' : s.pr.state);
	else if (json === 'headRefOid') out(args.includes('--jq') ? s.pr.head : JSON.stringify({ headRefOid: s.pr.head }));
	else out(`${s.pr.state} ${s.pr.isDraft} ${s.pr.head} ${s.pr.mergeable}`);
} else if (a === 'pr' && b === 'list') {
	s.calls = [...(s.calls ?? []), args.join(' ')];
	save();
	out(JSON.stringify(args.includes('open') ? s.openPrs ?? [] : s.mergedPrs ?? []));
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
