/**
 * A dev server per checkout, on the checkout's own port: `foreman workspace --port <p>` records the port,
 * `foreman env start` runs the server in the background with PORT (and `vars`) set, and the running ones are
 * whatever listens on a recorded port (lsof), so a server started by hand counts too. `remove` stops it.
 * Options:
 *   command   what starts the server, with {port} and {checkout} filled in. nextjs and rails have defaults.
 *   cwd       the folder to run it in, relative to the checkout (a monorepo's app). Default: the checkout.
 *   vars      more environment variables, e.g. { "DATABASE_URL": "postgres://localhost/app_{checkout}" }.
 *   envFile   also write PORT and `vars` to this file (e.g. ".env.local"), for tools that read it. Default: none.
 *   startTimeout   seconds `env start` waits for the port to open (120).
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { git } from '../sh.mjs';
import { fill, setVars } from './envfile.mjs';
import { entries, entry, prune, real, record } from './registry.mjs';

export function devServer({ name, command: defaultCommand = null }) {
	const commandOf = (options) => options.command ?? defaultCommand;
	const varsOf = (ctx, options) => ({ PORT: String(ctx.port), ...Object.fromEntries(Object.entries(options.vars ?? {}).map(([k, v]) => [k, fill(v, ctx)])) });

	return {
		setup({ root, port, options }) {
			if (!port) return;
			prune(root);
			record(root, root, { port });
			if (options.envFile) {
				const vars = varsOf({ root, port }, options);
				setVars(root, options.envFile, vars);
				console.log(`${options.envFile}: ${Object.keys(vars).join(', ')}`);
			}
			const cmd = commandOf(options);
			console.log(`This checkout's ${name} server will run at http://localhost:${port}: npx --no-install foreman env start${cmd ? ` (runs ${cmd.map((a) => fill(a, { root, port })).join(' ')})` : ''}`);
		},

		/** Start the server in the background and wait until it listens. */
		async start({ root, port, options }) {
			const p = Number(port) || Number(entry(root)?.port) || 0;
			if (!p) throw new Error('this checkout has no port yet: npx --no-install foreman workspace --port <port>');
			const cmd = commandOf(options);
			if (!cmd?.length) throw new Error(`env.command isn't set: what starts the server, e.g. ["npm", "run", "dev", "--", "--port", "{port}"]`);
			const busy = listeners([p]);
			if (busy.length) {
				if (busy.every((l) => inside(l.folder, real(root)))) { console.log(`Already running at http://localhost:${p} (pid ${busy.map((l) => l.pid).join(', ')}).`); return; }
				throw new Error(`port ${p} is taken by pid ${busy[0].pid} (${busy[0].folder || 'folder unknown'}): use another port, or stop that first`);
			}
			const ctx = { root, port: p };
			const logFile = join(resolve(root, git('-C', root, 'rev-parse', '--git-dir')), 'foreman', `${name}.log`);
			mkdirSync(join(logFile, '..'), { recursive: true });
			const fd = openSync(logFile, 'w');
			const [bin, ...args] = cmd.map((a) => fill(a, ctx));
			// Its own process group (detached), so it outlives this command and `remove` can stop all of it.
			const child = spawn(bin, args, { cwd: join(root, options.cwd ?? '.'), detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...varsOf(ctx, options) } });
			closeSync(fd);
			let ended = null;
			child.on('exit', (code, signal) => { ended = signal ? `stopped (${signal})` : `exited with ${code}`; });
			child.on('error', (e) => { ended = `couldn't start: ${e.message}`; });
			const deadline = Date.now() + (options.startTimeout ?? 120) * 1000;
			let up = false;
			while (!ended && !(up = await listening(p)) && Date.now() < deadline) await sleep(500);
			if (ended) throw new Error(`${bin} ${ended} before listening on port ${p}. Its log (${logFile}):\n${tail(logFile)}`);
			child.unref();
			record(root, root, { port: p, [name]: { pid: child.pid, log: logFile } });
			console.log(up
				? `${name} is running at http://localhost:${p} (pid ${child.pid}).\n  log: ${logFile}\n  stop: npx --no-install foreman env remove`
				: `Started ${name} (pid ${child.pid}), but nothing listens on port ${p} after ${options.startTimeout ?? 120}s. Its log: ${logFile}`);
		},

		/** Servers listening on a port a checkout of this repo recorded. */
		list({ root }) {
			const recorded = entries(root).filter((e) => e.port);
			const found = listeners(recorded.map((e) => Number(e.port)));
			return recorded.flatMap((e) => {
				const mine = found.filter((l) => l.port === Number(e.port));
				if (!mine.length) return [];
				const folder = mine.find((l) => l.folder)?.folder ?? '';
				return [{ name: `${name} pid ${mine.map((l) => l.pid).join(',')}`, port: String(e.port), folder: inside(folder, e.folder) ? e.folder : folder || e.folder, pids: mine.map((l) => l.pid) }];
			});
		},

		/** One server from list(), or whatever listens on this checkout's port and on `port`. */
		async remove({ root, env, port }) {
			const pids = env ? env.pids ?? [] : listeners([...new Set([Number(entry(root)?.port), Number(port)].filter(Boolean))]).map((l) => l.pid);
			const removed = [], failed = [];
			for (const pid of [...new Set(pids)]) (stopProcess(pid, root, name) ? removed : failed).push(`${name} pid ${pid}`);
			for (let i = 0; i < 20 && pids.some(alive); i++) await sleep(250);
			for (const pid of pids.filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
			prune(root);
			removed.failed = failed;
			return removed;
		},
	};
}

