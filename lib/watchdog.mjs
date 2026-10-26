/**
 * `foreman watchdog`: keeps the crew going when every agent has stopped, typically at a usage limit, with
 * nobody around to start a new session. It's a plain program, run every few minutes by launchd (macOS) or
 * cron, and needs no AI to decide anything. A round (`watchdog run`):
 *   1. does nothing if paused, if a Coordinator it started is still running, or if nothing is in flight
 *      (no claimed issue, no approved PR);
 *   2. does nothing while agents are working: it acts only once the newest agent session in this repo
 *      stopped at a usage limit (read from Claude Code's transcripts, lib/sessions.mjs), or, if
 *      `staleMinutes` is set, when no agent has done anything for that long;
 *   3. runs `foreman tick` (merges approved, green PRs; removes orphaned environments). That needs no AI, so
 *      it happens even before the limit resets;
 *   4. once the limit has reset, starts a Coordinator in the background (`command`, `claude -p` by default)
 *      in its own worktree (`dir`), told to finish the work in flight and nothing else.
 * A session that hits the limit again just ends; a later round tries again. One that ends normally isn't
 * restarted until the work in flight changes, and at most `maxSessionsPerDay` start in a day.
 * State, log and session output live in the repo's shared git folder (<git common dir>/foreman/watchdog), so
 * `foreman watchdog status` reads the same from any worktree.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentActivity, observerRound, resetTime } from './sessions.mjs';
import { inFlight, readCrew } from './state.mjs';
import { git, why } from './sh.mjs';
import { tick } from './tick.mjs';

export const DEFAULT_PROMPT = `foreman's watchdog started this session: work is in flight in this repo, and the last agent session stopped (most likely at a usage limit) with nobody to pick it up. You are the Coordinator, running unattended: nobody will answer questions, so don't ask any.

1. Read AGENTS.md (or CLAUDE.md) and .claude/skills/coordinate-agents/SKILL.md, then follow its "Resuming after an interruption" section, starting with \`npx --no-install foreman status\`.
2. Finish only what's already under way: issues a Builder claimed, the PRs open for them, approved PRs. Don't claim new issues.
3. Run Builders in the foreground (the Agent tool with run_in_background: false; several in one message run at the same time), so this session lasts until they're done. Don't end your turn while a Builder is still working.
4. Review, approve and merge exactly as the playbook says. Leave anything that needs a person (a decision, an account, a change you're unsure about), with a comment on its issue or PR saying what's needed.
5. Don't run \`foreman watchdog\` commands.

End with a short summary: what merged, and what's waiting on whom.`;

const IDLE_MINUTES = 10; // No agent active this long: `tick` may merge approved PRs a Builder hasn't.
const OBSERVER_FRESH_MINUTES = 5; // An Observer round this recent (or within 3 intervals) means a Coordinator is watching.
const ROUND_LOCK_HOURS = 3; // A round's lock older than this was left by a killed round.
const UNKNOWN_RESET_MINUTES = 60; // A limit message whose reset time can't be read: try again this long after it.

// ---- where things are -------------------------------------------------------------------------------

export function paths(root) {
	const common = git('-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
	const dir = join(common, 'foreman', 'watchdog');
	return { dir, state: join(dir, 'state.json'), log: join(dir, 'watchdog.log'), paused: join(dir, 'paused'), lock: join(dir, 'round.lock'), sessions: join(dir, 'sessions') };
}

/**
 * The Coordinator's own worktree: `watchdog.dir` (relative to the main checkout, so it's the same folder from
 * every worktree), or "<main checkout>-foreman" beside the main checkout.
 */
