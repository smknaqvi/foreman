/**
 * `foreman notify`: tell a person when something needs them, wherever they are: Slack, Discord, ntfy (a
 * phone app), any webhook, a command of your own, or macOS's notifications.
 * Targets belong to the machine, not the repo: webhook URLs are secrets, so they're kept in the repo's shared
 * git folder (<git common dir>/foreman/notify.json, never committed) and set with `foreman notify add`. A
 * value starting with "$" is read from that environment variable when sending.
 * Who sends: `foreman observe` (while a Coordinator watches), every watchdog round (even when it has nothing
 * else to do) and `foreman notify check` (for cron). Every event has a key, and only the process that first
 * claims a key sends it, so several senders never repeat one.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gh, git, why } from './sh.mjs';

export const KINDS = {
	'needs-people': { on: true, about: 'an open issue or PR labeled for people (labels.decision, labels.needsInput), with its latest comment' },
	'base-failed': { on: true, about: 'the base branch\'s CI failed' },
	limit: { on: true, about: 'the newest agent session stopped at a usage limit with work in flight' },
	coordinator: { on: true, about: 'the watchdog started a Coordinator, or one ended (with its summary)' },
	held: { on: true, about: 'the watchdog won\'t start another Coordinator (the last ended with the same work in flight, or maxSessionsPerDay)' },
	merged: { on: false, about: 'the watchdog merged an approved PR' },
	'checks-failed': { on: false, about: 'a PR\'s checks failed' },
	preview: { on: false, about: 'a PR\'s preview deployment is ready' },
};
export const TYPES = ['slack', 'discord', 'ntfy', 'webhook', 'command', 'macos'];
const KEEP_DAYS = 30; // Sent keys older than this are forgotten.
const PEOPLE_EVERY_MS = 4 * 60000; // `foreman observe` looks for labeled issues at most this often.

// ---- settings ---------------------------------------------------------------------------------------

export function paths(root) {
	const dir = join(git('-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'foreman');
	return { file: join(dir, 'notify.json'), sent: join(dir, 'notified') };
}

export function read(root) {
	let s = {};
	try { s = JSON.parse(readFileSync(paths(root).file, 'utf8')); } catch {}
	const events = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, s.events?.[k] ?? v.on]));
	return { targets: Array.isArray(s.targets) ? s.targets : [], events };
}

function write(root, s) {
	const { file } = paths(root);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(`${file}.tmp`, `${JSON.stringify(s, null, '\t')}\n`, { mode: 0o600 });
	renameSync(`${file}.tmp`, file);
}

/**
 * Where an event goes: the configured targets if it's switched on. With no targets at all, macOS still shows
 * the watchdog's Coordinator notifications, as it did before targets existed.
 */
export function targetsFor(root, kind) {
	if (process.env.FOREMAN_NO_NOTIFY) return [];
	const s = read(root);
	if (!s.targets.length) return kind === 'coordinator' && process.platform === 'darwin' ? [{ type: 'macos' }] : [];
	return s.events[kind] ? s.targets : [];
}

// ---- sending ----------------------------------------------------------------------------------------

/** "owner/repo" from origin, or the checkout's folder name. */
export function repoName(root) {
	try { return git('-C', root, 'remote', 'get-url', 'origin').replace(/\.git$/, '').split(/[/:]/).slice(-2).join('/'); } catch { return basename(root); }
}

const keyFile = (dir, key) => join(dir, `${key.replace(/[^\w.-]+/g, '_').slice(0, 80)}-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`);

