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
import { autoApprove, checkChange, parseDiff } from '../lib/auto.mjs';
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
		'diff --git a/with space b/with space', 'deleted file mode 100644', 'index 6666666..0000000', '--- a/with space', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye', '',
	].join('\n');
	assert.deepEqual(parseDiff(diff).files, [
		{ path: 'versions.json', status: 'M', binary: false, modeChange: '', mode: '100644', lines: ['-  "left-pad": "1.2.0"', '+  "left-pad": "1.3.0"', '+++ evil', '--- gone'] },
		{ path: 'run.sh', status: 'M', binary: false, modeChange: '100644 → 100755', mode: '', lines: [] },
		{ path: 'logo.png', status: 'M', binary: true, modeChange: '', mode: '100644', lines: [] },
		{ path: 'new.txt', status: 'A', binary: false, modeChange: '', mode: '', lines: ['+hi'] },
		{ path: 'with space', status: 'D', binary: false, modeChange: '', mode: '', lines: ['-bye'] },
	]);
});

test('checkChange with versionsOnly: a line may only change its numbers', () => {
	const strict = { ...RULE, versionsOnly: true };
	assert.equal(checkChange(strict, { files: [file('versions.json', ['-  "left-pad": "1.2.0",', '+  "left-pad": "1.10.3",'])] }), '');
	assert.match(checkChange(strict, { files: [file('versions.json', ['-  "left-pad": "1.2.0",', '+  "evil-pad": "1.2.1",'])] }), /more than version numbers/, 'a swapped name');
	assert.match(checkChange(strict, { files: [file('versions.json', ['+  "extra": "1.0.0",'])] }), /more than version numbers/, 'a line only added');
	assert.equal(checkChange(RULE, { files: [file('versions.json', ['-  "left-pad": "1.2.0",', '+  "evil-pad": "1.2.1",'])] }), '', 'without it, the line pattern alone decides');
});

test('config: autoApprove rules are checked', () => {
	const dir = temp('foreman-config-');
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ autoApprove: [{ name: '', branch: '(', files: {} }] }));
	assert.throws(() => loadConfig(dir), (e) => /autoApprove\[0\]\.name/.test(e.message) && /\.branch/.test(e.message) && /\.files/.test(e.message));
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ autoApprove: [{ ...RULE, files: { a: 'x)|(.*' } }] }));
	assert.throws(() => loadConfig(dir), /autoApprove\[0\]\.files\["a"\]/, "a pattern can't close the anchors it's wrapped in");
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ autoApprove: [RULE] }));
	assert.equal(loadConfig(dir).autoApprove[0].name, 'version pins');
	assert.deepEqual(DEFAULTS.autoApprove, [], 'off unless a repo asks for it');
});

// ---- against a real repo and a fake gh ----

const bin = temp('foreman-bin-');
copyFileSync(join(ROOT, 'test/fake-gh.mjs'), join(bin, 'gh'));
chmodSync(join(bin, 'gh'), 0o755);

function repo({ branch = 'deps/2026-10-30', change = '  "left-pad": "1.3.0"\n', verify = 'success', chmod = false, runs = [], rules = [RULE], config = {} } = {}) {
	const dir = temp('foreman-auto-');
	const origin = join(dir, 'origin.git'), work = join(dir, 'work');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
	execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
	const git = (...a) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
	const commit = (f, body, x = false) => {
		writeFileSync(join(work, f), body);
		if (x) chmodSync(join(work, f), 0o755);
		git('add', '-A'); git('commit', '-q', '-m', f); return git('rev-parse', 'HEAD');
	};
	git('symbolic-ref', 'HEAD', 'refs/heads/main');
	commit('versions.json', '{\n  "left-pad": "1.2.0"\n}\n');
	git('push', '-q', 'origin', 'main');
	git('checkout', '-q', '-b', branch);
	const pr = commit('versions.json', `{\n${change}}\n`, chmod);
	git('push', '-q', 'origin', branch, `${pr}:refs/pull/7/head`);
	git('checkout', '-q', 'main');
	commit('README.md', 'main moves on\n');
	git('push', '-q', 'origin', 'main');
	const stateFile = join(dir, 'gh.json');
	writeFileSync(stateFile, JSON.stringify({ repo: 'o/r', origin, pr: { state: 'OPEN', isDraft: false, head: pr, mergeable: 'MERGEABLE', branch }, approved: [], verify: { [pr]: verify }, failed: {}, checksPass: true, merged: false, runs }));
	process.env.PATH = `${bin}:${process.env.PATH.split(':').filter((p) => p !== bin).join(':')}`;
	process.env.FAKE_GH_STATE = stateFile;
	process.env.FOREMAN_LOCK_WAIT = '1';
	process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
	process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
	const conf = { ...DEFAULTS, autoApprove: rules, root: work, ...config };
	const branchOnOrigin = () => execFileSync('git', ['-C', origin, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
	return { config: conf, pr, branchOnOrigin, state: () => JSON.parse(readFileSync(stateFile, 'utf8')) };
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
		[{ verify: 'failure' }, /hasn't passed/],
		[{ verify: '' }, /hasn't passed/],
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
	const t = repo({ runs: [{ workflowName: 'CI', status: 'completed', conclusion: 'failure', event: 'push' }] });
	const said = [];
	assert.equal(await autoApprove(t.config, { merge: true, log: (m) => said.push(m) }), 0, said.join('\n'));
	assert.match(said.join('\n'), /Not merging it: main's CI is failing \(CI\)/);
	assert.ok(t.state().approved.includes(t.pr));
	assert.equal(t.state().merged, false);
	assert.equal(t.branchOnOrigin(), t.pr, 'not rebased either');
});

test('auto-approve --merge: a PR that would wait for its rebased head\'s own checks is left, with the reason', async () => {
	const t = repo({ config: { staleCheckPaths: ['README.md'] } }); // main changed README.md after the PR branched.
	const said = [];
	assert.equal(await autoApprove(t.config, { merge: true, log: (m) => said.push(m) }), 1, said.join('\n'));
	assert.match(said.join('\n'), /needs its checks re-run on the rebased head \(main changed README\.md since it was checked\).*a person or agent must push or re-run/);
	assert.equal(t.state().merged, false);
	assert.equal(t.branchOnOrigin(), t.pr, "not rebased: that push would start no checks");

	const u = repo({ config: { staleCheckPaths: ['docs/'] } }); // Unchanged on main: the approved commit's check carries over.
	const heard = [];
	assert.equal(await autoApprove(u.config, { merge: true, log: (m) => heard.push(m) }), 0, heard.join('\n'));
	assert.equal(u.state().merged, true, heard.join('\n'));
});

test('auto-approve --dry-run changes nothing', async () => {
	const t = repo();
	const said = [];
	await autoApprove(t.config, { merge: true, dryRun: true, log: (m) => said.push(m) });
	assert.match(said.join('\n'), /would approve PR #7/);
	assert.deepEqual([t.state().approved, t.state().merged], [[], false]);
});