export function coordinatorDir(config) {
	const main = git('-C', config.root, 'worktree', 'list', '--porcelain').split('\n')[0].replace(/^worktree /, '');
	if (config.watchdog.dir) return resolve(main, config.watchdog.dir.replace(/^~(?=\/|$)/, homedir()));
	return `${main}-foreman`;
}

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => { writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, '\t')}\n`); renameSync(`${file}.tmp`, file); };
const stamp = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const local = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const minutesAgo = (ms, now = Date.now()) => Math.max(0, Math.round((now - ms) / 60000));
/** Is an Observer that last finished a round at `at` (and runs every `seconds`) still running? */
export const observing = (at, seconds = 60, now = Date.now()) => Boolean(at) && now - at <= Math.max(OBSERVER_FRESH_MINUTES * 60000, 3 * seconds * 1000);
/**
 * Is the Coordinator session `s` still running? Its pid must be alive and still be our `watchdog session <id>`
 * process: after a restart the number may belong to something else.
 */
function running(s) {
	if (!s?.pid) return false;
	try { process.kill(s.pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
	const r = spawnSync('ps', ['-o', 'command=', '-p', String(s.pid)], { encoding: 'utf8' });
	return r.status === 0 && r.stdout.includes(`watchdog session ${s.id}`);
}

/** One round at a time. A lock older than ROUND_LOCK_HOURS was left by a killed round: take it over (atomically). */
function takeLock(w) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try { mkdirSync(w.lock); return true; } catch {}
		let age;
		try { age = Date.now() - statSync(w.lock).mtimeMs; } catch { continue; } // Released meanwhile: try again.
		if (age < ROUND_LOCK_HOURS * 3600 * 1000) return false;
		const stale = `${w.lock}.stale-${process.pid}`;
		try { renameSync(w.lock, stale); rmdirSync(stale); } catch { return false; } // Another round took it over.
	}
	try { mkdirSync(w.lock); return true; } catch { return false; }
}

function log(w, msg) {
	mkdirSync(w.dir, { recursive: true });
	try { if (statSync(w.log).size > 1_000_000) writeFileSync(w.log, readFileSync(w.log, 'utf8').slice(-500_000).replace(/^[^\n]*\n/, '')); } catch {}
	appendFileSync(w.log, `${stamp()}  ${msg}\n`);
}

function notify(title, message) {
	if (process.platform !== 'darwin' || process.env.FOREMAN_NO_NOTIFY) return;
	const q = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;
	spawnSync('osascript', ['-e', `display notification ${q(message)} with title ${q(title)}`], { stdio: 'ignore' });
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k]).map((k) => [k, obj[k]]));
/** This environment minus another Claude Code session's own variables (when a round is run from inside one). */
const ownEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_AGENT_SDK|CLAUDE_EFFORT$)/.test(k)));

// ---- the decision -----------------------------------------------------------------------------------

/**
 * What a round does, from a snapshot of everything it knows. Pure, so it can be tested on its own.
 *   { now, paused, sessionPid, inFlight: { items, key }, ready (approved PRs ready to merge),
 *     activity: { lastActiveAt, limited, observedAt }, observeSeconds, last, sessionsToday,
 *     settings: { staleMinutes, maxSessionsPerDay } }
 * → { tick, launch, why }
 */
export function decide(s) {
	const no = (why) => ({ tick: false, launch: false, why });
	if (s.paused) return no('paused (foreman watchdog unpause)');
	if (s.sessionPid) return no(`a Coordinator it started is still running (pid ${s.sessionPid})`);
	if (!s.inFlight.items.length) return no('nothing in flight');
	const { lastActiveAt, limited, observedAt } = s.activity;
	const idle = lastActiveAt ? minutesAgo(lastActiveAt, s.now) : Infinity;
	let stopped = '';
	if (limited) stopped = `the newest agent session stopped at a usage limit ${minutesAgo(limited.at, s.now)} min ago`;
	else if (observing(observedAt, s.observeSeconds, s.now))
		// A Coordinator's Observer is running: it's waiting on checks, not gone, and may be holding an approved PR
		// back on purpose (say, a plan update until the PRs it describes have merged). Leave merges to it.
		return no(`a Coordinator is watching the PRs (foreman observe, last round ${minutesAgo(observedAt, s.now)} min ago); merges are left to it`);
	else if (s.settings.staleMinutes && idle >= s.settings.staleMinutes) stopped = lastActiveAt ? `no agent has done anything for ${idle} min` : 'no agent session in the last day';
	if (!stopped) {
		// Agents are about, or stopped normally. Merging what's approved and green is still safe once nobody has
		// done anything for a while (the Builder would have merged it by now).
		const merge = idle >= IDLE_MINUTES && s.ready > 0;
		return { tick: merge, launch: false, why: `${lastActiveAt ? `an agent was active ${idle} min ago` : 'no agent session in the last day'}${merge ? '; merging anything approved and green' : ''}` };
	}
	const flight = `in flight: ${s.inFlight.items.join(', ')}`;
	// No readable reset time: wait a while after each stop rather than starting a session that hits the limit
	// at once every round.
	const resets = limited ? limited.resetsAt ?? limited.at + UNKNOWN_RESET_MINUTES * 60000 : 0;
	if (resets > s.now) return { tick: s.ready > 0, launch: false, why: `${stopped} (${flight}); ${limited.resetsAt ? 'the limit resets' : 'couldn\'t read when the limit resets, so trying again'} ${local(resets)}: merging what's ready, starting a Coordinator after that` };
	if (s.last && ['ended', 'stopped'].includes(s.last.outcome) && s.last.inFlight === s.inFlight.key)
		return { tick: s.ready > 0, launch: false, why: `${stopped}; the last Coordinator it started ${s.last.outcome === 'stopped' ? 'was stopped' : 'ended'} with the same work in flight (waiting on people?), so not starting another until that changes` };
	if (s.sessionsToday >= s.settings.maxSessionsPerDay)
		return { tick: s.ready > 0, launch: false, why: `${stopped}; already started ${s.sessionsToday} Coordinators in the last 24 hours (maxSessionsPerDay)` };
	return { tick: true, launch: true, why: `${stopped} (${flight}): starting a Coordinator` };
}

