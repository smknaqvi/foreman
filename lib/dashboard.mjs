/**
 * `foreman dashboard`: the crew at a glance in a browser: what `foreman status` shows, kept up to date, and a
 * live feed of what `foreman observe` would print plus the watchdog's rounds.
 * Read-only on purpose: approving means reviewing, which is the Coordinator's job, so nothing here can approve,
 * merge, claim or start anything. It listens on 127.0.0.1 only. Its observer state lives in memory, so it never
 * repeats news to (or hides news from) the Coordinator's `foreman observe`, and the watchdog doesn't take it for
 * a Coordinator watching the PRs.
 *   GET /             the page (dashboard.html)
 *   GET /api/state    the snapshot below, as JSON
 *   GET /api/events   server-sent events: "event" (one feed line) and "state" (a new snapshot)
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadAdapter } from './env/index.mjs';
import { read as notifySettings, waiting } from './notify.mjs';
import { round } from './observe.mjs';
import { previews } from './previews.mjs';
import { agentActivity, observerRound } from './sessions.mjs';
import { readCrew } from './state.mjs';
import { why } from './sh.mjs';
import { paths as watchdogPaths, summary as watchdogSummary } from './watchdog.mjs';

const PAGE = new URL('./dashboard.html', import.meta.url);
const KEEP_EVENTS = 200;

/**
 * Everything the page shows. A part that fails (no Docker, no Neon key) is { error } instead of failing the rest.
 */
export async function snapshot(config) {
	const crew = await readCrew(config);
	const slug = `${crew.repo.owner.login}/${crew.repo.name}`;
	const url = (kind, n) => `https://github.com/${slug}/${kind}/${n}`;
	const soft = async (fn) => { try { return await fn(); } catch (e) { return { error: why(e) }; } };
	const shown = await soft(() => previews(crew.repo, crew.prs));
	const adapter = await loadAdapter(config);
	const activity = await soft(() => agentActivity(config.root));
	return {
		repo: slug,
		base: config.baseBranch,
		generatedAt: Date.now(),
		runs: crew.runs.map((r) => ({ workflow: r.workflowName, status: r.status, conclusion: r.conclusion, title: r.displayTitle, event: r.event })),
		builders: crew.issues.map((i) => ({ number: i.number, title: i.title, url: url('issues', i.number), branch: i.branch, port: i.port, launchedAt: i.launch?.createdAt ?? '' })),
		prs: crew.prs.map((p) => ({
			number: p.number, title: p.title, url: url('pull', p.number), branch: p.headRefName, head: p.headRefOid,
			draft: p.isDraft, conflicts: p.mergeable === 'CONFLICTING', behind: p.mergeStateStatus === 'BEHIND',
			closes: p.foreman.closes, failed: p.foreman.failed, running: p.foreman.running, queued: p.foreman.queued, checks: p.foreman.checks,
			approvedAtHead: p.foreman.approvedAtHead, approvedBefore: p.foreman.approvedBefore, ready: p.foreman.ready, risky: p.foreman.risky,
			previews: shown[p.number] ?? [],
		})),
		merged: crew.merged.map((p) => ({ number: p.number, title: p.title, url: url('pull', p.number), mergedAt: p.mergedAt })),
		people: await soft(() => waiting(config)),
		environments: adapter.name === 'none' ? null : await soft(async () => (await adapter.list()).map((e) => ({ adapter: e.adapter ?? adapter.name, name: e.name, port: e.port, folder: e.folder, orphaned: Boolean(e.folder) && !existsSync(e.folder) }))),
		agents: { lastActiveAt: activity.lastActiveAt ?? 0, checkout: activity.checkout ?? '', limited: activity.limited ?? null, observerAt: observerRound(config.root).at },
		watchdog: watchdogSummary(config),
		notify: notifySettings(config.root).targets.map((t) => t.type),
	};
}

/** Start the server; resolves to { url, close } once it listens. */
export async function serve(config, { port = 4477, host = '127.0.0.1', take = snapshot, observeRound = round, intervalSeconds = config.observe.intervalSeconds } = {}) {
	const clients = new Set();
	const events = [];
	let current = null, refreshing = null;
	const push = (type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
	const emit = (e) => { const ev = { at: Date.now(), ...e }; events.push(ev); events.splice(0, events.length - KEEP_EVENTS); push('event', ev); };
	const refresh = () => (refreshing ??= (async () => {
		try { current = await take(config); } catch (e) { current = { ...(current ?? {}), error: why(e), generatedAt: Date.now() }; }
		refreshing = null;
		push('state', current);
		return current;
	})());

	// The feed: the observer's rounds (the first only sets the baseline) and new watchdog log lines.
	const adapter = await loadAdapter(config);
	const state = { prs: null, checks: {}, main: {}, mem: 'ok' };
	let log = '', logSize = 0;
	try { log = watchdogPaths(config.root).log; logSize = statSync(log).size; } catch {}
	let first = true, stopped = false, timer = null;
	const loop = async () => {
		try {
			const found = await observeRound(config, state, adapter);
			if (!first) for (const e of found) emit({ kind: e.kind, text: e.text, pr: e.pr ?? null });
			first = false;
		} catch (e) { emit({ kind: 'error', text: `observe round failed: ${why(e)}` }); }
		try {
			const size = log ? statSync(log).size : 0;
			if (size > logSize) {
				const added = readFileSync(log, 'utf8').slice(logSize).split('\n').filter(Boolean);
				for (const line of added) emit({ kind: 'watchdog', text: line.replace(/^\S+ \S+\s+/, '') });
			}
			logSize = size;
		} catch {}
		await refresh();
		if (!stopped) timer = setTimeout(loop, intervalSeconds * 1000);
	};

	const server = createServer(async (req, res) => {
		// Only a Host naming this machine: a page on another site can't reach it through DNS rebinding.
		if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403).end(); return; }
		const path = new URL(req.url, 'http://x').pathname;
		if (req.method !== 'GET') { res.writeHead(405).end(); return; }
		if (path === '/') {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
			res.end(readFileSync(PAGE, 'utf8'));
		} else if (path === '/api/state') {
			const s = current ?? (await refresh());
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify(s));
		} else if (path === '/api/events') {
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
			res.write(`event: hello\ndata: ${JSON.stringify({ events, intervalSeconds })}\n\n`);
			clients.add(res);
			req.on('close', () => clients.delete(res));
		} else {
			res.writeHead(404).end();
		}
	});
	await new Promise((done, fail) => { server.once('error', fail); server.listen(Number(port), host, done); });
	const url = `http://${host}:${server.address().port}`;
	loop();
	return {
		url,
		close: () => new Promise((done) => { stopped = true; clearTimeout(timer); for (const res of clients) res.end(); server.close(done); }),
	};
}

export async function dashboard(config, { port, open = false } = {}) {
	let s;
	try {
		s = await serve(config, { port: port ?? 4477 });
	} catch (e) {
		if (e.code === 'EADDRINUSE') throw new Error(`port ${port ?? 4477} is in use (another dashboard?): try --port <another>`);
		throw e;
	}
	console.log(`foreman dashboard: ${s.url} (read-only; Ctrl-C stops it)`);
	if (open) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [s.url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
	await new Promise(() => {}); // Until interrupted.
}
