/**
 * The watchdog's decisions, reading Claude Code transcripts for usage-limit stops, how a session ended, the
 * launchd job, and `foreman tick`'s rebase-and-merge against real git repos and a fake gh.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { agentActivity, limitStop, projectFolder, resetTime } from '../lib/sessions.mjs';
import { rebaseAndMerge } from '../lib/tick.mjs';
import { classify, decide, plist } from '../lib/watchdog.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
// Real paths: on macOS the temp folder is behind a symlink, and git and Claude Code both report the real one.
const temp = (prefix) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); temps.push(d); return d; };

// ---- decide ----

const NOW = Date.parse('2026-10-22T12:00:00Z');
const min = 60000;
const base = {
	now: NOW, paused: false, sessionPid: 0, ready: 0,
	inFlight: { items: ['#12', 'PR #40@abc1234'], key: '#12 PR #40@abc1234' },
	activity: { lastActiveAt: NOW - 20 * min, limited: { at: NOW - 20 * min, text: 'You\'ve hit your session limit', resetsAt: NOW - min } },
	last: null, sessionsToday: 0,
	settings: { ...DEFAULTS.watchdog },
};
const d = (over) => decide({ ...base, ...over });

test('decide: starts a Coordinator after a usage-limit stop once the limit has reset', () => {
	const r = d({});
	assert.equal(r.tick, true);
	assert.equal(r.launch, true, r.why);
});

test('decide: does nothing while paused, while its own Coordinator runs, or with nothing in flight', () => {
	assert.deepEqual([d({ paused: true }), d({ sessionPid: 123 }), d({ inFlight: { items: [], key: '' } })].map((r) => r.tick || r.launch), [false, false, false]);
});

test('decide: before the reset it only merges what is ready', () => {
	const waiting = { activity: { ...base.activity, limited: { ...base.activity.limited, resetsAt: NOW + 60 * min } } };
	assert.deepEqual([d(waiting).tick, d(waiting).launch], [false, false]);
	assert.deepEqual([d({ ...waiting, ready: 2 }).tick, d({ ...waiting, ready: 2 }).launch], [true, false]);
	assert.match(d(waiting).why, /resets/);
});

test('decide: an unreadable reset time means trying again an hour after each stop, not every round', () => {
	const unknown = (minutesAgo) => ({ activity: { lastActiveAt: NOW - minutesAgo * min, limited: { at: NOW - minutesAgo * min, text: 'limit', resetsAt: null } } });
	assert.equal(d(unknown(20)).launch, false);
	assert.equal(d(unknown(61)).launch, true);
});

test('decide: agents still working (no limit stop) are left alone, unless staleMinutes says otherwise', () => {
	const working = { activity: { lastActiveAt: NOW - 5 * min, limited: null } };
	assert.equal(d(working).launch, false);
	assert.equal(d({ ...working, ready: 1 }).tick, false, 'a Builder active 5 min ago merges its own PR');
	const quiet = { activity: { lastActiveAt: NOW - 45 * min, limited: null } };
	assert.equal(d({ ...quiet, ready: 1 }).tick, true, 'quiet for a while: merge what is approved and green');
	assert.equal(d(quiet).launch, false, 'staleMinutes 0: silence alone never starts a Coordinator');
	assert.equal(d({ ...quiet, settings: { ...base.settings, staleMinutes: 30 } }).launch, true);
});

test('decide: a Coordinator that ended normally is not restarted until the work in flight changes', () => {
	const last = { outcome: 'ended', inFlight: base.inFlight.key };
	assert.equal(d({ last }).launch, false);
	assert.equal(d({ last: { ...last, outcome: 'limited' } }).launch, true, 'one that hit the limit is retried');
	assert.equal(d({ last, inFlight: { items: ['#12'], key: '#12' } }).launch, true);
});

test('decide: at most maxSessionsPerDay', () => {
	assert.equal(d({ sessionsToday: 6 }).launch, false);
	assert.equal(d({ sessionsToday: 5 }).launch, true);
});

// ---- transcripts ----

test('resetTime: reads the times Claude Code prints', () => {
	const at = Date.parse('2026-10-22T03:33:00Z'); // 10:33pm in Chicago, Oct 21.
	assert.equal(new Date(resetTime('You\'ve hit your session limit · resets 1:50am (America/Chicago)', at)).toISOString(), '2026-10-22T06:50:00.000Z');
	assert.equal(new Date(resetTime('resets 11:50am (America/Chicago)', at)).toISOString(), '2026-10-22T16:50:00.000Z');
	assert.equal(new Date(resetTime('You\'ve hit your weekly limit · resets Oct 27, 9am (America/Chicago)', at)).toISOString(), '2026-10-27T14:00:00.000Z');
	assert.equal(new Date(resetTime('resets 2pm (Europe/London)', at)).toISOString(), '2026-10-22T13:00:00.000Z');
	assert.equal(resetTime('You\'ve hit your session limit', at), null);
});

const line = (o) => `${JSON.stringify(o)}\n`;
const limitLine = (timestamp) => line({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'You\'ve hit your session limit · resets 1:50am (America/Chicago)' }] } });

test('limitStop: only when the last message is the limit error', () => {
	const dir = temp('foreman-transcript-');
	const f = join(dir, 's.jsonl');
	writeFileSync(f, line({ type: 'user', message: { content: 'go' } }) + limitLine('2026-10-22T03:33:00Z') + line({ type: 'attachment', attachment: {} }));
	const stop = limitStop(f);
	assert.equal(stop.at, Date.parse('2026-10-22T03:33:00Z'));
	assert.equal(new Date(stop.resetsAt).toISOString(), '2026-10-22T06:50:00.000Z');
	writeFileSync(f, limitLine('2026-10-22T03:33:00Z') + line({ type: 'user', message: { content: 'continue' } }) + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));
	assert.equal(limitStop(f), null, 'it carried on after the limit');
});

test('agentActivity: the newest session across every worktree of the repo, subagents included', () => {
	const repo = temp('foreman-repo-');
	execFileSync('git', ['init', '-q', '-b', 'main', repo]);
	execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
	const wt = join(temp('foreman-wt-'), 'builder');
	execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', wt]);
	const projects = temp('foreman-projects-');
	const folder = (p) => { const f = join(projects, projectFolder(p)); mkdirSync(f, { recursive: true }); return f; };
	const old = join(folder(repo), 'a.jsonl');
	writeFileSync(old, line({ type: 'assistant', message: { content: [] } }));
	utimesSync(old, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
	mkdirSync(join(folder(wt), 'b', 'subagents'), { recursive: true });
	const sub = join(folder(wt), 'b', 'subagents', 'agent-1.jsonl');
	writeFileSync(sub, limitLine(new Date().toISOString()));
	const a = agentActivity(repo, { dir: projects });
	assert.ok(Date.now() - a.lastActiveAt < 60e3);
	assert.ok(a.limited, 'the newest one stopped at the limit');
	writeFileSync(old, line({ type: 'assistant', message: { content: [] } })); // Someone carries on in the main checkout.
	assert.equal(agentActivity(repo, { dir: projects }).limited, null);
});

// ---- how a session ended ----

test('classify: limited, ended, failed', () => {
	const dir = temp('foreman-session-');
	const f = join(dir, 'out.jsonl');
	writeFileSync(f, line({ type: 'system', subtype: 'init', session_id: 'abc' }) + line({ type: 'result', is_error: true, result: 'You\'ve hit your session limit · resets 1:50am (America/Chicago)', session_id: 'abc' }));
	const limited = classify(f, { status: 1 });
	assert.equal(limited.outcome, 'limited');
	assert.equal(limited.sessionId, 'abc');
	assert.ok(limited.resetsAt > Date.now());
	writeFileSync(f, line({ type: 'system', subtype: 'init', session_id: 'abc' }) + line({ type: 'result', is_error: false, result: 'Merged #40. #12 waits on the team: it hit the session limit earlier.', session_id: 'abc' }));
	assert.equal(classify(f, { status: 0 }).outcome, 'ended', 'a summary that mentions a limit is not a limit stop');
	writeFileSync(f, 'Error: something broke\n');
	assert.equal(classify(f, { status: 1 }).outcome, 'failed');
	assert.equal(classify(join(dir, 'none.jsonl'), { error: new Error('spawn claude ENOENT') }).outcome, 'failed');
});

test('plist: a launchd job that runs a round every few minutes', () => {
	const xml = plist({ label: 'com.example.w', program: ['/usr/bin/node', '/x/foreman.mjs', 'watchdog', 'run'], dir: '/repo-foreman', everyMinutes: 15, logFile: '/l.log', env: { PATH: '/a:/b&c' } });
	assert.match(xml, /<key>StartInterval<\/key><integer>900<\/integer>/);
	assert.match(xml, /<string>watchdog<\/string><string>run<\/string>/);
	assert.match(xml, /\/a:\/b&amp;c/);
});

test('config: watchdog settings are checked', () => {
	const dir = temp('foreman-config-');
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ watchdog: { everyMinutes: 0, command: [], env: { A: 1 } } }));
	assert.throws(() => loadConfig(dir), (e) => /everyMinutes/.test(e.message) && /command/.test(e.message) && /env/.test(e.message));
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ watchdog: { staleMinutes: 60 } }));
	assert.equal(loadConfig(dir).watchdog.everyMinutes, 15, 'the other defaults stay');
});

// ---- tick: rebase and merge ----

const bin = temp('foreman-bin-');
copyFileSync(join(ROOT, 'test/fake-gh.mjs'), join(bin, 'gh'));
chmodSync(join(bin, 'gh'), 0o755);

function tickRepo(featureFile) {
	const dir = temp('foreman-tick-');
	const origin = join(dir, 'origin.git'), work = join(dir, 'work');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
	execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
	const git = (...a) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
	const commit = (file, body) => { writeFileSync(join(work, file), body); git('add', '-A'); git('commit', '-q', '-m', file); return git('rev-parse', 'HEAD'); };
	git('symbolic-ref', 'HEAD', 'refs/heads/main');
	commit('README.md', 'hello\n');
	git('push', '-q', 'origin', 'main');
	git('checkout', '-q', '-b', 'feature');
	const pr = commit(featureFile, 'feature\n');
	git('push', '-q', 'origin', 'feature', `${pr}:refs/pull/7/head`);
	git('checkout', '-q', 'main');
	commit('other.txt', 'main moves on\n');
	git('push', '-q', 'origin', 'main');
	const stateFile = join(dir, 'gh.json');
	writeFileSync(stateFile, JSON.stringify({ repo: 'o/r', origin, pr: { state: 'OPEN', isDraft: false, head: pr, mergeable: 'MERGEABLE', branch: 'feature' }, approved: [pr], verify: { [pr]: 'success' }, failed: {}, checksPass: true, merged: false }));
	process.env.PATH = `${bin}:${process.env.PATH.split(':').filter((p) => p !== bin).join(':')}`;
	process.env.FAKE_GH_STATE = stateFile;
	process.env.FOREMAN_LOCK_WAIT = '1';
	process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
	process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
	const config = { ...DEFAULTS, root: work };
	const prObj = { number: 7, headRefName: 'feature', headRefOid: pr, foreman: { approvedSha: pr } };
	const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
	const branch = () => execFileSync('git', ['-C', origin, 'rev-parse', 'refs/heads/feature'], { encoding: 'utf8' }).trim();
	return { config, prObj, state, branch, pr };
}

test('tick: rebases an approved PR onto the base and merges it through the gate', async () => {
	const t = tickRepo('app.txt');
	const said = [];
	const ok = await rebaseAndMerge(t.config, t.prObj, (m) => said.push(m));
	assert.equal(ok, true, said.join('\n'));
	assert.notEqual(t.branch(), t.pr, 'the rebased branch was pushed');
	assert.equal(t.state().merged, true);
	assert.ok(t.state().approved.includes(t.branch()), 'the approval was carried over to the rebased commit');
});

test('tick: leaves a PR that does not rebase cleanly alone', async () => {
	const t = tickRepo('other.txt'); // Main changed the same file.
	const said = [];
	assert.equal(await rebaseAndMerge(t.config, t.prObj, (m) => said.push(m)), false);
	assert.match(said.join('\n'), /doesn't rebase cleanly/);
	assert.equal(t.branch(), t.pr, 'the branch is untouched');
	assert.equal(t.state().merged, false);
});

test('watchdog session: runs the command and records how it ended', () => {
	const repo = temp('foreman-wd-');
	execFileSync('git', ['init', '-q', '-b', 'main', repo]);
	const say = (o) => `console.log(${JSON.stringify(JSON.stringify(o))})`;
	const script = [say({ type: 'system', subtype: 'init', session_id: 's1' }), say({ type: 'result', is_error: true, result: 'You\'ve hit your session limit · resets 1:50am (America/Chicago)' }), 'process.exit(1)'].join(';');
	writeFileSync(join(repo, 'foreman.config.json'), JSON.stringify({ watchdog: { command: ['node', '-e', script, '{prompt}'] } }));
	execFileSync('node', [join(ROOT, 'bin/foreman.mjs'), 'watchdog', 'session', 'run-1'], { cwd: repo, env: { ...process.env, FOREMAN_NO_NOTIFY: '1' } });
	const dir = join(repo, '.git/foreman/watchdog');
	const result = JSON.parse(readFileSync(join(dir, 'sessions/run-1.json'), 'utf8'));
	assert.equal(result.outcome, 'limited');
	assert.equal(result.sessionId, 's1');
	assert.match(readFileSync(join(dir, 'watchdog.log'), 'utf8'), /Coordinator run-1 limited/);
});

test('watchdog stop never signals a process that only shares the recorded pid', () => {
	const repo = temp('foreman-stop-');
	execFileSync('git', ['init', '-q', '-b', 'main', repo]);
	const dir = join(repo, '.git/foreman/watchdog');
	mkdirSync(dir, { recursive: true });
	// This test's own pid, as if the Mac had restarted and handed the number to something else.
	writeFileSync(join(dir, 'state.json'), JSON.stringify({ session: { id: 'old-run', pid: process.pid, startedAt: Date.now() } }));
	const out = execFileSync('node', [join(ROOT, 'bin/foreman.mjs'), 'watchdog', 'stop'], { cwd: repo, encoding: 'utf8' });
	assert.match(out, /No Coordinator started by the watchdog is running/);
});

test('baseFailing: a later hand-started run doesn\'t hide a failed push run', async () => {
	const { baseFailing } = await import('../lib/state.mjs');
	const runs = [
		{ workflowName: 'Deploy', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' },
		{ workflowName: 'Deploy', event: 'push', status: 'completed', conclusion: 'failure' },
	];
	const latest = (list) => [...new Map([...list].reverse().map((r) => [r.workflowName, r])).values()].reverse();
	assert.equal(baseFailing({ runs: latest(runs), pushRuns: latest(runs.filter((r) => r.event === 'push')) }).length, 1);
});

test('prepare: keeps an earlier Coordinator\'s leftovers on a branch, moves to the latest base, survives a deleted folder', async () => {
	const { prepare } = await import('../lib/watchdog.mjs');
	const dir = temp('foreman-prep-');
	const origin = join(dir, 'origin.git'), work = join(dir, 'work'), coord = join(dir, 'coord');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
	execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
	const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
	git(work, 'symbolic-ref', 'HEAD', 'refs/heads/main');
	writeFileSync(join(work, 'a.txt'), '1\n'); git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'one'); git(work, 'push', '-q', 'origin', 'main');
	const config = { ...DEFAULTS, root: work, watchdog: { ...DEFAULTS.watchdog, setup: '' } };
	const quiet = () => {};
	prepare(config, coord, quiet);
	writeFileSync(join(coord, 'half-done.txt'), 'wip\n');
	writeFileSync(join(work, 'a.txt'), '2\n'); git(work, 'commit', '-qam', 'two'); git(work, 'push', '-q', 'origin', 'main');
	const said = [];
	prepare(config, coord, (m) => said.push(m));
	assert.equal(git(coord, 'rev-parse', 'HEAD'), git(work, 'rev-parse', 'HEAD'), 'on the latest base');
	assert.match(said.join('\n'), /kept them on the local branch foreman\/leftovers-/);
	assert.equal(git(coord, 'status', '--porcelain'), '');
	rmSync(coord, { recursive: true, force: true });
	prepare(config, coord, quiet);
	assert.equal(git(coord, 'rev-parse', 'HEAD'), git(work, 'rev-parse', 'HEAD'), 'recreated after being deleted by hand');
});

test('init --self-hosted without --ci writes nothing', () => {
	const dir = temp('foreman-init-');
	execFileSync('git', ['init', '-q', '-b', 'main', dir]);
	assert.throws(() => execFileSync('node', [join(ROOT, 'bin/foreman.mjs'), 'init', '--self-hosted', 'mac'], { cwd: dir, stdio: 'pipe' }), /goes with --ci/);
	assert.throws(() => readFileSync(join(dir, 'foreman.config.json')));
});