// ---- a round ----------------------------------------------------------------------------------------

/** Pick up a finished (or killed) session's result. */
function reap(state, w) {
	const s = state.session;
	if (!s) return;
	const result = readJson(join(w.sessions, `${s.id}.json`), null);
	if (result) {
		state.last = { ...result, inFlight: s.inFlight };
	} else if (!running(s)) {
		state.last = { id: s.id, startedAt: s.startedAt, endedAt: Date.now(), outcome: 'failed', summary: 'the session process ended without recording a result (killed, or the Mac restarted)', inFlight: s.inFlight };
	} else return;
	state.history = [...(state.history || []), state.last].slice(-50);
	state.session = null;
}

const sessionsToday = (state, now = Date.now()) => (state.history || []).filter((h) => h.startedAt > now - 24 * 3600 * 1000 && h.outcome !== 'limited').length + (state.session ? 1 : 0);

/** Everything decide() needs. GitHub and the transcripts are only read when the answer could depend on them. */
export async function snapshot(config, w, state) {
	const s = {
		now: Date.now(),
		paused: existsSync(w.paused),
		sessionPid: running(state.session) ? state.session.pid : 0,
		inFlight: { items: [], key: '' },
		ready: 0,
		activity: { lastActiveAt: 0, limited: null, observedAt: 0 },
		observeSeconds: config.observe.intervalSeconds,
		last: state.last ?? null,
		sessionsToday: sessionsToday(state),
		settings: config.watchdog,
		dir: coordinatorDir(config),
	};
	if (s.paused || s.sessionPid) return s;
	const crew = await readCrew(config);
	s.inFlight = inFlight(crew);
	if (!s.inFlight.items.length) return s;
	s.ready = crew.prs.filter((p) => p.foreman.ready).length;
	s.activity = { ...agentActivity(config.root), observedAt: observerRound(config.root).at };
	return s;
}

