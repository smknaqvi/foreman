/**
 * The merge gate (scripts/merge.sh) against real git repos and a fake GitHub (test/fake-gh.mjs): it merges
 * exactly what was approved, carries an approval over a clean rebase only, and waits for the right checks.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, scriptEnv } from '../lib/config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

// A fake `gh` on PATH.
const bin = mkdtempSync(join(tmpdir(), 'foreman-bin-'));
temps.push(bin);
copyFileSync(join(ROOT, 'test/fake-gh.mjs'), join(bin, 'gh'));
chmodSync(join(bin, 'gh'), 0o755);

/** An origin with main at one commit, a clone to work in, and a PR (#7) whose branch adds `files`. */
function setup(files = { 'app.txt': 'feature\n' }) {
	const dir = mkdtempSync(join(tmpdir(), 'foreman-merge-'));
	temps.push(dir);
	const origin = join(dir, 'origin.git'), work = join(dir, 'work');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
	execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
	const git = (...a) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
	const commit = (changes, msg) => {
		for (const [f, body] of Object.entries(changes)) { mkdirSync(join(work, f, '..'), { recursive: true }); writeFileSync(join(work, f), body); }
		git('add', '-A');
		git('commit', '-q', '-m', msg);
		return git('rev-parse', 'HEAD');
	};
	git('symbolic-ref', 'HEAD', 'refs/heads/main');
	commit({ 'README.md': 'hello\n', 'baselines/a.txt': '1\n' }, 'base');
	git('push', '-q', 'origin', 'main');
	git('checkout', '-q', '-b', 'feature');
	const pr = commit(files, 'the change');
	const publish = (sha) => { git('push', '-q', '-f', 'origin', `${sha}:refs/pull/7/head`); state.pr.head = sha; save(); };
	const state = { repo: 'o/r', pr: { state: 'OPEN', isDraft: false, head: pr, mergeable: 'MERGEABLE' }, approved: [], verify: {}, failed: {}, checksPass: true, merged: false };
	const stateFile = join(dir, 'gh-state.json');
	const save = () => writeFileSync(stateFile, JSON.stringify(state));
	publish(pr);
	/** Advance main on origin with `changes` (made on a side branch, so the PR branch is untouched). */
	const advanceMain = (changes) => {
		git('checkout', '-q', 'main');
		const sha = commit(changes, 'main moves on');
		git('push', '-q', 'origin', 'main');
		git('checkout', '-q', 'feature');
		return sha;
	};
	const rebase = (extra) => {
		git('fetch', '-q', 'origin');
		git('rebase', '-q', 'origin/main');
		const sha = extra ? commit(extra, 'more') : git('rev-parse', 'HEAD');
		publish(sha);
		return sha;
	};
	const merge = (args, config = {}) => {
		const r = spawnSync('bash', [join(ROOT, 'scripts/merge.sh'), '7', ...args], {
			cwd: work,
			encoding: 'utf8',
			env: { ...process.env, ...scriptEnv({ ...DEFAULTS, ...config }), PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: stateFile, FOREMAN_LOCK_WAIT: '1' },
		});
		const now = JSON.parse(readFileSync(stateFile, 'utf8'));
		Object.assign(state, now);
		return { code: r.status, out: r.stdout + r.stderr, merged: now.merged };
	};
	return { state, save, pr, advanceMain, rebase, merge };
}

