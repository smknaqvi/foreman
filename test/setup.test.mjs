/**
 * Config loading, `foreman init` and `foreman workspace`, and the environment adapters' setup.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { RISKY_ALWAYS, loadConfig } from '../lib/config.mjs';
import { loadAdapter } from '../lib/env/index.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const repo = () => {
	const dir = mkdtempSync(join(tmpdir(), 'foreman-setup-'));
	temps.push(dir);
	execFileSync('git', ['init', '-q', '-b', 'main', dir]);
	return dir;
};
const cli = (cwd, ...args) => execFileSync('node', [join(ROOT, 'bin/foreman.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, CONDUCTOR_PORT: '' } });

test('config: defaults without a file, merged with one, found from a subfolder', () => {
	const dir = repo();
	assert.equal(loadConfig(dir).baseBranch, 'main');
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ baseBranch: 'trunk', labels: { working: 'busy' }, riskyPaths: ['deploy/'] }));
	mkdirSync(join(dir, 'a/b'), { recursive: true });
	const c = loadConfig(join(dir, 'a/b'));
	assert.equal(c.root, dir);
	assert.equal(c.baseBranch, 'trunk');
	assert.equal(c.labels.working, 'busy');
	assert.equal(c.labels.needsInput, 'needs team input', 'nested defaults survive a partial override');
	assert.deepEqual(c.riskyPaths, [...RISKY_ALWAYS, 'memory/MEMORY.md', 'deploy/'], 'no memory set up yet: only a PR adding its index is risky');
});

test('config: explains what is wrong', () => {
	const dir = repo();
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ baseBranch: 'a b', maxBuilders: 0, hotspots: 'x', docsOnly: '(' }));
	assert.throws(() => loadConfig(dir), (e) => /baseBranch/.test(e.message) && /maxBuilders/.test(e.message) && /hotspots/.test(e.message) && /docsOnly/.test(e.message));
	writeFileSync(join(dir, 'foreman.config.json'), '{ nope');
	assert.throws(() => loadConfig(dir), /isn't valid JSON/);
});

test('init: writes the config, hooks, guard and playbooks, and is safe to re-run', () => {
	const dir = repo();
	writeFileSync(join(dir, '.claude-keep'), '');
	mkdirSync(join(dir, '.claude'));
	writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
	cli(dir, 'init', '--ci', '--conductor');
	for (const f of ['foreman.config.json', '.githooks/pre-push', '.claude/hooks/foreman-guard.mjs', '.claude/skills/coordinate-agents/SKILL.md', '.claude/skills/work-an-issue/SKILL.md', '.github/workflows/verify.yml', '.conductor/settings.toml'])
		assert.ok(existsSync(join(dir, f)), f);
	assert.ok(statSync(join(dir, '.githooks/pre-push')).mode & 0o100, 'pre-push is executable');
	assert.match(readFileSync(join(dir, '.githooks/pre-push'), 'utf8'), /refs\/heads\/main"/);
	assert.equal(execFileSync('git', ['-C', dir, 'config', 'core.hooksPath'], { encoding: 'utf8' }).trim(), '.githooks');
	const settings = () => JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
	assert.deepEqual(settings().permissions, { allow: ['Bash(ls)'] }, 'existing settings are kept');
	assert.equal(settings().hooks.PreToolUse.length, 1);
	cli(dir, 'init');
	assert.equal(settings().hooks.PreToolUse.length, 1, 'the hook is added once');
});

test('init --force replaces its own playbooks but never one the repo wrote', () => {
	const dir = repo();
	mkdirSync(join(dir, '.claude/skills/work-an-issue'), { recursive: true });
	writeFileSync(join(dir, '.claude/skills/work-an-issue/SKILL.md'), 'ours');
	cli(dir, 'init');
	writeFileSync(join(dir, '.claude/skills/coordinate-agents/SKILL.md'), `${readFileSync(join(dir, '.claude/skills/coordinate-agents/SKILL.md'), 'utf8')}\nlocal edit`);
	cli(dir, 'init', '--force');
	assert.equal(readFileSync(join(dir, '.claude/skills/work-an-issue/SKILL.md'), 'utf8'), 'ours');
	assert.doesNotMatch(readFileSync(join(dir, '.claude/skills/coordinate-agents/SKILL.md'), 'utf8'), /local edit/);
});

test('init uses the configured base branch in the pre-push check and CI', () => {
	const dir = repo();
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ baseBranch: 'develop', verifyCommand: 'make check' }));
	cli(dir, 'init', '--ci');
	assert.match(readFileSync(join(dir, '.githooks/pre-push'), 'utf8'), /refs\/heads\/develop"/);
	const ci = readFileSync(join(dir, '.github/workflows/verify.yml'), 'utf8');
	assert.match(ci, /branches: \[develop\]/);
	assert.match(ci, /run: make check/);
});

test('workspace: switches on the pre-push check and gives the environment its port', () => {
	const dir = repo();
	cli(dir, 'init');
	execFileSync('git', ['-C', dir, 'config', '--unset', 'core.hooksPath']);
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ env: { adapter: 'wp-env' } }));
	cli(dir, 'workspace', '--port', '8890');
	assert.equal(execFileSync('git', ['-C', dir, 'config', 'core.hooksPath'], { encoding: 'utf8' }).trim(), '.githooks');
	assert.deepEqual(JSON.parse(readFileSync(join(dir, '.wp-env.override.json'), 'utf8')), { port: 8890 });
	cli(dir, 'workspace', '--port', '8891');
	assert.deepEqual(JSON.parse(readFileSync(join(dir, '.wp-env.override.json'), 'utf8')), { port: 8890 }, 'an existing port is kept');
});

test('docker-compose adapter: sets the port variable in the env file, keeping the rest', async () => {
	const dir = repo();
	writeFileSync(join(dir, '.env'), 'A=1\nPORT=3000\n');
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ env: { adapter: 'docker-compose', service: 'app' } }));
	const adapter = await loadAdapter(loadConfig(dir));
	assert.equal(adapter.usesDocker, true);
	await adapter.setup({ root: dir, port: 4001 });
	assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'A=1\nPORT=4001\n');
});

test('custom adapters load from the repo, with their options', async () => {
	const dir = repo();
	writeFileSync(join(dir, 'my-env.mjs'), `export default {
		setup({ root, port, options }) { return [root, port, options.greeting]; },
		list({ options }) { return [{ name: options.greeting, port: '9000', folder: '' }]; },
	};`);
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ env: { adapter: './my-env.mjs', greeting: 'hi' } }));
	const adapter = await loadAdapter(loadConfig(dir));
	assert.equal(adapter.usesDocker, false);
	assert.deepEqual(await adapter.setup({ root: dir, port: 1 }), [dir, 1, 'hi']);
	assert.deepEqual(await adapter.list(), [{ name: 'hi', port: '9000', folder: '' }]);
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ env: { adapter: './missing.mjs' } }));
	await assert.rejects(loadAdapter(loadConfig(dir)), /Couldn't load the environment adapter/);
});

test('init and workspace leave another hooks folder (husky...) alone', () => {
	const dir = repo();
	execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky']);
	const out = cli(dir, 'init');
	assert.match(out, /already runs hooks from \.husky/);
	assert.ok(existsSync(join(dir, '.githooks/pre-push')), 'the check is still written, to be called from .husky');
	cli(dir, 'workspace');
	assert.equal(execFileSync('git', ['-C', dir, 'config', 'core.hooksPath'], { encoding: 'utf8' }).trim(), '.husky');
});

test('init --ci --self-hosted: the workflow runs on those labels and keeps the machine awake', () => {
	const dir = repo();
	cli(dir, 'init', '--ci', '--self-hosted', 'my-mac');
	const ci = readFileSync(join(dir, '.github/workflows/verify.yml'), 'utf8');
	assert.match(ci, /runs-on: \[self-hosted, my-mac\]/);
	assert.match(ci, /keep-awake\.sh start/);
	assert.match(ci, /foreman env remove/);
	assert.ok(statSync(join(dir, '.github/foreman/keep-awake.sh')).mode & 0o100, 'keep-awake.sh is executable');
});

test('guard --self-test: passes once init has run, fails when the pre-push check stops refusing', () => {
	const dir = repo();
	cli(dir, 'init');
	// The hook loads foreman from the repo's node_modules: link this checkout in (a linked install skips the lockfile check).
	mkdirSync(join(dir, 'node_modules/@smknaqvi'), { recursive: true });
	symlinkSync(ROOT, join(dir, 'node_modules/@smknaqvi/foreman'));
	assert.match(cli(dir, 'guard', '--self-test'), /10\/10 passed/);
	// A hook that lets everything through. It reads its input like a real one: one that exits before the self-test
	// has written it can make that write fail (EPIPE), which the self-test would take for a refusal.
	writeFileSync(join(dir, '.githooks/pre-push'), '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n');
	assert.throws(() => cli(dir, 'guard', '--self-test'), (e) => /FAIL {2}pre-push refuses main/.test(e.stdout));
});

test('init --agents wires the guard into each tool\'s own hook settings, once', () => {
	const dir = repo();
	cli(dir, 'init', '--agents', 'claude,codex,cursor,gemini');
	const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
	assert.equal(read('.claude/settings.json').hooks.PreToolUse[0].matcher, 'Bash');
	const codex = read('.codex/hooks.json').hooks.PreToolUse[0];
	assert.equal(codex.matcher, 'Bash');
	assert.match(codex.hooks[0].command, /git rev-parse --show-toplevel.*--agent codex$/);
	const cursor = read('.cursor/hooks.json');
	assert.equal(cursor.version, 1);
	assert.match(cursor.hooks.beforeShellExecution[0].command, /^node \.claude\/hooks\/foreman-guard\.mjs --agent cursor$/);
	const gemini = read('.gemini/settings.json').hooks.BeforeTool[0];
	assert.equal(gemini.matcher, 'run_shell_command');
	assert.equal(gemini.hooks[0].timeout, 10000, 'Gemini CLI counts milliseconds');
	cli(dir, 'init', '--agents', 'codex,cursor,gemini');
	assert.equal(read('.codex/hooks.json').hooks.PreToolUse.length, 1, 'added once');
	assert.equal(read('.cursor/hooks.json').hooks.beforeShellExecution.length, 1, 'added once');
	assert.equal(read('.gemini/settings.json').hooks.BeforeTool.length, 1, 'added once');
	assert.throws(() => cli(dir, 'init', '--agents', 'claude,windsurf'), (e) => /Unknown agent tool windsurf/.test(e.stderr));

	// Every wired tool passes the self-test, each through its own payload and answer.
	mkdirSync(join(dir, 'node_modules/@smknaqvi'), { recursive: true });
	symlinkSync(ROOT, join(dir, 'node_modules/@smknaqvi/foreman'));
	const out = cli(dir, 'guard', '--self-test');
	assert.match(out, /31\/31 passed/);
	assert.match(out, /Cursor: blocks gh pr merge/);
});

test('init without --agents: the tools the repo is set up for, or Claude Code', () => {
	const fresh = repo();
	cli(fresh, 'init');
	assert.ok(existsSync(join(fresh, '.claude/settings.json')), 'a repo set up for no tool gets Claude Code');
	assert.ok(!existsSync(join(fresh, '.cursor/hooks.json')));

	const both = repo();
	mkdirSync(join(both, '.cursor'));
	mkdirSync(join(both, '.claude'));
	writeFileSync(join(both, '.claude/settings.json'), '{}');
	cli(both, 'init');
	assert.ok(existsSync(join(both, '.cursor/hooks.json')));
	assert.match(readFileSync(join(both, '.claude/settings.json'), 'utf8'), /foreman-guard/);
	assert.ok(!existsSync(join(both, '.codex/hooks.json')));

	const codexOnly = repo();
	cli(codexOnly, 'init', '--agents', 'codex');
	cli(codexOnly, 'init', '--force');
	assert.ok(!existsSync(join(codexOnly, '.claude/settings.json')), 'refreshing a Codex-only repo adds no Claude Code hook');
	assert.ok(existsSync(join(codexOnly, '.codex/hooks.json')));

	const typo = repo();
	assert.throws(() => cli(typo, 'init', '--agents', 'claud'), /Unknown agent tool claud/);
	assert.ok(!existsSync(join(typo, 'foreman.config.json')), 'an unknown tool stops init before it writes anything');
});

test('guard --self-test fails when a tool the repo is set up for lost its hook, even with others wired', () => {
	const dir = repo();
	cli(dir, 'init', '--agents', 'claude,cursor');
	mkdirSync(join(dir, 'node_modules/@smknaqvi'), { recursive: true });
	symlinkSync(ROOT, join(dir, 'node_modules/@smknaqvi/foreman'));
	writeFileSync(join(dir, '.claude/settings.json'), '{}');
	assert.throws(() => cli(dir, 'guard', '--self-test'), (e) => /FAIL {2}every tool set up here runs it \(missing: \.claude\/settings\.json\)/.test(e.stdout));
});

test('init --agents antigravity: its hooks.json, and links to every playbook in .agents/skills/', () => {
	const dir = repo();
	mkdirSync(join(dir, '.claude/skills/local-site'), { recursive: true });
	writeFileSync(join(dir, '.claude/skills/local-site/SKILL.md'), '---\nname: local-site\ndescription: x\n---\n');
	mkdirSync(join(dir, '.agents/skills/ours'), { recursive: true }); // A skill of the repo's own there: left alone.
	cli(dir, 'init', '--agents', 'claude,antigravity');
	const hooks = JSON.parse(readFileSync(join(dir, '.agents/hooks.json'), 'utf8'));
	assert.equal(hooks['foreman-guard'].PreToolUse[0].matcher, 'run_command');
	const command = hooks['foreman-guard'].PreToolUse[0].hooks[0].command;
	assert.match(command, /--agent antigravity/);
	// The command as a shell runs it: outside the checkout it still refuses gh and git push (and allows the rest).
	const outside = (c) => JSON.parse(execFileSync('sh', ['-c', command], { cwd: tmpdir(), input: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: c } } }), encoding: 'utf8' })).decision;
	assert.equal(outside('gh pr merge 1'), 'deny');
	assert.equal(outside('git push origin main'), 'deny');
	assert.equal(outside('ls'), 'allow');
	for (const skill of ['coordinate-agents', 'work-an-issue', 'local-site']) {
		assert.ok(lstatSync(join(dir, '.agents/skills', skill)).isSymbolicLink(), skill);
		assert.ok(existsSync(join(dir, '.agents/skills', skill, 'SKILL.md')), `${skill} resolves`);
	}
	cli(dir, 'init', '--agents', 'claude,antigravity');
	assert.equal(JSON.parse(readFileSync(join(dir, '.agents/hooks.json'), 'utf8'))['foreman-guard'].PreToolUse.length, 1, 'added once');
	mkdirSync(join(dir, 'node_modules/@smknaqvi'), { recursive: true });
	symlinkSync(ROOT, join(dir, 'node_modules/@smknaqvi/foreman'));
	assert.match(cli(dir, 'guard', '--self-test'), /Antigravity: blocks gh pr merge/);
	const payload = (c) => JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: c, Cwd: dir } }, workspacePaths: [dir] });
	assert.equal(JSON.parse(execFileSync('sh', ['-c', command], { cwd: join(dir, '.claude'), input: payload('gh pr merge 1'), encoding: 'utf8' })).decision, 'deny', 'from a subfolder too');
	assert.equal(JSON.parse(execFileSync('sh', ['-c', command], { cwd: dir, input: payload('ls'), encoding: 'utf8' })).decision, 'allow');

	// Switched off by a PR: no longer counts as wired (the self-test fails), and init switches it back on.
	const off = JSON.parse(readFileSync(join(dir, '.agents/hooks.json'), 'utf8'));
	off['foreman-guard'].enabled = false;
	writeFileSync(join(dir, '.agents/hooks.json'), JSON.stringify(off));
	assert.throws(() => cli(dir, 'guard', '--self-test'), (e) => /missing: \.agents\/hooks\.json/.test(e.stdout));
	cli(dir, 'init', '--agents', 'claude,antigravity');
	const on = JSON.parse(readFileSync(join(dir, '.agents/hooks.json'), 'utf8'))['foreman-guard'];
	assert.equal(on.enabled, undefined);
	assert.equal(on.PreToolUse.length, 1);

	// A playbook removed later loses its link; a same-name folder of the repo's own is left alone.
	rmSync(join(dir, '.claude/skills/local-site'), { recursive: true });
	mkdirSync(join(dir, '.claude/skills/ours'), { recursive: true });
	writeFileSync(join(dir, '.claude/skills/ours/SKILL.md'), '---\ndescription: x\n---\n');
	cli(dir, 'init', '--agents', 'claude,antigravity');
	assert.throws(() => lstatSync(join(dir, '.agents/skills/local-site')), 'the dangling link is removed');
	assert.ok(!lstatSync(join(dir, '.agents/skills/ours')).isSymbolicLink(), 'the repo\'s own folder stays');

	// The self-test runs the command the settings hold, so a replaced one fails it.
	const fake = JSON.parse(readFileSync(join(dir, '.agents/hooks.json'), 'utf8'));
	fake['foreman-guard'].PreToolUse[0].hooks[0].command = `echo '{"decision":"allow"}' # foreman-guard`;
	writeFileSync(join(dir, '.agents/hooks.json'), JSON.stringify(fake));
	assert.throws(() => cli(dir, 'guard', '--self-test'), (e) => /FAIL {2}Antigravity: blocks gh pr merge/.test(e.stdout));
});

test('init: a .agents/ folder alone (Codex skills) is not an Antigravity repo; an old shim is replaced', () => {
	const dir = repo();
	mkdirSync(join(dir, '.agents/skills'), { recursive: true });
	cli(dir, 'init');
	assert.ok(!existsSync(join(dir, '.agents/hooks.json')));
	writeFileSync(join(dir, '.claude/hooks/foreman-guard.mjs'), '// an old shim without a version\n');
	cli(dir, 'init', '--agents', 'claude,antigravity');
	assert.match(readFileSync(join(dir, '.claude/hooks/foreman-guard.mjs'), 'utf8'), /foreman-shim: 2/, 'replaced without --force');
});

test('the pre-push check is judged by its exit status, even when it never reads its input (#32)', async () => {
	const { hookRefuses } = await import('../lib/selftest.mjs');
	const dir = repo();
	const hook = join(dir, 'pre-push');
	// Lets everything through without reading stdin: writing the push line can fail (EPIPE), which must not count.
	writeFileSync(hook, '#!/usr/bin/env bash\nexit 0\n');
	for (let i = 0; i < 25; i++) assert.equal(hookRefuses(hook, 'main', { cwd: dir, env: process.env }), false, `run ${i}`);
	// Refuses without reading stdin: still a refusal.
	writeFileSync(hook, '#!/usr/bin/env bash\nexit 1\n');
	for (let i = 0; i < 5; i++) assert.equal(hookRefuses(hook, 'main', { cwd: dir, env: process.env }), true);
});