export async function run(config, { dryRun = false } = {}) {
	const w = paths(config.root);
	mkdirSync(w.sessions, { recursive: true });
	if (!takeLock(w)) { console.log('Another watchdog round is running.'); return 0; }
	try {
		const state = readJson(w.state, {});
		reap(state, w);
		const s = await snapshot(config, w, state);
		const d = decide(s);
		const say = (msg) => { console.log(msg); if (!dryRun) log(w, msg); };
		say(`${dryRun ? 'Would: ' : ''}${d.why}`);
		if (dryRun) return 0;
		writeJson(w.state, state);
		if (!d.tick) return 0;

		prepare(config, s.dir, say);
		// Act from the freshly prepared worktree in a new process: prepare may just have installed a newer foreman
		// than the one this round is running, and the two mustn't mix (adapters and merge.sh load from disk).
		const r = spawnSync(process.execPath, [foremanBin(s.dir), 'watchdog', 'act', ...(d.launch ? ['--launch'] : [])], { cwd: s.dir, stdio: 'inherit', env: ownEnv() });
		return r.status ?? 1;
	} catch (e) {
		log(w, `round failed: ${e.message}`);
		throw e;
	} finally {
		rmdirSync(w.lock);
	}
}

/**
 * The acting half of a round, run by `run` (which holds the lock) in the Coordinator's worktree with that
 * worktree's foreman: `tick`, then (with `launch`) start a Coordinator if anything is still in flight.
 */
export async function act(config, { launch: start = false } = {}) {
	const w = paths(config.root);
	const say = (msg) => { console.log(msg); log(w, msg); };
	try {
		const result = await tick(config, { log: (m) => say(`tick: ${m}`) });
		if (!start) return 0;
		const state = readJson(w.state, {});
		if (running(state.session)) return 0;
		const after = inFlight(await readCrew(config));
		if (!after.items.length) { say(`Nothing left in flight${result.merged.length ? ' after tick' : ''}: no Coordinator needed.`); return 0; }
		launch(config, config.root, after, state, w, say);
		writeJson(w.state, state);
		return 0;
	} catch (e) {
		say(`round failed: ${e.message}`);
		return 1;
	}
}

