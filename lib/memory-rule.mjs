/**
 * The shared memory's merge rule, in one place, for every part that applies it: scripts/merge.sh and
 * approve.sh (through scripts/memory-dir.mjs), `foreman status` and `tick` (lib/state.mjs: is an approved PR
 * ready?) and the risky paths (lib/config.mjs).
 *
 *   Which folder: memory.dir from the base branch's foreman.config.json (so a PR can't switch the rule off
 *   for itself), found where it is on the base (baseConfig), which may be a subfolder
 *   (packages/app/foreman.config.json: the memory is packages/app/memory/). No config: the default. One that
 *   doesn't parse, or names a folder that isn't valid: the default too, so the rule stays on.
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
// How a memory approval's description starts (scripts/approve.sh writes it, merge.sh carries it over and checks it).
export const MEMORY_APPROVAL = 'Memory approved by foreman approve';

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

/** `origin/<base>` if this checkout has it, else the local `<base>`, else '' (no base yet). */
export function baseRef(root, base) {
	for (const ref of [`origin/${base}`, base]) {
		try { git(root, 'rev-parse', '--verify', '-q', `${ref}^{commit}`); return ref; } catch {}
	}
	return '';
}

/**
 * Where the config is on `ref` (the base), never where the merging checkout finds one: a PR can't add a
 * foreman.config.json in a subfolder and merge from there to move the memory out of its own way. One config:
 * its folder. Several: the top-most (fewest folders deep, then by name), and `several` lists them. None: the
 * repo's top. Throws if `ref` can't be read, so the scripts refuse rather than guess.
 */
export function baseConfig(root, ref) {
	const configs = git(root, 'ls-tree', '-r', '--name-only', '--full-tree', '-z', ref).split('\0').filter((p) => /(^|\/)foreman\.config\.json$/.test(p));
	configs.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
	const file = configs[0] ?? '';
	return { file, prefix: file.slice(0, -'foreman.config.json'.length), several: configs.length > 1 ? configs : [] };
}

/**
 * The rule as it stands on `ref` (the base), from anywhere in the checkout at `root`:
 * { path: the memory folder from the repo's top ('' when off), onBase: does the base have its index?,
 *   several: the config files on the base when there's more than one (the top-most one counts) }
 */
export function memoryRule(root, ref) {
	const { file, prefix, several } = baseConfig(root, ref);
	let text = '';
	if (file) { try { text = git(root, 'show', `${ref}:${file}`); } catch {} }
	const dir = dirFromConfig(text);
	if (!dir) return { path: '', onBase: false, several };
	const path = `${prefix}${dir}`;
	let onBase = false;
	try { git(root, 'cat-file', '-e', `${ref}:${path}/${INDEX}`); onBase = true; } catch {}
	return { path, onBase, several };
}

const rules = new WeakMap();
const REFRESH_MS = 10 * 60e3;
/**
 * The rule for a loaded config, worked out once and kept: refreshed when origin/<base> moves or after 10
 * minutes, for long-running processes (observe, the dashboard). Fetch the base first if it matters that
 * it's current. Fallbacks: no base branch yet, nothing is set up on it; a base that can't be read, the
 * configured folder counts as set up (stricter, not looser). Both at the config's own place in the repo.
 */
export function ruleFor(config) {
	const ref = baseRef(config.root, config.baseBranch);
	let sha = '';
	if (ref) { try { sha = git(config.root, 'rev-parse', `${ref}^{commit}`).trim(); } catch {} }
	const kept = rules.get(config);
	if (kept && kept.sha === sha && Date.now() - kept.at < REFRESH_MS) return kept.rule;
	let prefix = '';
	try { prefix = git(config.root, 'rev-parse', '--show-prefix').trim(); } catch {}
	const path = config.memory?.dir === '' ? '' : `${prefix}${config.memory?.dir ?? DEFAULT_MEMORY_DIR}`;
	let rule = { path, onBase: false, several: [] };
	if (ref) { try { rule = memoryRule(config.root, ref); } catch { rule = { path, onBase: Boolean(path), several: [] }; } }
	rules.set(config, { rule, sha, at: Date.now() });
	return rule;
}

const CONFIG = /(^|\/)foreman\.config\.json$/i;
/**
 * What a PR at `head` changes in the memory, given the files it changes (paths from the repo's top): its
 * memory files (memoryFiles), plus any foreman.config.json it changes when that moves or switches off the
 * memory set up on the base (the rule worked out at `head` names another folder than at `ref`). Settings are
 * memory too: a PR that sets memory.dir to "" needs the memory approval as much as one that edits a note.
 */
export function memoryChanges(root, ref, head, files, rule = memoryRule(root, ref)) {
	const out = memoryFiles(rule, files);
	const configs = files.filter((f) => CONFIG.test(f));
	if (rule.onBase && configs.length && memoryRule(root, head).path.toLowerCase() !== rule.path.toLowerCase()) out.push(...configs);
	return [...new Set(out)];
}

/**
 * Which of `files` (paths from the repo's top) the rule covers: [] when none, or the memory isn't set up
 * (neither on the base nor added by these files). Case doesn't matter: macOS and Windows file systems would
 * put Memory/x.md in memory/.
 */
export function memoryFiles(rule, files) {
	if (!rule.path) return [];
	const folder = `${rule.path.toLowerCase()}/`;
	const mine = files.filter((f) => f.toLowerCase().startsWith(folder));
	return rule.onBase || mine.some((f) => f.toLowerCase() === `${folder}${INDEX.toLowerCase()}`) ? mine : [];
}

/** The files a PR at `head` changes against `ref` (from where they forked: right for a PR that's behind too). */
export function changedFiles(root, ref, head) {
	return git(root, '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', `${ref}...${head}`).split('\0').filter(Boolean);
}
