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

/**
 * An origin with main at one commit (plus `base` files), a clone to work in, and a PR (#7) whose branch
 * (`branch`, "feature" by default) adds `files`.
 */
function setup(files = { 'app.txt': 'feature\n' }, { base = {} } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'foreman-merge-'));
	temps.push(dir);
	const origin = join(dir, 'origin.git'), work = join(dir, 'work');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
	execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
	const git = (...a) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
	const commit = (changes, msg) => {
		for (const [f, body] of Object.entries(changes)) {
			if (body === null) { rmSync(join(work, f)); continue; } // null: delete the file.
			mkdirSync(join(work, f, '..'), { recursive: true });
			writeFileSync(join(work, f), body);
		}
		git('add', '-A');
		git('commit', '-q', '-m', msg);
		return git('rev-parse', 'HEAD');
	};
	git('symbolic-ref', 'HEAD', 'refs/heads/main');
	commit({ 'README.md': 'hello\n', 'baselines/a.txt': '1\n', ...base }, 'base');
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
	const run = (script, args, config, sub = '') => {
		const r = spawnSync('bash', [join(ROOT, `scripts/${script}.sh`), ...args], {
			cwd: join(work, sub), // sub: run from a subfolder holding the config.
			encoding: 'utf8',
			env: { ...process.env, ...scriptEnv({ ...DEFAULTS, ...config }), PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: stateFile, FOREMAN_LOCK_WAIT: '1' },
		});
		const now = JSON.parse(readFileSync(stateFile, 'utf8'));
		Object.assign(state, now);
		return { code: r.status, out: r.stdout + r.stderr, merged: now.merged };
	};
	const merge = (args, config = {}, sub = '') => run('merge', ['7', ...args], config, sub);
	const approve = (args, config = {}, sub = '') => run('approve', ['7', ...args], config, sub);
	return { state, save, pr, advanceMain, rebase, merge, approve };
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

// The shared memory: a PR that changes it merges only with the Coordinator's memory approval
// (foreman approve --memory), once the base has its index (or for the PR that adds the index).
const withMemory = { base: { 'memory/MEMORY.md': '# Memory\n\n## Notes\n\n- [A](a.md) — a\n', 'memory/a.md': '---\nname: a\ndescription: a\ntype: project\n---\n' } };
const REFUSED = /This PR changes memory\/: only the Coordinator's memory PRs merge it \(approved with foreman approve --memory\)\. Put it in the PR's 'Memory updates' section instead\./;