/** Claim `key` for this process: false if another sender already has (atomic: exclusive create). */
function claim(root, key) {
	const { sent } = paths(root);
	mkdirSync(sent, { recursive: true });
	try { closeSync(openSync(keyFile(sent, key), 'wx')); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
	writeFileSync(keyFile(sent, key), `${key}\n`);
	return true;
}

/** Let an event with this key be sent again (an issue that lost its label, say, and may get it back). */
export function release(root, key) {
	rmSync(keyFile(paths(root).sent, key), { force: true });
}

/** Keys claimed so far, optionally only those starting with `prefix`. */
function claimed(root, prefix = '') {
	const { sent } = paths(root);
	let names = [];
	try { names = readdirSync(sent); } catch { return []; }
	const old = Date.now() - KEEP_DAYS * 86400000;
	return names.flatMap((n) => {
		const file = join(sent, n);
		try {
			if (statSync(file).mtimeMs < old) { rmSync(file, { force: true }); return []; }
			const key = readFileSync(file, 'utf8').trim();
			return key.startsWith(prefix) ? [key] : [];
		} catch { return []; }
	});
}

/**
 * Send `event` ({ kind, key, title, text, url?, urgent? }) to every target that wants it, once per key.
 * Never throws: a notification that can't be sent is reported in the result (and its key released, so a
 * later round tries again). → { sent: [target type], failed: [message] }, or null if nothing was due.
 */
export async function send(config, event) {
	const root = config.root;
	let targets;
	try { targets = targetsFor(root, event.kind); } catch { return null; }
	if (!targets.length) return null;
	try { if (event.key && !claim(root, event.key)) return null; } catch { return null; }
	const repo = repoName(root);
	const out = { sent: [], failed: [] };
	for (const t of targets) {
		try { await deliver(t, { ...event, repo }); out.sent.push(t.type); } catch (e) { out.failed.push(`${t.type}: ${e.message}`); }
	}
	if (!out.sent.length && event.key) release(root, event.key);
	return out;
}

const secret = (v) => (typeof v === 'string' && v.startsWith('$') ? process.env[v.slice(1)] ?? '' : v ?? '');

async function post(url, body, headers = {}) {
	if (!url) throw new Error('no URL (an unset $VARIABLE?)');
	const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
	if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
}

/** One notification to one target. Throws if it didn't go. */
export async function deliver(t, e) {
	const title = `${e.repo}: ${e.title}`;
	switch (t.type) {
		case 'slack':
			return post(secret(t.url), { text: `*${title}*\n${e.text}${e.url ? `\n<${e.url}>` : ''}` });
		case 'discord':
			return post(secret(t.url), { content: `**${title}**\n${e.text}${e.url ? `\n${e.url}` : ''}`.slice(0, 2000) });
		case 'ntfy': {
			// JSON publishing (to the server's root), so titles needn't be plain ASCII the way headers must.
			const token = secret(t.token);
			return post((secret(t.server) || 'https://ntfy.sh').replace(/\/$/, ''), {
				topic: secret(t.topic), title, message: e.text, priority: e.urgent ? 4 : 3, ...(e.url ? { click: e.url } : {}), tags: [e.kind],
			}, token ? { Authorization: `Bearer ${token}` } : {});
		}
		case 'webhook':
			return post(secret(t.url), { kind: e.kind, repo: e.repo, title: e.title, text: e.text, url: e.url ?? '', urgent: Boolean(e.urgent), at: new Date().toISOString() });
		case 'command': {
			const fill = (a) => a.replaceAll('{title}', title).replaceAll('{text}', e.text).replaceAll('{url}', e.url ?? '').replaceAll('{kind}', e.kind);
			const [cmd, ...args] = (t.command ?? []).map(fill);
			if (!cmd) throw new Error('no command');
			const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'ignore', 'pipe'] });
			if (r.error || r.status !== 0) throw new Error(r.error?.message ?? `exit ${r.status}: ${r.stderr.trim().slice(0, 120)}`);
			return;
		}
		case 'macos': {
			if (process.platform !== 'darwin') throw new Error('macOS only');
			const q = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;
			const r = spawnSync('osascript', ['-e', `display notification ${q(e.text.slice(0, 200))} with title ${q(title)}`], { stdio: 'ignore' });
			if (r.status !== 0) throw new Error('osascript failed');
			return;
		}
		default:
			throw new Error(`unknown target type "${t.type}"`);
	}
}

// ---- what to look for -------------------------------------------------------------------------------

