/**
 * `foreman notify` (targets, events, sending once per key, issues waiting on people), observe's rounds and
 * `foreman dashboard`, against stand-ins for a webhook and gh.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../lib/config.mjs';
import { serve } from '../lib/dashboard.mjs';
import { check, command, read, send } from '../lib/notify.mjs';
import { round } from '../lib/observe.mjs';
import { live } from '../lib/previews.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (p) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };
const repo = () => {
	const dir = temp('foreman-notify-');
	execFileSync('git', ['init', '-q', '-b', 'main', dir]);
	execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/app.git']);
	return { ...DEFAULTS, root: dir };
};
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

/** A webhook that records what it's sent; `fail` makes it answer 500. */
async function hook() {
	const got = [];
	const h = { got, fail: false };
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => { body += c; });
		req.on('end', () => { got.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) }); res.writeHead(h.fail ? 500 : 200).end('ok'); });
	});
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	after(() => server.close());
	h.url = `http://127.0.0.1:${server.address().port}`;
	return h;
}

/** gh answering from a JSON file: { graphql, runs, prs } (the parts these tests need). */
function fakeGh(answers) {
	const bin = temp('foreman-gh-');
	writeFileSync(join(bin, 'answers.json'), JSON.stringify(answers));
	writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const a = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(bin, 'answers.json'))}, 'utf8'));
const args = process.argv.slice(2);
const q = args.find((x) => x.startsWith('query=')) ?? '';
if (args[0] === 'api' && args[1] === 'graphql') console.log(JSON.stringify(q.includes('search(') ? a.search : a.deployments));
else if (args[0] === 'run') console.log(JSON.stringify(a.runs ?? []));
else if (args[0] === 'pr') console.log(JSON.stringify(a.prs ?? []));
else if (args[0] === 'repo') console.log(JSON.stringify({ owner: { login: 'acme' }, name: 'app' }));
else { console.error('fake gh: ' + args.join(' ')); process.exit(2); }
`);
	chmodSync(join(bin, 'gh'), 0o755);
	writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}'); // The stand-in uses require().
	const before = process.env.PATH;
	process.env.PATH = `${bin}:${before}`;
	return { restore: () => { process.env.PATH = before; }, set: (next) => writeFileSync(join(bin, 'answers.json'), JSON.stringify(next)) };
}

test('notify: add, list, on/off and remove keep targets in the shared git folder', async () => {
	const config = repo();
	await quiet(() => command(config, ['add', 'slack', '$SLACK_URL']));
	await quiet(() => command(config, ['add', 'ntfy', 'my-topic'], { server: 'https://ntfy.example' }));
	await quiet(() => command(config, ['off', 'base-failed']));
	await quiet(() => command(config, ['on', 'merged']));
	const s = read(config.root);
	assert.deepEqual(s.targets, [{ type: 'slack', url: '$SLACK_URL' }, { type: 'ntfy', topic: 'my-topic', server: 'https://ntfy.example' }]);
	assert.equal(s.events['base-failed'], false);
	assert.equal(s.events.merged, true);
	assert.equal(s.events['needs-people'], true, 'defaults stay');
	const file = join(config.root, '.git/foreman/notify.json');
	assert.equal(readFileSync(file, 'utf8').includes('my-topic'), true);
	await quiet(() => command(config, ['remove', '1']));
	assert.deepEqual(read(config.root).targets.map((t) => t.type), ['ntfy']);
	await assert.rejects(command(config, ['add', 'pager', 'x']), /usage/);
	await assert.rejects(command(config, ['on', 'everything']), /usage/);
	await assert.rejects(command(config, ['add', 'slack', 'not a url']));
});

test('notify: each target gets its own payload, an event goes once per key, a failed one is retried', async () => {
	const h = await hook();
	const config = repo();
	process.env.FOREMAN_TEST_HOOK = `${h.url}/slack`;
	await quiet(() => command(config, ['add', 'slack', '$FOREMAN_TEST_HOOK']));
	await quiet(() => command(config, ['add', 'discord', `${h.url}/discord`]));
	await quiet(() => command(config, ['add', 'ntfy', 'topic-1'], { server: `${h.url}/`, token: 'tok' }));
	await quiet(() => command(config, ['add', 'webhook', `${h.url}/hook`]));
	const event = { kind: 'needs-people', key: 'needs-people:12:decision', title: '#12 needs you', text: 'Pick a colour', url: 'https://github.com/acme/app/issues/12', urgent: true };
	const r = await send(config, event);
	assert.deepEqual(r, { sent: ['slack', 'discord', 'ntfy', 'webhook'], failed: [] });
	const by = Object.fromEntries(h.got.map((g) => [g.path, g]));
	assert.match(by['/slack'].body.text, /^\*acme\/app: #12 needs you\*\nPick a colour\n<https:\/\/github.com/);
	assert.match(by['/discord'].body.content, /\*\*acme\/app: #12 needs you\*\*/);
	assert.deepEqual([by['/'].auth, by['/'].body.topic, by['/'].body.priority, by['/'].body.click], ['Bearer tok', 'topic-1', 4, event.url]);
	assert.equal(by['/hook'].body.kind, 'needs-people');
	assert.equal(await send(config, event), null, 'the same key is not sent twice');
	assert.equal(await send(config, { ...event, kind: 'merged', key: 'merged:1' }), null, 'events that are off are not sent');
	h.fail = true;
	h.got.length = 0;
	assert.equal((await send(config, { ...event, key: 'needs-people:13:decision' })).sent.length, 0);
	h.fail = false;
	assert.equal((await send(config, { ...event, key: 'needs-people:13:decision' })).sent.length, 4, 'a key nothing reached is released');
	delete process.env.FOREMAN_TEST_HOOK;
});

test('notify: a command target, with the event filled in', async () => {
	const config = repo();
	const out = join(config.root, 'out.txt');
	await quiet(() => command(config, ['add', 'command', 'node', '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, process.argv.slice(1).join('|'))`, '{kind}', '{title}', '{url}']));
	await send(config, { kind: 'base-failed', key: 'base-failed:1', title: 'main CI failure', text: 't', url: 'u' });
	assert.equal(readFileSync(out, 'utf8'), 'base-failed|acme/app: main CI failure|u');
});

