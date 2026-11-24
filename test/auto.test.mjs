/**
 * `foreman auto-approve`: which changes a rule lets through (checkChange), the config rules, and approving and
 * merging a version-only PR against a real git repo and a fake gh.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { autoApprove, checkAuthors, checkChange, compareVersions, parseDiff } from '../lib/auto.mjs';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); temps.push(d); return d; };

const RULE = {
	name: 'version pins',
	branch: 'deps/.+',
	files: { 'versions.json': '\\s*"[\\w-]+": "[\\d.]+",?', 'Dockerfile': 'FROM node:[\\d.]+-slim' },
};
const file = (path, lines, extra = {}) => ({ path, status: 'M', binary: false, lines, ...extra });

test('checkChange: only listed files, only edited, every changed line matching its pattern', () => {
	const ok = { files: [file('versions.json', ['-  "left-pad": "1.2.0",', '+  "left-pad": "1.3.0",']), file('Dockerfile', ['-FROM node:22.1-slim', '+FROM node:22.2-slim'])] };
	assert.equal(checkChange(RULE, ok), '');
	assert.match(checkChange(RULE, { files: [] }), /changes nothing/);
	assert.match(checkChange(RULE, { files: [...ok.files, file('app.js', ['+evil()'])] }), /app\.js, which the rule doesn't cover/);
	assert.match(checkChange(RULE, { files: [file('versions.json', ['+  "left-pad": "1.3.0",', '+  "postinstall": "curl x | sh",'])] }), /isn't one the rule allows: \+  "postinstall"/);
	assert.match(checkChange(RULE, { files: [file('versions.json', [], { status: 'D' })] }), /deletes versions\.json/);
	assert.match(checkChange(RULE, { files: [file('versions.json', [], { status: 'A' })] }), /adds versions\.json/);
	assert.match(checkChange(RULE, { files: [file('versions.json', [], { binary: true })] }), /binary/);
	assert.match(checkChange(RULE, { files: [file('constructor', ['+x'])] }), /doesn't cover/, 'no inherited keys');
	assert.match(checkChange(RULE, { files: [file('Dockerfile', [], { modeChange: '100644 → 100755' })] }), /file mode of Dockerfile/);
	assert.match(checkChange(RULE, { files: [file('Dockerfile', ['-FROM node:22.1-slim', '+FROM node:22.2-slim'], { mode: '120000' })] }), /isn't a regular file/);
	assert.match(checkChange(RULE, { files: [file('Dockerfile', ['-Subproject commit 1', '+Subproject commit 2'], { mode: '160000' })] }), /Dockerfile is a submodule \(a gitlink\)/);
});

test('checkChange: patterns match the whole line, not part of it', () => {
	assert.match(checkChange(RULE, { files: [file('Dockerfile', ['+FROM node:22.2-slim AS x', '-FROM node:22.1-slim'])] }), /isn't one the rule allows: \+FROM node:22\.2-slim AS x/);
	assert.match(checkChange(RULE, { files: [file('versions.json', ['+  "left-pad": "1.3.0", "postinstall": "curl x | sh"'])] }), /isn't one the rule allows/);
});

test('parseDiff: changed lines come from hunks only, whatever they start with', () => {
	const diff = [
		'diff --git a/versions.json b/versions.json', 'index 1111111..2222222 100644', '--- a/versions.json', '+++ b/versions.json',
		'@@ -2 +2,2 @@', '-  "left-pad": "1.2.0"', '+  "left-pad": "1.3.0"', '+++ evil', '--- gone',
		'diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755',
		'diff --git a/logo.png b/logo.png', 'index 3333333..4444444 100644', 'Binary files a/logo.png and b/logo.png differ',
		'diff --git a/new.txt b/new.txt', 'new file mode 100644', 'index 0000000..5555555', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+hi',
		'diff --git a/sub b/sub', 'index 1111111..2222222 160000', '--- a/sub', '+++ b/sub', '@@ -1 +1 @@', '-Subproject commit 1111111', '+Subproject commit 2222222',
		'diff --git a/with space b/with space', 'deleted file mode 100644', 'index 6666666..0000000', '--- a/with space', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye', '',
	].join('\n');
	assert.deepEqual(parseDiff(diff).files, [
		{ path: 'versions.json', status: 'M', binary: false, modeChange: '', mode: '100644', lines: ['-  "left-pad": "1.2.0"', '+  "left-pad": "1.3.0"', '+++ evil', '--- gone'] },
		{ path: 'run.sh', status: 'M', binary: false, modeChange: '100644 → 100755', mode: '', lines: [] },
		{ path: 'logo.png', status: 'M', binary: true, modeChange: '', mode: '100644', lines: [] },
		{ path: 'new.txt', status: 'A', binary: false, modeChange: '', mode: '100644', lines: ['+hi'] },
		{ path: 'sub', status: 'M', binary: false, modeChange: '', mode: '160000', lines: ['-Subproject commit 1111111', '+Subproject commit 2222222'] },
		{ path: 'with space', status: 'D', binary: false, modeChange: '', mode: '100644', lines: ['-bye'] },
	]);
});

test('checkChange with versionsOnly: a line may only change its versions, and only upwards', () => {
	const strict = { ...RULE, versionsOnly: true };
	const bump = (from, to) => checkChange(strict, { files: [file('versions.json', [`-  "left-pad": "${from}",`, `+  "left-pad": "${to}",`])] });
	assert.equal(bump('1.2.0', '1.10.3'), '');
	assert.equal(bump('6.18.3', '6.18.4.1'), '', 'a version gaining a part');
	assert.equal(bump('7.2', '7.2.1'), '');
	assert.equal(bump('6.18.4.1', '6.19'), '', 'and losing one');
	assert.match(bump('1.3.0', '1.2.9'), /goes from 1\.3\.0 to 1\.2\.9, which isn't an upgrade/, 'a rollback');
	assert.match(bump('7.2.1', '7.2'), /isn't an upgrade/);
	assert.match(bump('7.2', '7.2.0'), /isn't an upgrade/, 'the same version written differently');
	// Two versions on one line: each that changed must go up.
	const two = (to) => checkChange({ ...strict, files: { 'a.txt': '.*' } }, { files: [file('a.txt', ['-core 7.1 plugin 6.18', `+core ${to}`])] });
	assert.equal(two('7.2 plugin 6.18'), '');
	assert.match(two('7.2 plugin 6.17'), /goes from 6\.18 to 6\.17/);
	assert.match(checkChange(strict, { files: [file('versions.json', ['-  "left-pad": "1.2.0",', '+  "evil-pad": "1.2.1",'])] }), /more than version numbers/, 'a swapped name');
	assert.match(checkChange(strict, { files: [file('versions.json', ['+  "extra": "1.0.0",'])] }), /more than version numbers/, 'a line only added');
	assert.equal(checkChange(RULE, { files: [file('versions.json', ['-  "left-pad": "1.2.0",', '+  "evil-pad": "1.2.1",'])] }), '', 'without it, the line pattern alone decides');
});

test('compareVersions: part by part, a missing part counting as 0', () => {
	assert.deepEqual([compareVersions('1.10', '1.9'), compareVersions('7.2', '7.2.0'), compareVersions('7.2', '7.2.1'), compareVersions('99999999999999999999', '99999999999999999998')], [1, 0, -1, 1]);
});

test('checkAuthors: only the trusted accounts open the PR and make its commits', () => {
	const bot = { login: 'github-actions[bot]' };
	const pr = { author: { login: 'app/github-actions', is_bot: true } };
	const commit = (author, committer = author, email = '') => ({ sha: 'abcdef1234', author, committer, commit: { author: { email }, committer: { email } } });
	assert.equal(checkAuthors(RULE, pr, [commit(bot)]), '', "by default GitHub Actions' bot, however it's written");
	assert.match(checkAuthors(RULE, { author: { login: 'mallory' } }, [commit(bot)]), /opened by mallory, not github-actions\[bot\]/);
	assert.match(checkAuthors(RULE, pr, [commit(bot), commit({ login: 'mallory' })]), /commit abcdef1's author is mallory/);
	assert.match(checkAuthors(RULE, pr, [commit(bot, { login: 'mallory' })]), /committer is mallory/);
	assert.match(checkAuthors(RULE, pr, [commit(null, null, 'x@y')]), /author is x@y \(no GitHub account\)/);
	const renovate = { ...RULE, authors: ['app/renovate', 'alice'] };
	assert.equal(checkAuthors(renovate, { author: { login: 'alice' } }, [commit({ login: 'renovate[bot]' }, { login: 'alice' })]), '');
	assert.match(checkAuthors(renovate, pr, [commit(bot)]), /opened by github-actions\[bot\], not renovate\[bot\] or alice/);
});

test('config: autoApprove rules are checked', () => {
	const dir = temp('foreman-config-');
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ autoApprove: [{ name: '', branch: '(', files: {} }] }));
	assert.throws(() => loadConfig(dir), (e) => /autoApprove\[0\]\.name/.test(e.message) && /\.branch/.test(e.message) && /\.files/.test(e.message));
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ autoApprove: [{ ...RULE, files: { a: 'x)|(.*' } }] }));
	assert.throws(() => loadConfig(dir), /autoApprove\[0\]\.files\["a"\]/, "a pattern can't close the anchors it's wrapped in");
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ autoApprove: [{ ...RULE, authors: [] }] }));
	assert.throws(() => loadConfig(dir), /autoApprove\[0\]\.authors/);
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ autoApprove: [RULE] }));
	assert.equal(loadConfig(dir).autoApprove[0].name, 'version pins');
	assert.deepEqual(DEFAULTS.autoApprove, [], 'off unless a repo asks for it');
});

// ---- against a real repo and a fake gh ----

const bin = temp('foreman-bin-');
copyFileSync(join(ROOT, 'test/fake-gh.mjs'), join(bin, 'gh'));
chmodSync(join(bin, 'gh'), 0o755);

function repo({ branch = 'deps/2026-10-30', change = '  "left-pad": "1.3.0"\n', verify = 'success', chmod = false, runs = [], rules = [RULE], config = {}, gh = {}, author, prep = {} } = {}) {
	const dir = temp('foreman-auto-');
	const origin = join(dir, 'origin.git'), work = join(dir, 'work');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
	execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
	const git = (...a) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
	const commit = (f, body, x = false) => {
		writeFileSync(join(work, f), body);
		if (x) chmodSync(join(work, f), 0o755);
		git('add', '--', f); git('commit', '-q', '-m', f); return git('rev-parse', 'HEAD');
	};
	git('symbolic-ref', 'HEAD', 'refs/heads/main');
	prep.base?.(git);
	commit('versions.json', '{\n  "left-pad": "1.2.0"\n}\n');
	git('push', '-q', 'origin', 'main');
	git('checkout', '-q', '-b', branch);
	prep.branch?.(git);
	const pr = commit('versions.json', `{\n${change}}\n`, chmod);
	git('push', '-q', 'origin', branch, `${pr}:refs/pull/7/head`);
	git('checkout', '-q', 'main');
	commit('README.md', 'main moves on\n');
	git('push', '-q', 'origin', 'main');
	const stateFile = join(dir, 'gh.json');
	writeFileSync(stateFile, JSON.stringify({ repo: 'o/r', origin, pr: { state: 'OPEN', isDraft: false, head: pr, mergeable: 'MERGEABLE', branch, author }, approved: [], verify: { [pr]: verify }, failed: {}, checksPass: true, merged: false, runs, ...(typeof gh === 'function' ? gh(pr) : gh) }));
	process.env.PATH = `${bin}:${process.env.PATH.split(':').filter((p) => p !== bin).join(':')}`;
	process.env.FAKE_GH_STATE = stateFile;
	process.env.FOREMAN_LOCK_WAIT = '1';
	process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
	process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
	const conf = { ...DEFAULTS, autoApprove: rules, root: work, ...config };
	const branchOnOrigin = () => execFileSync('git', ['-C', origin, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
	return { config: conf, pr, work, branchOnOrigin, git, state: () => JSON.parse(readFileSync(stateFile, 'utf8')) };
}

test('auto-approve --merge: a version-only PR whose check passed is approved, rebased and merged', async () => {
	const t = repo();
	const said = [];
	assert.equal(await autoApprove(t.config, { merge: true, log: (m) => said.push(m) }), 0, said.join('\n'));
	assert.ok(t.state().approved.includes(t.pr), 'approved at the head that was checked');
	assert.equal(t.state().merged, true, said.join('\n'));
});

test('auto-approve: anything outside the rule, or a check not yet passed, is left for a person', async () => {
	for (const [opts, reason] of [
		[{ change: '  "left-pad": "1.3.0",\n  "scripts": "rm -rf /"\n' }, /isn't one the rule allows/],
		[{ verify: 'failure' }, /checks failed on \w+: verify/],
		[{ verify: '' }, /verify hasn't passed/],
		// Every check on the head counts, not only the required one: another failed, a re-run still going, a pending status.
		[{ gh: (sha) => ({ failed: { [sha]: 'lint' } }) }, /checks failed on \w+: lint/],
		[{ gh: (sha) => ({ checks: { [sha]: [{ id: 1, name: 'verify', status: 'completed', conclusion: 'success' }, { id: 2, name: 'verify', status: 'in_progress', conclusion: null }] } }) }, /still running on \w+: verify/],
		[{ gh: (sha) => ({ statuses: { [sha]: [{ context: 'deploy-preview', state: 'pending' }] } }) }, /still running on \w+: deploy-preview/],
		[{ gh: (sha) => ({ checks: { [sha]: [{ id: 2, name: 'verify', status: 'completed', conclusion: 'failure' }, { id: 1, name: 'verify', status: 'completed', conclusion: 'success' }] } }) }, /checks failed on \w+: verify/], // The newest run counts.
		// Only GitHub Actions' bot (by default) may open it and make its commits.
		[{ author: { login: 'mallory' } }, /opened by mallory/],
		[{ gh: (sha) => ({ prCommits: [{ sha, author: { login: 'github-actions[bot]' }, committer: { login: 'mallory' } }] }) }, /committer is mallory/],
		[{ gh: (sha) => ({ prCommits: [{ sha: 'aaaaaaa1', author: { login: 'mallory' }, committer: { login: 'mallory' } }, { sha, author: { login: 'github-actions[bot]' }, committer: { login: 'github-actions[bot]' } }] }) }, /commit aaaaaaa's author is mallory/],
		[{ change: '  "left-pad": "1.1.0"\n', rules: [{ ...RULE, versionsOnly: true }] }, /goes from 1\.2\.0 to 1\.1\.0, which isn't an upgrade/], // A rollback.
		[{ change: '  "left-pad": "1.3.0"\n++ evil\n' }, /isn't one the rule allows: \+\+\+ evil/], // A line '++ evil' added (shown as '+++ evil').
		[{ change: '  "left-pad": "1.2.0"\n', chmod: true }, /file mode of versions\.json \(100644 → 100755\)/], // Only made executable.
		[{ change: '  "left-pad": "1.3.0", "x": "1"\n' }, /isn't one the rule allows/], // Contains a version, but is more.
		[{ branch: 'feature/x' }, /No open PR matches/],
		[{ branch: 'not-deps/x' }, /No open PR matches/], // The branch pattern is anchored too.
	]) {
		const t = repo(opts);
		const said = [];
		await autoApprove(t.config, { merge: true, log: (m) => said.push(m) });
		assert.match(said.join('\n'), reason);
		assert.deepEqual([t.state().approved, t.state().merged], [[], false], said.join('\n'));
	}
});

test('auto-approve: every rule whose branch matches gets a try', async () => {
	const dockerOnly = { name: 'base image', branch: 'deps/.+', files: { Dockerfile: 'FROM node:[\\d.]+-slim' } };
	const t = repo({ rules: [dockerOnly, RULE] });
	const said = [];
	assert.equal(await autoApprove(t.config, { log: (m) => said.push(m) }), 0, said.join('\n'));
	assert.match(said.join('\n'), /Approved PR #7 at \w+: version pins/);
	assert.ok(t.state().approved.includes(t.pr));

	const u = repo({ rules: [dockerOnly, { ...RULE, name: 'strict', versionsOnly: true }], change: '  "evil-pad": "1.3.0"\n' });
	const heard = [];
	await autoApprove(u.config, { log: (m) => heard.push(m) });
	assert.match(heard.join('\n'), /base image: it changes versions\.json, which the rule doesn't cover; strict: versions\.json changes more than version numbers/);
	assert.deepEqual(u.state().approved, []);
});

test("auto-approve --merge: approves but doesn't merge while the base branch's CI is red", async () => {
	const t = repo({ runs: [{ workflowName: 'Verify', status: 'completed', conclusion: 'failure', event: 'push', databaseId: 1 }] });
	const said = [];
	assert.equal(await autoApprove(t.config, { merge: true, log: (m) => said.push(m) }), 0, said.join('\n'));
	assert.match(said.join('\n'), /Not merging it yet: main's CI is failing \(Verify\)\. The next run .* merges it once main is green/);
	assert.ok(t.state().approved.includes(t.pr));
	assert.equal(t.state().merged, false);
	assert.equal(t.branchOnOrigin(), t.pr, 'not rebased either');
	// A hand-started run counts too: one that passed after the failed push means main is green again.
	const u = repo({ runs: [{ workflowName: 'Verify', status: 'completed', conclusion: 'success', event: 'workflow_dispatch', databaseId: 2 }, { workflowName: 'Verify', status: 'completed', conclusion: 'failure', event: 'push', databaseId: 1 }] });
	const heard = [];
	assert.equal(await autoApprove(u.config, { merge: true, log: (m) => heard.push(m) }), 0, heard.join('\n'));
	assert.equal(u.state().merged, true, heard.join('\n'));
});

test('auto-approve: an approval already on the head is not posted again', async () => {
	const t = repo();
	const said = [];
	await autoApprove(t.config, { log: (m) => said.push(m) });
	await autoApprove(t.config, { log: (m) => said.push(m) });
	assert.deepEqual(t.state().approved, [t.pr], said.join('\n'));
	assert.match(said.join('\n'), /PR #7 is already approved at/);
});

test('auto-approve without a requiredCheck: every check on the exact head must be green', async () => {
	const t = repo({ config: { requiredCheck: '' }, gh: (sha) => ({ checks: { [sha]: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] } }) });
	const said = [];
	await autoApprove(t.config, { log: (m) => said.push(m) });
	assert.deepEqual(t.state().approved, [t.pr], said.join('\n'));
	const u = repo({ config: { requiredCheck: '' }, verify: '' });
	await autoApprove(u.config, { log: (m) => said.push(m) });
	assert.match(said.join('\n'), /no checks have run on/);
	assert.deepEqual(u.state().approved, []);
});

test('auto-approve --merge: a PR that would wait for its rebased head\'s own checks is left, with the reason', async () => {
	const t = repo({ config: { staleCheckPaths: ['README.md'] } }); // main changed README.md after the PR branched.
	const said = [];
	assert.equal(await autoApprove(t.config, { merge: true, log: (m) => said.push(m) }), 1, said.join('\n'));
	assert.match(said.join('\n'), /needs its checks re-run on the rebased head \(main changed README\.md since \w+ was checked\).*a person or agent must push or re-run/);
	assert.equal(t.state().merged, false);
	assert.equal(t.branchOnOrigin(), t.pr, "not rebased: that push would start no checks");

	const u = repo({ config: { staleCheckPaths: ['docs/'] } }); // Unchanged on main: the approved commit's check carries over.
	const heard = [];
	assert.equal(await autoApprove(u.config, { merge: true, log: (m) => heard.push(m) }), 0, heard.join('\n'));
	assert.equal(u.state().merged, true, heard.join('\n'));

	// No required check whose result could carry over (merge.sh decides, through its --would-wait mode).
	const v = repo({ config: { requiredCheck: '' } });
	const v1 = [];
	assert.equal(await autoApprove(v.config, { merge: true, log: (m) => v1.push(m) }), 1, v1.join('\n'));
	assert.match(v1.join('\n'), /\(there is no required check whose result carries over\)/);
	assert.equal(v.state().merged, false);

	// A change merge.sh counts as docs only waits for no checks at all, stale paths or not.
	const w = repo({ config: { staleCheckPaths: ['README.md'], docsOnly: '\\.json$' } });
	const w1 = [];
	assert.equal(await autoApprove(w.config, { merge: true, log: (m) => w1.push(m) }), 0, w1.join('\n'));
	assert.equal(w.state().merged, true, w1.join('\n'));
});

test('auto-approve: a submodule (gitlink) change is refused, even in a covered file', async () => {
	const gitlink = (sha) => (git) => git('update-index', '--add', '--cacheinfo', `160000,${sha},sub`);
	const t = repo({ rules: [{ ...RULE, files: { ...RULE.files, sub: '.*' } }], prep: { base: gitlink('1'.repeat(40)), branch: gitlink('2'.repeat(40)) } });
	const said = [];
	await autoApprove(t.config, { log: (m) => said.push(m) });
	assert.match(said.join('\n'), /sub is a submodule \(a gitlink\), which is never auto-approved/);
	assert.deepEqual(t.state().approved, []);
});

test('auto-approve --merge: a rebased head that then fails to merge is reported, its checks started, and the run fails', async () => {
	const verifyRun = [{ workflowName: 'Verify', event: 'push', status: 'completed', conclusion: 'success', databaseId: 1 }];
	const t = repo({ runs: verifyRun, gh: { mergeFails: true } });
	const said = [];
	assert.equal(await autoApprove(t.config, { merge: true, log: (m) => said.push(m) }), 1, said.join('\n'));
	assert.notEqual(t.branchOnOrigin(), t.pr, 'it was rebased and pushed');
	assert.match(said.join('\n'), /Rebased PR #7 but couldn't merge it: its new head has no checks; started Verify on it .* or run foreman tick\./);
	assert.deepEqual(t.state().dispatched, ['Verify --ref deps/2026-10-30']);

	const u = repo({ gh: { mergeFails: true, dispatchFails: false } }); // No run says which workflow makes verify.
	const heard = [];
	assert.equal(await autoApprove(u.config, { merge: true, log: (m) => heard.push(m) }), 1);
	assert.match(heard.join('\n'), /Couldn't start the checks on PR #7's new head: no workflow is known to make verify \(set baseWorkflows\)/);
	assert.match(heard.join('\n'), /re-run verify on it or run foreman tick/);
});

test('auto-approve: a later run says the same of a head with no checks whose previous head it approved', async () => {
	const before = (description) => [{ beforeCommit: { oid: 'a'.repeat(40), statusCheckRollup: { state: 'SUCCESS' }, status: { contexts: [{ context: 'coordinator-review', state: 'SUCCESS', description }] } } }];
	const t = repo({ verify: '', gh: { forcePushes: before('Auto-approved: version pins') } });
	const said = [];
	assert.equal(await autoApprove(t.config, { merge: true, log: (m) => said.push(m) }), 1);
	assert.match(said.join('\n'), /Rebased PR #7 but couldn't merge it: its new head has no checks; re-run verify on it or run foreman tick/);

	const u = repo({ verify: '', gh: { forcePushes: before('Approved by the Coordinator') } }); // Someone else's approval: the usual reason.
	const heard = [];
	assert.equal(await autoApprove(u.config, { merge: true, log: (m) => heard.push(m) }), 0);
	assert.match(heard.join('\n'), /not auto-approved: verify hasn't passed/);
});

test('auto-approve --merge: tells the workflow which PRs it merged ($GITHUB_OUTPUT)', async () => {
	const t = repo();
	const output = join(temp('foreman-out-'), 'out');
	process.env.GITHUB_OUTPUT = output;
	try {
		await autoApprove(t.config, { merge: true, log: () => {} });
	} finally {
		delete process.env.GITHUB_OUTPUT;
	}
	assert.equal(readFileSync(output, 'utf8'), 'merged=7\n');
});

test('auto-approve --dry-run changes nothing, and reads the change from GitHub', async () => {
	const t = repo();
	const before = t.git('rev-parse', 'origin/main~1');
	t.git('update-ref', 'refs/remotes/origin/main', before); // So a fetch would show.
	const said = [];
	await autoApprove(t.config, { merge: true, dryRun: true, log: (m) => said.push(m) });
	assert.match(said.join('\n'), /would approve PR #7 at \w+ \(version pins\) and merge it/);
	assert.deepEqual([t.state().approved, t.state().merged], [[], false]);
	assert.equal(t.git('rev-parse', 'origin/main'), before, "origin/main didn't move: nothing was fetched");
	assert.equal(t.git('for-each-ref', 'refs/foreman/'), '', 'no refs left or made');

	for (const [opts, reason] of [
		[{ change: '  "left-pad": "1.3.0"\n++ evil\n' }, /isn't one the rule allows: \+\+\+ evil/],
		[{ change: '  "left-pad": "1.2.0"\n', chmod: true }, /file mode of versions\.json/],
		[{ change: '  "left-pad": "1.1.0"\n', rules: [{ ...RULE, versionsOnly: true }] }, /isn't an upgrade/],
	]) {
		const u = repo(opts);
		const heard = [];
		await autoApprove(u.config, { dryRun: true, log: (m) => heard.push(m) });
		assert.match(heard.join('\n'), reason);
	}
});