/**
 * Issues and PRs waiting on people, and the base branch's newest failed run: sent once each. An item whose
 * label went away is released, so labeling it again sends again. Returns how many were sent.
 */
export async function check(config) {
	const root = config.root;
	let n = 0;
	if (targetsFor(root, 'needs-people').length) {
		const now = new Set();
		for (const item of waiting(config)) {
			const key = `needs-people:${item.number}:${item.label}`;
			now.add(key);
			const r = await send(config, { kind: 'needs-people', key, urgent: true, url: item.url, title: `#${item.number} needs you (${item.label})`, text: `${item.title}${item.comment ? `\n${item.comment.slice(0, 400)}${item.comment.length > 400 ? '…' : ''}` : ''}` });
			if (r?.sent.length) n++;
		}
		for (const key of claimed(root, 'needs-people:')) if (!now.has(key)) release(root, key);
	}
	if (targetsFor(root, 'base-failed').length) {
		const runs = gh('run', 'list', '--branch', config.baseBranch, '--event', 'push', '--limit', '10', '--json', 'workflowName,conclusion,status,displayTitle,databaseId,url');
		const latest = {};
		for (const r of runs) latest[r.workflowName] ??= r;
		for (const r of Object.values(latest)) if (r.status === 'completed' && !['success', 'skipped', 'neutral'].includes(r.conclusion)) {
			const sent = await send(config, baseFailed(config, r));
			if (sent?.sent.length) n++;
		}
	}
	return n;
}

/**
 * Open issues and PRs labeled for people (labels.decision, labels.needsInput), in one GraphQL search:
 * [{ number, title, url, label, isPr, comment }], `comment` being the latest comment (usually what's needed).
 */
export function waiting(config) {
	const repo = repoName(config.root);
	const labels = [...new Set([config.labels.decision, config.labels.needsInput].filter(Boolean))];
	const fields = 'number title url comments(last:1){nodes{body}}';
	const one = (label, i) => `l${i}:search(query:${JSON.stringify(`repo:${repo} is:open label:"${label}"`)},type:ISSUE,first:30){nodes{__typename ...on Issue{${fields}} ...on PullRequest{${fields}}}}`;
	const data = gh('api', 'graphql', '-f', `query={${labels.map(one).join(' ')}}`).data;
	return labels.flatMap((label, i) => data[`l${i}`].nodes.filter((x) => x.number).map((x) => ({
		number: x.number, title: x.title, url: x.url, label, isPr: x.__typename === 'PullRequest',
		comment: x.comments?.nodes?.[0]?.body?.trim().replace(/\s+/g, ' ') ?? '',
	})));
}

/** The event for a failed run on the base branch (the same key from observe and check, so it goes once). */
export const baseFailed = (config, r) => ({ kind: 'base-failed', key: `base-failed:${r.databaseId}`, urgent: true, url: r.url, title: `${config.baseBranch} CI ${r.conclusion}`, text: `${r.workflowName}: ${r.displayTitle}` });

/** For `foreman observe`: run check() at most every few minutes, remembering when in `state`. */
export async function checkNow(config, state) {
	if (Date.now() - (state.peopleCheckedAt ?? 0) < PEOPLE_EVERY_MS) return;
	state.peopleCheckedAt = Date.now();
	try { await check(config); } catch {}
}

// ---- the command ------------------------------------------------------------------------------------

const mask = (t) => {
	const v = t.url ?? (t.type === 'ntfy' ? `${secret(t.server) || 'https://ntfy.sh'}/${t.topic}` : t.command?.join(' ') ?? '');
	if (typeof v === 'string' && v.startsWith('$')) return v;
	try { const u = new URL(v); return `${u.host}/…${u.pathname.slice(-4)}`; } catch { return String(v); }
};

