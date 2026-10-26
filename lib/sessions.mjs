/**
 * What the Claude Code sessions working in this repo are doing, read from their transcripts on this machine
 * (~/.claude/projects/<checkout path>/*.jsonl, one folder per worktree of the repo). Used by the watchdog
 * and `foreman status`:
 *   - when an agent last did anything (the newest transcript write in any worktree), and
 *   - whether the newest session stopped at a usage limit: its last message is Claude Code's limit error
 *     ("You've hit your session limit · resets 1:50am (America/Chicago)"), with when it resets.
 * Transcripts are Claude Code's own files, not an API: if their shape changes, this finds no limit and the
 * watchdog falls back to `watchdog.staleMinutes` (when set).
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { git } from './sh.mjs';

export const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
/** Claude Code's folder name for a checkout: the path with every other character turned into "-". */
export const projectFolder = (path) => path.replace(/[^a-zA-Z0-9]/g, '-');

/** Every worktree of the repo `root` belongs to (Conductor workspaces and agent worktrees included). */
export function worktrees(root) {
	try {
		return git('-C', root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
	} catch {
		return [root];
	}
}

/** Transcripts of sessions in these checkouts written in the last `hours`: [{ file, checkout, mtime }], newest first. */
export function transcripts(checkouts, { hours = 24, dir = projectsDir() } = {}) {
	const since = Date.now() - hours * 3600 * 1000;
	const out = [];
	const walk = (folder, checkout, depth) => {
		let entries = [];
		try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const file = join(folder, e.name);
			if (e.isDirectory() && depth < 2) walk(file, checkout, depth + 1); // <session>/subagents/*.jsonl: Builders.
			else if (e.isFile() && e.name.endsWith('.jsonl')) {
				const mtime = statSync(file).mtimeMs;
				if (mtime >= since) out.push({ file, checkout, mtime });
			}
		}
	};
	for (const checkout of checkouts) {
		const folder = join(dir, projectFolder(checkout));
		if (existsSync(folder)) walk(folder, checkout, 0);
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

/** The last ~64 KB of a file, as lines. */
function tail(file, bytes = 65536) {
	const fd = openSync(file, 'r');
	try {
		const size = statSync(file).size;
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		const lines = buf.toString('utf8').split('\n');
		if (start > 0) lines.shift(); // Probably cut mid-line.
		return lines.filter(Boolean);
	} finally {
		closeSync(fd);
	}
}

/**
 * Did this session stop at a usage limit? Its last message (user or assistant: attachments, summaries and the
 * like don't count) is Claude Code's rate-limit error. { at, text, resetsAt } or null.
 */
export function limitStop(file) {
	let lines;
	try { lines = tail(file); } catch { return null; }
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry;
		try { entry = JSON.parse(lines[i]); } catch { continue; }
		if (entry.type !== 'user' && entry.type !== 'assistant') continue;
		if (!(entry.isApiErrorMessage && entry.error === 'rate_limit')) return null;
		const text = (entry.message?.content || []).map((c) => c.text ?? '').join(' ').trim();
		const at = Date.parse(entry.timestamp) || statSync(file).mtimeMs;
		return { at, text, resetsAt: resetTime(text, at) };
	}
	return null;
}

/**
 * When a limit message says it resets: "resets 1:50am (America/Chicago)", "resets 9pm", "resets Oct 27,
 * 9am (America/Chicago)". The first such moment after `after` (ms). null if it can't be read.
 */
export function resetTime(text, after) {
	const m = text.match(/resets\s+(?:(?:on\s+)?([A-Z][a-z]{2,8})\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?/i);
	if (!m) return null;
	const [, monthName, dayOfMonth, h, min = '0', ampm, zone] = m;
	const hour = (Number(h) % 12) + (ampm.toLowerCase() === 'p' ? 12 : 0);
	const tz = zone && isZone(zone) ? zone : undefined;
	const month = monthName ? new Date(`${monthName} 1, 2000`).getMonth() : NaN;
	// Walk forward day by day from `after` in that time zone until the wall-clock time comes up.
	for (let d = 0; d < 400; d++) {
		const day = wallDate(after + d * 86400000, tz);
		if (monthName && (day.month !== month || day.day !== Number(dayOfMonth))) continue;
		const at = fromWall({ ...day, hour, minute: Number(min) }, tz);
		if (at > after) return at;
	}
	return null;
}

const isZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
function wallDate(ms, tz) {
	const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(ms).map((p) => [p.type, p.value]));
	return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day) };
}
/** The instant a wall-clock time in `tz` happens (the local zone when undefined). */
function fromWall({ year, month, day, hour, minute }, tz) {
	const guess = Date.UTC(year, month, day, hour, minute);
	const offset = (ms) => {
		const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(ms).map((x) => [x.type, x.value]));
		return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - ms;
	};
	const first = guess - offset(guess);
	return guess - offset(first); // Twice, for the hour around a clock change.
}

/**
 * The picture for the watchdog: when an agent in this repo was last active, and whether the newest session
 * stopped at a usage limit. `exclude`: checkouts not to count as activity (none by default).
 */
export function agentActivity(root, { exclude = [], dir } = {}) {
	const all = transcripts(worktrees(root), { dir });
	const newest = all.find((t) => !exclude.includes(t.checkout));
	const limited = newest ? limitStop(newest.file) : null;
	return { lastActiveAt: newest?.mtime ?? 0, checkout: newest?.checkout ?? '', limited };
}
