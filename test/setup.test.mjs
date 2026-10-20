/**
 * Config loading, `foreman init` and `foreman workspace`, and the environment adapters' setup.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
	assert.deepEqual(c.riskyPaths, [...RISKY_ALWAYS, 'deploy/']);
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