export default devServer({ name: 'dev-server' });

const inside = (folder, root) => Boolean(folder && root) && (folder === root || folder.startsWith(root + sep));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * Stop one listening process. If `foreman env start` started it (its recorded pid leads the listener's process
 * group), the whole group goes; otherwise only the listener, never a group it shares with something else (a
 * server started from an agent's shell shares that agent's group).
 */
function stopProcess(pid, root, name) {
	try {
		const started = Number(entries(root).find((e) => e[name]?.pid && pgid(e[name].pid) === e[name].pid && pgid(pid) === e[name].pid)?.[name].pid);
		process.kill(started ? -started : pid, 'SIGTERM');
		return true;
	} catch (e) {
		return e.code === 'ESRCH'; // Gone already.
	}
}

function pgid(pid) {
	try { return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) || 0; } catch { return 0; }
}

/** Processes listening on any of `ports`: [{ pid, port, folder }], `folder` being their working directory. */
export function listeners(ports) {
	if (!ports.length) return [];
	const lsof = (args) => {
		try {
			return execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		} catch (e) {
			if (e.code === 'ENOENT') throw new Error('lsof isn\'t installed: it\'s how foreman finds dev servers');
			return e.stdout ?? ''; // Exit 1: nothing matched.
		}
	};
	const found = [];
	let pid = 0;
	for (const line of lsof(['-nP', `-iTCP:${ports.join(',')}`, '-sTCP:LISTEN', '-Fpn']).split('\n')) {
		if (line.startsWith('p')) pid = Number(line.slice(1));
		const port = line.startsWith('n') ? Number(line.split(':').pop()) : 0;
		if (port && ports.includes(port) && !found.some((f) => f.pid === pid && f.port === port)) found.push({ pid, port, folder: '' });
	}
	if (!found.length) return found;
	const cwd = {};
	for (const line of lsof(['-a', '-d', 'cwd', '-p', [...new Set(found.map((f) => f.pid))].join(','), '-Fpn']).split('\n')) {
		if (line.startsWith('p')) pid = Number(line.slice(1));
		if (line.startsWith('n')) cwd[pid] = line.slice(1);
	}
	for (const f of found) f.folder = cwd[f.pid] ?? '';
	return found;
}

/** Is anything accepting connections on `port` on this machine (IPv4 or IPv6)? */
async function listening(port) {
	const tryHost = (host) => new Promise((done) => {
		const s = connect({ host, port, timeout: 1000 });
		s.once('connect', () => { s.destroy(); done(true); });
		s.once('timeout', () => { s.destroy(); done(false); });
		s.once('error', () => done(false));
	});
	return (await tryHost('127.0.0.1')) || (await tryHost('::1'));
}

const tail = (file) => { try { return readFileSync(file, 'utf8').trim().split('\n').slice(-15).join('\n'); } catch { return '(no log)'; } };
