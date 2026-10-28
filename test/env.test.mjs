/**
 * Environment adapters: combinations, the dev-server family (a real server started and stopped) and Neon
 * branches (against a stand-in for Neon's API).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { loadAdapter } from '../lib/env/index.mjs';
import { branchName } from '../lib/env/neon.mjs';
import { entry } from '../lib/env/registry.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const repo = (config) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-env-')));
	temps.push(dir);
	execFileSync('git', ['init', '-q', '-b', 'main', dir]);
	if (config) writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify(config));
	return dir;
};
const cli = (cwd, ...args) => execFileSync('node', [join(ROOT, 'bin/foreman.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, CONDUCTOR_PORT: '' } });
const quietly = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const freePort = () => new Promise((done) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
let hasLsof = true;
try { execFileSync('lsof', ['-v'], { stdio: 'ignore' }); } catch (e) { hasLsof = e.code !== 'ENOENT'; }

test('config: adapter may be a list, not an empty one', () => {
	const dir = repo({ env: { adapter: ['nextjs', 'neon'] } });
	assert.deepEqual(loadConfig(dir).env.adapter, ['nextjs', 'neon']);
	for (const adapter of [[], [''], [1], 3]) {
		writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ env: { adapter } }));
		assert.throws(() => loadConfig(dir), /env\.adapter/);
	}
});

test('a combination: each adapter does its part with its own options, and remove goes back to the right one', async () => {
	const dir = repo();
	const mod = (tag) => `export default {
		usesDocker: ${tag === 'b'},
		setup({ port, options }) { globalThis.calls ??= []; globalThis.calls.push(['${tag}', port, options.shared, options.mine]); },
		list({ options }) { return [{ name: '${tag}', port: '1', folder: '', mine: options.mine }]; },
		remove({ env, port }) { if ('${tag}' === 'b' && !env) throw new Error('b broke'); return ['${tag}:' + (env ? env.name : port)]; },
	};`;
	writeFileSync(join(dir, 'a.mjs'), mod('a'));
	writeFileSync(join(dir, 'b.mjs'), mod('b'));
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ env: { adapter: ['./a.mjs', './b.mjs'], shared: 's', './a.mjs': { mine: 'A' }, './b.mjs': { mine: 'B' } } }));
	const adapter = await loadAdapter(loadConfig(dir));
	assert.equal(adapter.name, './a.mjs + ./b.mjs');
	assert.equal(adapter.usesDocker, true);
	globalThis.calls = [];
	await adapter.setup({ port: 7 });
	assert.deepEqual(globalThis.calls, [['a', 7, 's', 'A'], ['b', 7, 's', 'B']], 'in order, each with its own options');
	const envs = await adapter.list();
	assert.deepEqual(envs.map((e) => [e.adapter, e.mine]), [['./a.mjs', 'A'], ['./b.mjs', 'B']]);
	assert.deepEqual([...(await adapter.remove({ env: envs[1] }))], ['b:b'], 'only the adapter the entry came from');
	const all = await adapter.remove({ port: 9 });
	assert.deepEqual([...all], ['a:9'], 'one that fails does not stop the rest');
	assert.match(all.failed.join(), /b broke/);
});

test('a combination: one adapter that can\'t list doesn\'t hide the others\' environments', async () => {
	const dir = repo();
	writeFileSync(join(dir, 'ok.mjs'), `export default { list() { return [{ name: 'server', port: '1', folder: '' }]; } };`);
	writeFileSync(join(dir, 'down.mjs'), `export default { list() { throw new Error('NEON_API_KEY isn\\'t set'); } };`);
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ env: { adapter: ['./ok.mjs', './down.mjs'] } }));
	const envs = await (await loadAdapter(loadConfig(dir))).list();
	assert.deepEqual(envs.map((e) => e.name), ['server']);
	assert.deepEqual(envs.errors, ["./down.mjs: NEON_API_KEY isn't set"]);
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ env: { adapter: ['./down.mjs', './down.mjs'] } }));
	await assert.rejects((await loadAdapter(loadConfig(dir))).list(), /NEON_API_KEY/, 'all failing still throws');
});

test('dev-server: workspace records the port, env start runs it with PORT and vars, env remove stops it', { skip: !hasLsof && 'no lsof' }, async () => {
	const port = await freePort();
	const server = "require('http').createServer((q, s) => s.end(process.env.GREETING + ' ' + process.env.PORT)).listen(process.env.PORT)";
	const dir = repo({ env: { adapter: 'dev-server', command: ['node', '-e', server], vars: { GREETING: 'hi-{checkout}' }, envFile: '.env.local' } });
	const name = dir.split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '_');
	assert.match(cli(dir, 'workspace', '--port', String(port)), new RegExp(`localhost:${port}`));
	assert.equal(readFileSync(join(dir, '.env.local'), 'utf8'), `PORT=${port}\nGREETING=hi-${name}\n`);
	assert.equal(entry(dir).port, port);
	try {
		assert.match(cli(dir, 'env', 'start'), /is running at/);
		assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), `hi-${name} ${port}`);
		assert.match(cli(dir, 'env', 'start'), /Already running/, 'a second start is a no-op');
		const adapter = await loadAdapter(loadConfig(dir));
		const envs = await adapter.list();
		assert.equal(envs.length, 1);
		assert.equal(envs[0].port, String(port));
		assert.equal(envs[0].folder, dir);
		assert.match(cli(dir, 'env', 'remove'), /Removed: dev-server pid/);
		assert.deepEqual(await adapter.list(), []);
		await assert.rejects(fetch(`http://127.0.0.1:${port}`));
	} finally {
		try { cli(dir, 'env', 'remove'); } catch {}
	}
});

test('dev-server: a server that dies at start says why, with its log', { skip: !hasLsof && 'no lsof' }, async () => {
	const dir = repo({ env: { adapter: 'dev-server', command: ['node', '-e', "console.error('no database'); process.exit(3)"] } });
	cli(dir, 'workspace', '--port', String(await freePort()));
	assert.throws(() => execFileSync('node', [join(ROOT, 'bin/foreman.mjs'), 'env', 'start'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }), (e) => /exited with 3/.test(e.stderr) && /no database/.test(e.stderr));
});

test('nextjs and rails: start commands on the checkout\'s port', async () => {
	const dir = repo({ env: { adapter: 'nextjs' } });
	assert.match(cli(dir, 'workspace', '--port', '4100'), /node_modules\/\.bin\/next dev --port 4100/);
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ env: { adapter: 'rails' } }));
	assert.match(cli(dir, 'workspace', '--port', '4101'), /bin\/rails server --port 4101/);
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ env: { adapter: 'none' } }));
	assert.throws(() => execFileSync('node', [join(ROOT, 'bin/foreman.mjs'), 'env', 'start'], { cwd: dir, stdio: 'pipe' }), 'none has nothing to start');
});

/** A stand-in for Neon's API: branches, databases, connection strings. */
async function fakeNeon() {
	const s = { branches: [{ id: 'br-main', name: 'main' }], created: [], deleted: [], key: '' };
	const server = createServer((req, res) => {
		s.key = req.headers.authorization;
		const url = new URL(req.url, 'http://x');
		const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
		let body = '';
		req.on('data', (c) => { body += c; });
		req.on('end', () => {
			const p = url.pathname.replace(/^\/projects\/proj-1/, '');
			let m;
			if (req.method === 'GET' && p === '/branches') return send(200, { branches: s.branches });
			if (req.method === 'POST' && p === '/branches') {
				const b = { id: `br-${s.created.length + 1}`, ...JSON.parse(body).branch };
				s.branches.push(b); s.created.push(b);
				return send(201, { branch: b });
			}
			if (req.method === 'GET' && (m = p.match(/^\/branches\/([\w-]+)\/databases$/))) return send(200, { databases: [{ name: 'app', owner_name: 'app_owner' }] });
			if (req.method === 'GET' && p === '/connection_uri') return send(200, { uri: `postgres://${url.searchParams.get('role_name')}:pw@${url.searchParams.get('branch_id')}.neon.test/${url.searchParams.get('database_name')}` });
			if (req.method === 'DELETE' && (m = p.match(/^\/branches\/([\w-]+)$/))) {
				if (!s.branches.some((b) => b.id === m[1])) return send(404, {});
				s.branches = s.branches.filter((b) => b.id !== m[1]); s.deleted.push(m[1]);
				return send(200, {});
			}
			send(404, { message: `unexpected ${req.method} ${p}` });
		});
	});
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	after(() => server.close());
	return { s, api: `http://127.0.0.1:${server.address().port}` };
}