/** Create or refresh the Coordinator's worktree: the base branch's latest commit, then `setup`. */
export function prepare(config, dir, say = console.log) {
	const base = config.baseBranch;
	git('-C', config.root, 'fetch', '-q', 'origin', base);
	if (!existsSync(dir)) {
		git('-C', config.root, 'worktree', 'prune'); // A folder deleted by hand is still registered until pruned.
		git('-C', config.root, 'worktree', 'add', '-q', '--detach', dir, `origin/${base}`);
		say(`Made the Coordinator's worktree: ${dir}`);
	} else {
		// A Coordinator stopped mid-edit (a usage limit, typically) leaves changes behind. Keep them on a local
		// branch rather than letting them pin this worktree to an old base for good. A package-lock.json that
		// setup rewrote is just dropped: the base branch's is the one to use.
		const dirty = git('-C', dir, 'status', '--porcelain').split('\n').filter(Boolean);
		if (dirty.length && dirty.every((l) => l.slice(3) === 'package-lock.json')) git('-C', dir, 'checkout', '--', 'package-lock.json');
		else if (dirty.length) {
			const branch = `foreman/leftovers-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
			git('-C', dir, 'switch', '-q', '-c', branch);
			git('-C', dir, 'add', '-A');
			git('-C', dir, '-c', 'user.name=foreman watchdog', '-c', 'user.email=foreman@localhost', 'commit', '-q', '--no-verify', '-m', 'Uncommitted changes an earlier Coordinator left behind');
			say(`${dir} had uncommitted changes from an earlier session: kept them on the local branch ${branch}.`);
		}
		git('-C', dir, 'checkout', '-q', '--detach', `origin/${base}`);
	}
	const setup = config.watchdog.setup;
	if (setup) {
		const r = spawnSync('bash', ['-c', setup], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		if (r.status !== 0) throw new Error(`setup (${setup}) failed in ${dir}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
	}
}

function foremanBin(dir) {
	const own = readJson(join(dir, 'package.json'), {});
	if (own.name === '@smknaqvi/foreman') return join(dir, 'bin', 'foreman.mjs');
	try {
		return join(dirname(createRequire(join(dir, 'package.json')).resolve('@smknaqvi/foreman/package.json')), 'bin', 'foreman.mjs');
	} catch {
		return fileURLToPath(new URL('../bin/foreman.mjs', import.meta.url));
	}
}

function launch(config, dir, flight, state, w, say) {
	const id = new Date().toISOString().replace(/[:.]/g, '-');
	const child = spawn(process.execPath, [foremanBin(dir), 'watchdog', 'session', id], {
		cwd: dir, detached: true, stdio: 'ignore', env: { ...ownEnv(), FOREMAN_WATCHDOG_SESSION: id },
	});
	child.unref();
	state.session = { id, pid: child.pid, startedAt: Date.now(), inFlight: flight.key };
	say(`Started a Coordinator (pid ${child.pid}) in ${dir}. Its output: ${join(w.sessions, `${id}.jsonl`)}`);
	notify('foreman: Coordinator restarted', `${basename(config.root)}: ${flight.items.length} item${flight.items.length > 1 ? 's' : ''} in flight`);
}

// ---- the session itself (started detached by a round) ----------------------------------------------

/** Run the Coordinator's command, wait for it, and record how it ended. */
export async function session(config, id) {
	const w = paths(config.root);
	const settings = config.watchdog;
	mkdirSync(w.sessions, { recursive: true });
	const out = join(w.sessions, `${id}.jsonl`);
	const prompt = settings.prompt || DEFAULT_PROMPT;
	const [cmd, ...args] = settings.command.map((a) => a.replaceAll('{prompt}', prompt));
	const fd = openSync(out, 'a');
	const startedAt = Date.now();
	const r = spawnSync(cmd, args, { cwd: config.root, stdio: ['ignore', fd, fd], env: { ...ownEnv(), ...settings.env, FOREMAN_WATCHDOG_SESSION: id } });
	closeSync(fd);
	const result = { id, startedAt, endedAt: Date.now(), exit: r.status, ...classify(out, r) };
	writeJson(join(w.sessions, `${id}.json`), result);
	log(w, `Coordinator ${id} ${result.outcome}${result.sessionId ? ` (claude --resume ${result.sessionId})` : ''}: ${result.summary.slice(0, 200)}`);
	notify(`foreman: Coordinator ${result.outcome}`, `${basename(config.root)}: ${result.summary.slice(0, 120)}`);
	return 0;
}

/** How a session ended, from its output (stream-json lines or plain text). */
export function classify(file, r = {}) {
	let text = '';
	try { text = readFileSync(file, 'utf8'); } catch {}
	const lines = text.split('\n').filter(Boolean);
	let sessionId = '', final = null;
	for (const line of lines) {
		let j;
		try { j = JSON.parse(line); } catch { continue; }
		if (j.session_id && !sessionId) sessionId = j.session_id;
		if (j.type === 'result') final = j;
	}
	const finalText = String(final?.result ?? lines.slice(-5).join(' ')).trim();
	const limitText = finalText.match(/[^\n]*\b(?:hit your|usage|session|weekly) limit\b[^\n]*/i)?.[0] ?? (r.error ? '' : text.slice(-4000).match(/[^\n"]*hit your [^\n"]*limit[^\n"]*/i)?.[0]);
	if (limitText && (final?.is_error || !final)) {
		return { outcome: 'limited', sessionId, summary: limitText.trim(), resetsAt: resetTime(limitText, Date.now()) };
	}
	if (r.error) return { outcome: 'failed', sessionId, summary: `couldn't start: ${r.error.message}` };
	if (final && !final.is_error && r.status === 0) return { outcome: 'ended', sessionId, summary: finalText || '(no summary)' };
	if (r.signal) return { outcome: 'stopped', sessionId, summary: `stopped (${r.signal})` };
	return { outcome: 'failed', sessionId, summary: finalText || `exit ${r.status}` };
}

// ---- install, status and the rest --------------------------------------------------------------------

const label = (config) => {
	let slug = basename(config.root);
	try { slug = git('-C', config.root, 'remote', 'get-url', 'origin').replace(/\.git$/, '').split(/[/:]/).slice(-2).join('.'); } catch {}
	return `com.github.smknaqvi.foreman.watchdog.${slug.replace(/[^\w.-]/g, '-')}`;
};
const plistFile = (config) => join(homedir(), 'Library', 'LaunchAgents', `${label(config)}.plist`);

/** The launchd job, as XML. */
export function plist({ label: name, program, dir, everyMinutes, logFile, env }) {
	const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const str = (s) => `<string>${x(s)}</string>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>${str(name)}
	<key>ProgramArguments</key>
	<array>${program.map(str).join('')}</array>
	<key>WorkingDirectory</key>${str(dir)}
	<key>StartInterval</key><integer>${everyMinutes * 60}</integer>
	<key>RunAtLoad</key><true/>
	<key>StandardOutPath</key>${str(logFile)}
	<key>StandardErrorPath</key>${str(logFile)}
	<key>EnvironmentVariables</key>
	<dict>${Object.entries(env).map(([k, v]) => `<key>${x(k)}</key>${str(v)}`).join('')}</dict>
</dict>
</plist>
`;
}

export function install(config) {
	const w = paths(config.root);
	mkdirSync(w.sessions, { recursive: true });
	const dir = coordinatorDir(config);
	prepare(config, dir);
	const program = [process.execPath, foremanBin(dir), 'watchdog', 'run'];
	const every = config.watchdog.everyMinutes;
	// USER and LOGNAME too: without them claude can't find its login in the macOS keychain ("Not logged in").
	const env = { HOME: homedir(), ...pick(process.env, ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'CLAUDE_CONFIG_DIR']) };
	const [cmd] = config.watchdog.command;
	if (spawnSync('bash', ['-c', `command -v ${JSON.stringify(cmd)}`], { stdio: 'ignore' }).status !== 0) console.log(`Note: "${cmd}" (watchdog.command) isn't on this PATH; the watchdog won't be able to start a Coordinator.`);
	if (process.platform !== 'darwin') {
		const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
		// cron's minute field only steps within an hour: whole hours go in the hour field.
		const hours = Math.max(1, Math.round(every / 60));
		const when = every < 60 ? `*/${every} * * * *` : `0 ${hours > 1 ? `*/${hours}` : '*'} * * *`;
		if (every >= 60 && every % 60) console.log(`(cron can't run every ${every} minutes: every ${hours} hour${hours > 1 ? 's' : ''} instead.)`);
		console.log(`No launchd here. Add this line to your crontab (crontab -e):\n\n${when} cd ${q(dir)} && PATH=${q(env.PATH)} ${program.map(q).join(' ')} >> ${q(join(w.dir, 'launchd.log'))} 2>&1\n`);
		return 0;
	}
	const file = plistFile(config);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, plist({ label: label(config), program, dir, everyMinutes: every, logFile: join(w.dir, 'launchd.log'), env }));
	const domain = `gui/${process.getuid()}`;
	spawnSync('launchctl', ['bootout', `${domain}/${label(config)}`], { stdio: 'ignore' });
	const r = spawnSync('launchctl', ['bootstrap', domain, file], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${(r.stderr || r.stdout).trim()}`);
	rmSync(w.paused, { force: true });
	console.log(`Watchdog installed: every ${every} minutes (${file}).
  Coordinator's worktree: ${dir}
  It starts:              ${config.watchdog.command.map((a) => (a === '{prompt}' ? '"<the resume prompt>"' : a)).join(' ')}
  Log:                    ${w.log}
It only acts when work is in flight and the newest agent session stopped at a usage limit. Pause it with
npx --no-install foreman watchdog pause, remove it with npx --no-install foreman watchdog uninstall.`);
	return 0;
}

export function uninstall(config) {
	const file = plistFile(config);
	if (process.platform === 'darwin') {
		spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label(config)}`], { stdio: 'ignore' });
		rmSync(file, { force: true });
		console.log(`Watchdog removed (${file}).`);
	} else console.log('Remove the watchdog\'s line from your crontab (crontab -e).');
	const state = readJson(paths(config.root).state, {});
	if (running(state.session)) console.log(`A Coordinator it started is still running (pid ${state.session.pid}): npx --no-install foreman watchdog stop`);
	return 0;
}