test('refuses a PR that changes the memory without the memory approval, docs-only (no checks to wait for) or not', () => {
	for (const files of [{ 'memory/b.md': 'new fact\n' }, { 'memory/a.md': 'edited\n', 'app.txt': 'code\n' }, { 'memory/a.md': null }]) {
		const t = setup(files, withMemory);
		t.state.approved.push(t.pr); t.state.verify[t.pr] = 'success'; t.save();
		const r = t.merge([]);
		assert.equal(r.merged, false, r.out);
		assert.match(r.out, REFUSED);
		assert.match(r.out, /PR #7 changes memory\/(a|b)\.md/);
	}
});

test('matches memory files whatever their names: non-ASCII ones too', () => {
	const t = setup({ 'memory/café.md': 'x\n', 'docs/naïve.md': 'y\n' }, withMemory);
	t.state.approved.push(t.pr); t.save();
	const r = t.merge([]);
	assert.equal(r.merged, false, r.out);
	assert.match(r.out, /PR #7 changes memory\/café\.md/);
});

test('merges a memory change the Coordinator approved with --memory, and carries that over a clean rebase', () => {
	const t = setup({ 'memory/b.md': 'new fact\n' }, withMemory);
	t.state.approved.push(t.pr); t.state.memoryApproved = [t.pr]; t.state.checksPass = false; t.save();
	t.advanceMain({ 'other.txt': 'x\n' });
	const head = t.rebase();
	const r = t.merge(['--rebased-from', t.pr]);
	assert.equal(r.merged, true, r.out);
	assert.match(r.out, /only changes documentation/);
	assert.ok(t.state.memoryApproved.includes(head), 'the memory approval is recorded on the rebased commit');

	// The memory approval alone merges nothing: the PR still needs its ordinary approval.
	const u = setup({ 'memory/b.md': 'x\n' }, withMemory);
	u.state.memoryApproved = [u.pr]; u.save();
	assert.match(u.merge([]).out, /isn't approved/);
});

test('foreman approve --memory: both approvals on a memory PR; refused for a PR that leaves the memory alone', () => {
	const t = setup({ 'memory/b.md': 'new fact\n' }, withMemory);
	const r = t.approve([t.pr, '--memory']);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /memory change included/);
	assert.ok(t.state.approved.includes(t.pr) && t.state.memoryApproved.includes(t.pr));
	assert.equal(t.merge([]).merged, true);

	const code = setup({ 'app.txt': 'code\n' }, withMemory);
	const no = code.approve([code.pr, '--memory']);
	assert.equal(no.code, 1);
	assert.match(no.out, /doesn't change the shared memory \(or it isn't set up on main\): approve it without --memory/);
	assert.deepEqual(code.state.approved, [], 'nothing approved');
	assert.equal(code.approve([code.pr]).code, 0, 'a plain approval still works');
	assert.deepEqual(code.state.memoryApproved ?? [], []);
});

test('the memory rule holds once the base has the index, or for the PR adding it; a folder without one is left alone', () => {
	const first = setup({ 'memory/MEMORY.md': '# Memory\n' }); // The PR that sets the memory up (foreman init in an upgrade).
	first.state.approved.push(first.pr); first.save();
	assert.match(first.merge([]).out, REFUSED);
	first.state.memoryApproved = [first.pr]; first.save();
	assert.equal(first.merge([]).merged, true);

	const other = setup({ 'memory/allocator.c': 'int x;\n' }); // memory/ is the repo's own code here.
	other.state.approved.push(other.pr); other.state.verify[other.pr] = 'success'; other.save();
	assert.equal(other.merge([]).merged, true, 'no index on the base: not a foreman memory');
});

test('reads the memory setting from the base branch, so a PR can\'t switch the rule off for itself', () => {
	const sneaky = setup({ 'memory/b.md': 'x\n', 'foreman.config.json': '{"memory":{"dir":""}}\n' }, withMemory);
	sneaky.state.approved.push(sneaky.pr); sneaky.state.verify[sneaky.pr] = 'success'; sneaky.save();
	const r = sneaky.merge([], { memory: { dir: '' } }); // Even with the PR's config in the environment.
	assert.equal(r.merged, false, r.out);
	assert.match(r.out, REFUSED);

	const off = setup({ 'memory/b.md': 'x\n' }, { base: { ...withMemory.base, 'foreman.config.json': '{"memory":{"dir":""}}\n' } });
	off.state.approved.push(off.pr); off.save();
	assert.equal(off.merge([]).merged, true, 'switched off on the base: no rule');

	const moved = setup({ 'notes/b.md': 'x\n' }, { base: { 'foreman.config.json': '{"memory":{"dir":"notes"}}\n', 'notes/MEMORY.md': '# Memory\n' } });
	moved.state.approved.push(moved.pr); moved.save();
	assert.match(moved.merge([]).out, /This PR changes notes\//);

	const broken = setup({ 'memory/b.md': 'x\n' }, { base: { ...withMemory.base, 'foreman.config.json': '{ not json' } });
	broken.state.approved.push(broken.pr); broken.save();
	assert.match(broken.merge([]).out, REFUSED, 'a base config that doesn\'t parse keeps the rule on');
});

test('a config in a subfolder: the memory is that folder\'s, read from the same place on the base', () => {
	const base = { 'packages/app/foreman.config.json': '{}\n', 'packages/app/memory/MEMORY.md': '# Memory\n' };
	const t = setup({ 'packages/app/memory/b.md': 'x\n' }, { base });
	t.state.approved.push(t.pr); t.save();
	const r = t.merge([], {}, 'packages/app');
	assert.equal(r.merged, false, r.out);
	assert.match(r.out, /This PR changes packages\/app\/memory\/: only the Coordinator's memory PRs merge it/);
	assert.equal(t.approve([t.pr, '--memory'], {}, 'packages/app').code, 0);
	assert.equal(t.merge([], {}, 'packages/app').merged, true);

	const top = setup({ 'memory/x.md': 'not the app\'s memory\n' }, { base });
	top.state.approved.push(top.pr); top.save();
	assert.equal(top.merge([], {}, 'packages/app').merged, true, 'memory/ at the top isn\'t this config\'s memory');

	const off = setup({ 'packages/app/memory/b.md': 'x\n' }, { base: { ...base, 'packages/app/foreman.config.json': '{"memory":{"dir":""}}\n' } });
	off.state.approved.push(off.pr); off.save();
	assert.equal(off.merge([], {}, 'packages/app').merged, true, 'switched off in that config on the base');
});

test('approve --memory writes the memory approval first: if the main one then fails, nothing counts as approved', () => {
	const t = setup({ 'memory/b.md': 'new fact\n' }, withMemory);
	t.state.failStatus = 'coordinator-review'; t.save();
	const r = t.approve([t.pr, '--memory']);
	assert.notEqual(r.code, 0);
	assert.deepEqual(t.state.approved, [], 'no main approval');
	delete t.state.failStatus; t.save();
	assert.match(t.merge([]).out, /isn't approved/, 'and merge refuses it');
});