test('neon: a branch per checkout, its connection string in the env file, deleted on remove', async () => {
	const { s, api } = await fakeNeon();
	const dir = repo({ env: { adapter: 'neon', projectId: 'proj-1', apiUrl: api, envFile: '.env.local' } });
	writeFileSync(join(dir, '.env.local'), 'KEEP=1\n');
	process.env.NEON_API_KEY = 'secret';
	try {
		const adapter = await loadAdapter(loadConfig(dir));
		await adapter.setup({ port: 4200 });
		assert.equal(s.key, 'Bearer secret');
		assert.equal(s.created.length, 1);
		assert.equal(s.created[0].name, branchName('foreman/', dir));
		assert.equal(readFileSync(join(dir, '.env.local'), 'utf8'), 'KEEP=1\nDATABASE_URL=postgres://app_owner:pw@br-1.neon.test/app\n');
		await adapter.setup({ port: 4200 });
		assert.equal(s.created.length, 1, 'a second setup reuses the branch');
		s.branches.push({ id: 'br-x', name: 'foreman/elsewhere-abc123' }, { id: 'br-dev', name: 'dev' });
		const envs = await adapter.list();
		assert.deepEqual(envs.map((e) => [e.name, e.port, e.folder]), [[`neon ${s.created[0].name}`, '4200', dir], ['neon foreman/elsewhere-abc123', '', '']], 'only foreman\'s branches; one made elsewhere has no folder');
		assert.deepEqual([...(await adapter.remove({ port: 0 }))], [`neon ${s.created[0].name}`]);
		assert.deepEqual(s.deleted, ['br-1'], 'only this checkout\'s branch');
		assert.equal(entry(dir).neon, undefined, 'forgotten, so the next setup makes a new one');
	} finally {
		delete process.env.NEON_API_KEY;
	}
});