export function pause(config, on) {
	const w = paths(config.root);
	mkdirSync(w.dir, { recursive: true });
	if (on) { writeFileSync(w.paused, `${stamp()}\n`); log(w, 'paused'); console.log('Watchdog paused: rounds do nothing until npx --no-install foreman watchdog unpause.'); }
	else { rmSync(w.paused, { force: true }); log(w, 'unpaused'); console.log('Watchdog unpaused.'); }
	return 0;
}

/** Stop the Coordinator the watchdog started (its whole process group). */
export function stop(config) {
	const w = paths(config.root);
	const state = readJson(w.state, {});
	const s = state.session;
	if (!running(s)) { console.log('No Coordinator started by the watchdog is running.'); return 0; }
	try { process.kill(-s.pid, 'SIGTERM'); } catch { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
	log(w, `stopped Coordinator ${s.id} (pid ${s.pid}) by hand`);
	writeJson(join(w.sessions, `${s.id}.json`), { id: s.id, startedAt: s.startedAt, endedAt: Date.now(), outcome: 'stopped', summary: 'stopped with foreman watchdog stop' });
	console.log(`Stopped the Coordinator (pid ${s.pid}). It won't be restarted until the work in flight changes.`);
	return 0;
}

/** A few lines for `foreman status`, from local files only. '' when the watchdog was never used here. */
export function summary(config) {
	let w;
	try { w = paths(config.root); } catch { return ''; }
	const installed = process.platform === 'darwin' ? existsSync(plistFile(config)) : existsSync(w.log);
	if (!installed && !existsSync(w.state)) return '';
	const state = readJson(w.state, {});
	const lines = [`  ${installed ? 'installed' : 'not installed'}${existsSync(w.paused) ? ', PAUSED' : ''}`];
	if (running(state.session)) lines.push(`  A Coordinator it started is RUNNING (pid ${state.session.pid}, since ${stamp(state.session.startedAt)} UTC). Don't start another; npx --no-install foreman watchdog stop to take over.`);
	else if (state.last) lines.push(`  last Coordinator: ${state.last.outcome} ${stamp(state.last.endedAt)} UTC${state.last.sessionId ? ` (cd ${coordinatorDir(config)} && claude --resume ${state.last.sessionId})` : ''}`);
	try { lines.push(`  last round: ${readFileSync(w.log, 'utf8').trim().split('\n').pop()}`); } catch {}
	return lines.join('\n');
}

export async function status(config) {
	const w = paths(config.root);
	const head = summary(config);
	console.log(`Watchdog\n${head || '  not installed (npx --no-install foreman watchdog install)'}`);
	console.log(`  Coordinator's worktree: ${coordinatorDir(config)}\n  log: ${w.log}`);
	const state = readJson(w.state, {});
	const recent = (state.history || []).slice(-5).reverse();
	if (recent.length) {
		console.log('\nRecent Coordinators');
		for (const h of recent) console.log(`  ${stamp(h.startedAt)} UTC  ${h.outcome}${h.sessionId ? `  claude --resume ${h.sessionId}` : ''}\n    ${String(h.summary || '').split('\n')[0].slice(0, 150)}`);
	}
	try {
		const lines = readFileSync(w.log, 'utf8').trim().split('\n').slice(-8);
		console.log(`\nLast rounds\n${lines.map((l) => `  ${l}`).join('\n')}`);
	} catch {}
	try {
		const s = await snapshot(config, w, { ...state });
		console.log(`\nA round now would: ${decide(s).why}`);
	} catch (e) {
		console.log(`\nCouldn't work out what a round would do: ${why(e)}`);
	}
	return 0;
}