test('notify check: labeled issues once each, again after the label comes back; a red base once', async () => {
	const h = await hook();
	const config = repo();
	await quiet(() => command(config, ['add', 'webhook', h.url]));
	const issue = { __typename: 'Issue', number: 12, title: 'Pick a colour', url: 'https://github.com/acme/app/issues/12', comments: { nodes: [{ body: 'Blue or green?\n\nEither works.' }] } };
	const runs = [{ workflowName: 'CI', status: 'completed', conclusion: 'failure', displayTitle: 'Add login', databaseId: 99, url: 'https://x/run/99' }];
	const gh = fakeGh({ search: { data: { l0: { nodes: [issue] }, l1: { nodes: [] } } }, runs });
	try {
		assert.equal(await check(config), 2);
		assert.deepEqual(h.got.map((g) => g.body.kind), ['needs-people', 'base-failed']);
		assert.match(h.got[0].body.text, /Pick a colour\nBlue or green\? Either works\./);
		assert.equal(await check(config), 0, 'nothing new');
		gh.set({ search: { data: { l0: { nodes: [] }, l1: { nodes: [] } } }, runs });
		await check(config);
		gh.set({ search: { data: { l0: { nodes: [issue] }, l1: { nodes: [] } } }, runs });
		assert.equal(await check(config), 1, 'labeled again: sent again');
	} finally {
		gh.restore();
	}
});

test('previews: the newest deployment per environment, only live ones, never production', () => {
	assert.deepEqual(live([
		{ environment: 'Preview – app', latestStatus: { state: 'SUCCESS', environmentUrl: 'https://new.vercel.app' } },
		{ environment: 'Preview – app', latestStatus: { state: 'SUCCESS', environmentUrl: 'https://old.vercel.app' } },
		{ environment: 'Preview – docs', latestStatus: { state: 'IN_PROGRESS', environmentUrl: '' } },
		{ environment: 'Production – app', latestStatus: { state: 'SUCCESS', environmentUrl: 'https://app.com' } },
	]), [{ environment: 'Preview – app', url: 'https://new.vercel.app' }]);
});