export async function command(config, [sub = 'list', ...args], flags = {}) {
	const root = config.root;
	const s = read(root);
	const stored = (() => { try { return JSON.parse(readFileSync(paths(root).file, 'utf8')); } catch { return {}; } })();
	switch (sub) {
		case 'list': {
			console.log(`Notifications (${paths(root).file})`);
			if (!s.targets.length) console.log(`  no targets${process.platform === 'darwin' ? ' (macOS still shows the watchdog\'s Coordinator notifications)' : ''}: npx --no-install foreman notify add <${TYPES.join('|')}> …`);
			s.targets.forEach((t, i) => console.log(`  ${i + 1}. ${t.type} ${mask(t)}`));
			console.log('\nEvents (notify on|off <event>)');
			for (const [k, v] of Object.entries(KINDS)) console.log(`  ${s.events[k] ? 'on ' : 'off'}  ${k.padEnd(14)}${v.about}`);
			if (s.targets.length && !existsSync(join(paths(root).file, '..', 'watchdog', 'state.json'))) console.log('\nThe watchdog checks every round; without it, labeled issues are only seen while foreman observe runs (or from cron: npx --no-install foreman notify check).');
			return 0;
		}
		case 'add': {
			const [type, ...rest] = args;
			if (!TYPES.includes(type)) throw new Error(`usage: foreman notify add <${TYPES.join('|')}> …`);
			let t;
			if (type === 'macos') t = { type };
			else if (type === 'command') { if (!rest.length) throw new Error('usage: foreman notify add command <program> [args…] ({title} {text} {url} {kind} are filled in)'); t = { type, command: rest }; }
			else if (type === 'ntfy') { if (!rest[0]) throw new Error('usage: foreman notify add ntfy <topic> [--server <url>] [--token <token or $VAR>]'); t = { type, topic: rest[0], ...(flags.server ? { server: flags.server } : {}), ...(flags.token ? { token: flags.token } : {}) }; }
			else {
				if (!rest[0]) throw new Error(`usage: foreman notify add ${type} <webhook URL or $VARIABLE>`);
				if (!rest[0].startsWith('$')) new URL(rest[0]);
				t = { type, url: rest[0] };
			}
			write(root, { ...stored, targets: [...s.targets, t] });
			console.log(`Added ${type} ${mask(t)}. Try it: npx --no-install foreman notify test`);
			return 0;
		}
		case 'remove': {
			const i = Number(args[0]) - 1;
			if (!s.targets[i]) throw new Error('usage: foreman notify remove <number from notify list>');
			write(root, { ...stored, targets: s.targets.filter((_, j) => j !== i) });
			console.log(`Removed ${s.targets[i].type} ${mask(s.targets[i])}.`);
			return 0;
		}
		case 'on': case 'off': {
			const bad = args.filter((k) => !KINDS[k]);
			if (!args.length || bad.length) throw new Error(`usage: foreman notify ${sub} <event…> (events: ${Object.keys(KINDS).join(', ')})`);
			write(root, { ...stored, events: { ...(stored.events ?? {}), ...Object.fromEntries(args.map((k) => [k, sub === 'on'])) } });
			console.log(`${args.join(', ')}: ${sub}.`);
			return 0;
		}
		case 'test': {
			if (!s.targets.length) { console.log('No targets yet: npx --no-install foreman notify add …'); return 1; }
			const repo = repoName(root);
			let failed = 0;
			for (const t of s.targets) {
				try { await deliver(t, { kind: 'test', repo, title: 'test', text: 'foreman can reach you here.' }); console.log(`  ok    ${t.type} ${mask(t)}`); } catch (e) { failed++; console.log(`  FAIL  ${t.type} ${mask(t)}: ${e.message}`); }
			}
			return failed ? 1 : 0;
		}
		case 'check': {
			try {
				const n = await check(config);
				console.log(n ? `Sent ${n} notification${n > 1 ? 's' : ''}.` : 'Nothing new.');
				return 0;
			} catch (e) {
				console.error(`Couldn't check: ${why(e)}`);
				return 1;
			}
		}
		default:
			throw new Error(`unknown notify command "${sub}" (list, add, remove, on, off, test, check)`);
	}
}