test('neon: a deleted checkout\'s branch stays ORPHANED (and is deleted) even after another checkout sets up', async () => {
	const { s, api } = await fakeNeon();
	const main = repo({ env: { adapter: 'neon', projectId: 'proj-1', apiUrl: api } });
	execFileSync('git', ['-C', main, 'add', '-A']);
	execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']); // The worktree gets the config.
	const gone = join(main, '..', `${main.split('/').pop()}-builder`);
	execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '--detach', gone]);
	temps.push(gone);
	process.env.NEON_API_KEY = 'secret';
	try {
		const fromGone = await loadAdapter(loadConfig(gone));
		await quietly(() => fromGone.setup({ port: 4300 }));
		rmSync(gone, { recursive: true, force: true }); // A worktree deleted (a Conductor workspace archived, say).
		const fromMain = await loadAdapter(loadConfig(main));
		await quietly(() => fromMain.setup({ port: 4301 }));
		const orphan = (await fromMain.list()).find((e) => e.folder === gone);
		assert.ok(orphan, 'still linked to its folder, so tick sees it as ORPHANED');
		await fromMain.remove({ env: orphan });
		assert.deepEqual(s.deleted, [orphan.branchId]);
		assert.equal(entry(main, gone), null, 'then forgotten');
		assert.ok(entry(main).neon, 'the other checkout keeps its own');
	} finally {
		delete process.env.NEON_API_KEY;
	}
});

test('neon: says what is missing', async () => {
	const dir = repo({ env: { adapter: 'neon' } });
	delete process.env.NEON_API_KEY;
	const adapter = await loadAdapter(loadConfig(dir));
	await assert.rejects(adapter.setup({ port: 1 }), /NEON_API_KEY/);
	process.env.NEON_API_KEY = 'k';
	try { await assert.rejects(adapter.list(), /projectId/); } finally { delete process.env.NEON_API_KEY; }
});