test('observe round: checks and previews as events, with what a person may want to hear', async () => {
	const config = repo();
	const pr = (state) => ({ number: 5, title: 'Add login', url: 'https://github.com/acme/app/pull/5', headRefName: 'login', headRefOid: 'abc', statusCheckRollup: [{ __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: state }] });
	const deployments = (url) => ({ data: { repository: { p5: { deployments: { nodes: url ? [{ environment: 'Preview', latestStatus: { state: 'SUCCESS', environmentUrl: url } }] : [] } } } } });
	const gh = fakeGh({ prs: [pr('SUCCESS')], deployments: deployments(''), runs: [] });
	const state = { prs: null, checks: {}, main: {}, mem: 'ok' };
	const adapter = { usesDocker: false };
	try {
		assert.deepEqual((await round(config, state, adapter)).map((e) => e.kind), ['checks-passed']);
		gh.set({ prs: [pr('FAILURE')], deployments: deployments('https://pr-5.vercel.app'), runs: [{ workflowName: 'CI', status: 'completed', conclusion: 'failure', displayTitle: 'x', databaseId: 7, event: 'push', url: 'u' }] });
		const events = await round(config, state, adapter);
		assert.deepEqual(events.map((e) => e.kind), ['checks-failed', 'preview', 'base-failed']);
		assert.equal(events[0].notify.key, 'checks-failed:5:abc');
		assert.match(events[1].text, /ready at https:\/\/pr-5\.vercel\.app/);
		assert.equal(events[2].notify.key, 'base-failed:7');
		assert.deepEqual(await round(config, state, adapter), [], 'nothing repeats');
	} finally {
		gh.restore();
	}
});

test('dashboard: serves the page, the snapshot and a live feed, read-only and to this machine only', async () => {
	const config = repo();
	mkdirSync(join(config.root, '.git/foreman/watchdog'), { recursive: true });
	writeFileSync(join(config.root, '.git/foreman/watchdog/watchdog.log'), '2026-10-27 09:00  an older round · not news\n');
	let rounds = 0;
	const observeRound = async () => (rounds++ === 0 ? [{ kind: 'pr-opened', text: 'baseline: not news' }] : [{ kind: 'checks-passed', text: 'checks: #5 passed', pr: 5 }]);
	const d = await serve(config, { port: 0, take: async () => ({ repo: 'acme/app', prs: [], n: rounds }), observeRound, intervalSeconds: 0.05 });
	try {
		const page = await (await fetch(d.url)).text();
		assert.match(page, /<title>foreman<\/title>/);
		assert.equal((await (await fetch(`${d.url}/api/state`)).json()).repo, 'acme/app');
		assert.equal((await fetch(`${d.url}/api/state`, { method: 'POST' })).status, 405);
		const port = new URL(d.url).port;
		const rebound = await new Promise((done) => {
			import('node:http').then(({ request }) => request({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example' } }, (res) => done(res.statusCode)).end());
		});
		assert.equal(rebound, 403, 'a Host that is not this machine is refused');
		const res = await fetch(`${d.url}/api/events`);
		const reader = res.body.getReader();
		let text = '';
		while (!text.includes('checks: #5 passed')) text += new TextDecoder().decode((await reader.read()).value);
		assert.doesNotMatch(text, /baseline|older round/, 'what was there before it started isn\'t news');
		// The watchdog's log: whole new lines only, read as bytes (a summary with "…" before it mustn't shift them).
		const log = join(config.root, '.git/foreman/watchdog/watchdog.log');
		appendFileSync(log, '2026-10-27 10:00  Coordinator ended: merged #5 … waiting on #6\n2026-10-27 10:15  half a li');
		while (!text.includes('waiting on #6')) text += new TextDecoder().decode((await reader.read()).value);
		appendFileSync(log, 'ne, now whole\n');
		while (!text.includes('now whole')) text += new TextDecoder().decode((await reader.read()).value);
		assert.match(text, /merged #5 … waiting on #6/);
		assert.match(text, /"half a line, now whole"/);
		reader.cancel();
	} finally {
		await d.close();
	}
});
