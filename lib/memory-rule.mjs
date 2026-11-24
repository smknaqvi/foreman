/**
 * The shared memory's merge rule, in one place, for every part that applies it: scripts/merge.sh and
 * approve.sh (through scripts/memory-dir.mjs), `foreman status` and `tick` (lib/state.mjs: is an approved PR
 * ready?) and the risky paths (lib/config.mjs).
 *
 *   Which folder: memory.dir from the base branch's copy of foreman.config.json (so a PR can't switch the
 *   rule off for itself), at the same place in the repo as the checkout's config, which may sit in a
 *   subfolder (packages/app/foreman.config.json: the memory is packages/app/memory/). No config there: the
 *   default. One that doesn't parse, or names a folder that isn't valid: the default too, so the rule stays on.
 *
 *   Which PRs: those changing a file in that folder, once the base has its index (<dir>/MEMORY.md), or that
 *   add or change the index itself (the PR setting the memory up). A folder of that name with no index on the
 *   base isn't a foreman memory, and is left alone.
 *
 * No imports from config.mjs: it imports this.
 */
import { execFileSync } from 'node:child_process';

export const DEFAULT_MEMORY_DIR = 'memory';
export const INDEX = 'MEMORY.md';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** memory.dir as the rule compares it: no leading ./ or trailing /. */
export const memoryDir = (dir) => (typeof dir === 'string' ? dir.replace(/^\.\/|\/+$/g, '') : dir);

/** A folder inside the repo ("memory", "docs/memory"), or '' for none. */
export function validMemoryDir(raw) {
	if (typeof raw !== 'string') return false;
	const dir = memoryDir(raw);
	return !dir || (/^[\w.-]+(\/[\w.-]+)*$/.test(dir) && !dir.split('/').some((s) => s === '.' || s === '..'));
}

/** The memory folder a foreman.config.json's text names: '' when it switches the memory off. */
export function dirFromConfig(text) {
	try {
		const set = text.trim() ? JSON.parse(text).memory?.dir : undefined;
		if (set !== undefined && validMemoryDir(set)) return memoryDir(set);
	} catch {}
	return DEFAULT_MEMORY_DIR;
}

/** `origin/<base>` if this checkout has it, else the local `<base>`. */
export function baseRef(root, base) {
	try { git(root, 'rev-parse', '--verify', '-q', `origin/${base}^{commit}`); return `origin/${base}`; } catch { return base; }
}

/**
 * The rule as it stands on `ref` (the base), for the config in folder `root`:
 * { path: the memory folder from the repo's top ('' when off), onBase: does the base have its index? }
 */
export function memoryRule(root, ref) {
	let prefix = '';
	try { prefix = git(root, 'rev-parse', '--show-prefix').trim(); } catch {} // 'packages/app/' or ''.
	let text = '';
	try { text = git(root, 'show', `${ref}:${prefix}foreman.config.json`); } catch {} // None on the base: the default.
	const dir = dirFromConfig(text);
	if (!dir) return { path: '', onBase: false };
	const path = `${prefix}${dir}`;
	let onBase = false;
	try { git(root, 'cat-file', '-e', `${ref}:${path}/${INDEX}`); onBase = true; } catch {}
	return { path, onBase };
}

/** Which of `files` (paths from the repo's top) the rule covers: [] when none, or the memory isn't set up. */
export function memoryFiles(rule, files) {
	if (!rule.path) return [];
	const mine = files.filter((f) => f.startsWith(`${rule.path}/`));
	return rule.onBase || mine.includes(`${rule.path}/${INDEX}`) ? mine : [];
}

/** The files a PR at `head` changes against `ref` (from where they forked: right for a PR that's behind too). */
export function changedFiles(root, ref, head) {
	return git(root, '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', `${ref}...${head}`).split('\0').filter(Boolean);
}