test('refuses a PR that was never approved', () => {
	const t = setup();
	const r = t.merge([]);
	assert.equal(r.merged, false);
	assert.match(r.out, /isn't approved/);
});

test('merges an approved PR whose required check passed', () => {
	const t = setup();
	t.state.approved.push(t.pr); t.state.verify[t.pr] = 'success'; t.save();
	const r = t.merge([]);
	assert.equal(r.merged, true, r.out);
});

test('waits until the required check has passed, not just "nothing failed yet"', () => {
	const t = setup();
	t.state.approved.push(t.pr); t.save();
	const r = t.merge([]);
	assert.equal(r.merged, false);
	assert.match(r.out, /hasn't passed/);
});

test('refuses a PR that is behind the base branch', () => {
	const t = setup();
	t.state.approved.push(t.pr); t.state.verify[t.pr] = 'success'; t.save();
	t.advanceMain({ 'other.txt': 'x\n' });
	const r = t.merge([]);
	assert.equal(r.merged, false);
	assert.match(r.out, /behind main/);
});

test('carries an approval over a clean rebase and reuses the approved commit\'s checks', () => {
	const t = setup();
	t.state.approved.push(t.pr); t.state.verify[t.pr] = 'success'; t.save();
	t.advanceMain({ 'other.txt': 'x\n' });
	const head = t.rebase();
	assert.notEqual(head, t.pr);
	const r = t.merge(['--rebased-from', t.pr]);
	assert.equal(r.merged, true, r.out);
	assert.ok(t.state.approved.includes(head), 'the approval is recorded on the rebased commit');
});

test('refuses a "rebase" that also changed the code', () => {
	const t = setup();
	t.state.approved.push(t.pr); t.state.verify[t.pr] = 'success'; t.save();
	t.advanceMain({ 'other.txt': 'x\n' });
	t.rebase({ 'sneaky.txt': 'unreviewed\n' });
	const r = t.merge(['--rebased-from', t.pr]);
	assert.equal(r.merged, false);
	assert.match(r.out, /changed since approval/);
});

test('waits for the rebased commit\'s own checks when a stale-check path changed on the base', () => {
	const t = setup();
	t.state.approved.push(t.pr); t.state.verify[t.pr] = 'success'; t.save();
	t.advanceMain({ 'baselines/a.txt': '2\n' });
	const head = t.rebase();
	const r = t.merge(['--rebased-from', t.pr], { staleCheckPaths: ['baselines/'] });
	assert.equal(r.merged, false);
	assert.match(r.out, new RegExp(`hasn't passed on ${head.slice(0, 7)}`));
	t.state.verify[head] = 'success'; t.save();
	assert.equal(t.merge(['--rebased-from', t.pr], { staleCheckPaths: ['baselines/'] }).merged, true);
});

test('merges a docs-only PR without waiting for checks', () => {
	const t = setup({ 'docs/guide.md': '# Guide\n' });
	t.state.approved.push(t.pr); t.state.checksPass = false; t.save();
	const r = t.merge([]);
	assert.equal(r.merged, true, r.out);
	assert.match(r.out, /only changes documentation/);
});

test('never ignores a check that already failed on the head, even when reusing checks', () => {
	const t = setup();
	t.state.approved.push(t.pr); t.state.verify[t.pr] = 'success'; t.save();
	t.advanceMain({ 'other.txt': 'x\n' });
	const head = t.rebase();
	t.state.failed[head] = 'lint'; t.save();
	const r = t.merge(['--rebased-from', t.pr]);
	assert.equal(r.merged, false);
	assert.match(r.out, /checks failed on .*: lint/);
});

test('refuses drafts and closed PRs', () => {
	const t = setup();
	t.state.approved.push(t.pr); t.state.verify[t.pr] = 'success'; t.state.pr.isDraft = true; t.save();
	assert.match(t.merge([]).out, /is a draft/);
	t.state.pr.isDraft = false; t.state.pr.state = 'CLOSED'; t.save();
	assert.match(t.merge([]).out, /is CLOSED/);
});

test('an empty or unreadable docsOnly pattern never lets a PR skip its checks', () => {
	for (const docsOnly of ['', '[[:alpha:]+']) {
		const t = setup({ 'docs/guide.md': '# Guide\n' });
		t.state.approved.push(t.pr); t.save();
		const r = t.merge([], { docsOnly });
		assert.equal(r.merged, false, `docsOnly ${JSON.stringify(docsOnly)}: ${r.out}`);
		assert.match(r.out, /hasn't passed/);
	}
});

test('a required check whose name has spaces and & is looked up by its exact name', () => {
	const t = setup();
	t.state.approved.push(t.pr); t.state.verify[t.pr] = 'success'; t.state.checkName = 'Build & Test (ubuntu, 20)'; t.save();
	assert.equal(t.merge([], { requiredCheck: 'Build & Test (ubuntu, 20)' }).merged, true);
});
