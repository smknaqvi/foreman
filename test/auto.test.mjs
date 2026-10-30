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
import { autoApprove, checkChange } from '../lib/auto.mjs';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); temps.push(d); return d; };

const RULE = {
	name: 'version pins',
	branch: '^deps/',
	files: { 'versions.json': '^\\s*"[\\w-]+": "[\\d.]+",?$', 'Dockerfile': '^FROM node:[\\d.]+-slim$' },
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
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ autoApprove: [RULE] }));
	assert.equal(loadConfig(dir).autoApprove[0].name, 'version pins');
	assert.deepEqual(DEFAULTS.autoApprove, [], 'off unless a repo asks for it');
});

// ---- against a real repo and a fake gh ----

const bin = temp('foreman-bin-');
copyFileSync(join(ROOT, 'test/fake-gh.mjs'), join(bin, 'gh'));
chmodSync(join(bin, 'gh'), 0o755);

function repo({ branch = 'deps/2026-10-30', change = '  "left-pad": "1.3.0"\n', verify = 'success' } = {}) {
	const dir = temp('foreman-auto-');
	const origin = join(dir, 'origin.git'), work = join(dir, 'work');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
	execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
	const git = (...a) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
	const commit = (f, body) => { writeFileSync(join(work, f), body); git('add', '-A'); git('commit', '-q', '-m', f); return git('rev-parse', 'HEAD'); };
	git('symbolic-ref', 'HEAD', 'refs/heads/main');
	commit('versions.json', '{\n  "left-pad": "1.2.0"\n}\n');
	git('push', '-q', 'origin', 'main');
	git('checkout', '-q', '-b', branch);
	const pr = commit('versions.json', `{\n${change}}\n`);
	git('push', '-q', 'origin', branch, `${pr}:refs/pull/7/head`);
	git('checkout', '-q', 'main');
	commit('README.md', 'main moves on\n');
	git('push', '-q', 'origin', 'main');
	const stateFile = join(dir, 'gh.json');
	writeFileSync(stateFile, JSON.stringify({ repo: 'o/r', origin, pr: { state: 'OPEN', isDraft: false, head: pr, mergeable: 'MERGEABLE', branch }, approved: [], verify: { [pr]: verify }, failed: {}, checksPass: true, merged: false }));
	process.env.PATH = `${bin}:${process.env.PATH.split(':').filter((p) => p !== bin).join(':')}`;
	process.env.FAKE_GH_STATE = stateFile;
	process.env.FOREMAN_LOCK_WAIT = '1';
	process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
	process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
	const config = { ...DEFAULTS, autoApprove: [RULE], root: work };
	return { config, pr, state: () => JSON.parse(readFileSync(stateFile, 'utf8')) };
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
		[{ branch: 'feature/x' }, /No open PR matches/],
	]) {
		const t = repo(opts);
		const said = [];
		await autoApprove(t.config, { merge: true, log: (m) => said.push(m) });
		assert.match(said.join('\n'), reason);
		assert.deepEqual([t.state().approved, t.state().merged], [[], false], said.join('\n'));
	}
});

test('auto-approve --dry-run changes nothing', async () => {
	const t = repo();
	const said = [];
	await autoApprove(t.config, { merge: true, dryRun: true, log: (m) => said.push(m) });
	assert.match(said.join('\n'), /would approve PR #7/);
	assert.deepEqual([t.state().approved, t.state().merged], [[], false]);
});
