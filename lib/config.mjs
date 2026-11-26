/**
 * foreman.config.json: everything that differs between repos. Found by walking up from the working
 * directory; missing fields take the defaults below, so an empty file (or none) is a valid config.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const CONFIG_FILE = 'foreman.config.json';

export const DEFAULTS = Object.freeze({
	// The branch every PR targets and nothing pushes to directly.
	baseBranch: 'main',
	// The CI check that must pass before a merge. A clean rebase of an approved commit reuses that
	// commit's result. Empty: wait for every check on the PR's own head instead (no reuse).
	requiredCheck: 'verify',
	// The commit status the Coordinator's approval is recorded as.
	approvalContext: 'coordinator-review',
	labels: {
		working: 'agent: working', // An issue a Builder is on.
		needsInput: 'needs team input', // Blocked on people: files, decisions, accounts.
		decision: 'decision', // The user's call, never an agent's.
	},
	// A person's OK to merge, which agents never give (the merge guard refuses it): the exact comment a person posts,
	// and the label only a person removes. Empty switches that part off.
	ownerOk: {
		phrase: 'OK to merge',
		label: 'needs owner review',
	},
	// First words of the issue comment that records a Builder's branch and port (foreman claim).
	launchComment: 'Builder launched',
	// Where decisions and progress are written down. Builders don't edit it; their PRs carry "Plan updates".
	planFile: '',
	// What a Builder runs before saying it's done (and CI runs as requiredCheck).
	verifyCommand: 'npm test',
	// PRs whose changed files all match this (an extended regular expression, as grep -E reads it) don't
	// wait for checks. Empty: every PR waits.
	docsOnly: '\\.md$',
	// Paths whose change on the base branch makes an approved commit's checks stale (e.g. screenshot
	// baselines): a rebased PR then waits for its own checks.
	staleCheckPaths: [],
	// Paths that get a stricter review. The framework's own files are always included (RISKY_ALWAYS).
	riskyPaths: [],
	// Files several Builders would want to edit: serialize work that touches them.
	hotspots: [],
	// Project playbooks (skills or docs) every Builder reads, in addition to AGENTS.md.
	playbooks: [],
	// Shared memory (lib/memory.mjs): durable facts every agent reads, in <dir>/ with an index, <dir>/MEMORY.md.
	// <dir> is relative to this file; '' switches it off. Only the Coordinator changes it, kept by review: once
	// the index exists the folder is a risky path (loadConfig), so a PR touching it gets the stricter review.
	// `foreman merge` only checks that a PR's notes parse, reading memory.dir from the base branch's copy of
	// this file (lib/memory.mjs checkAt), so a PR can't switch that off for itself.
	memory: { dir: 'memory' },
	// Builders running at once.
	maxBuilders: 4,
	// Each Builder's local environment (see lib/env/). adapter: none | wp-env | docker-compose | dev-server |
	// nextjs | rails | neon | ./path.mjs, or a list of them (["nextjs", "neon"]).
	env: { adapter: 'none' },
	observe: { intervalSeconds: 60, memoryHigh: 70, memoryCritical: 85 },
	// `foreman watchdog` (lib/watchdog.mjs): starts a Coordinator when every agent stopped at a usage limit.
	watchdog: {
		everyMinutes: 15, // How often a round runs (launchd or cron).
		staleMinutes: 0, // Also act when no agent has done anything this long. 0: only after a usage-limit stop.
		maxSessionsPerDay: 6, // Coordinators started in 24 hours, not counting ones that hit the limit at once.
		dir: '', // The Coordinator's own worktree, relative to the main checkout. Default: "<main checkout>-foreman" beside it.
		setup: 'npm install --no-fund --no-audit', // Run in that worktree after updating it to the base branch.
		// What starts the Coordinator; {prompt} is replaced by `prompt`. Runs unattended, so it can't ask for
		// permission: the merge guard hook still applies.
		command: ['claude', '-p', '{prompt}', '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose'],
		prompt: '', // Empty: the built-in resume prompt (DEFAULT_PROMPT in lib/watchdog.mjs).
		env: {}, // Extra environment variables for the Coordinator (e.g. CONDUCTOR_PORT for its Builders' ports).
	},
});

// Changing these changes the rules themselves, so they always get the stricter review.
export const RISKY_ALWAYS = ['.github/', '.claude/', '.codex/', '.cursor/', '.agents/', '.gemini/', '.githooks/', CONFIG_FILE, 'package.json', 'package-lock.json'];

/** The directory holding foreman.config.json, walking up from `from`, or '' if there is none. */
export function findRoot(from = process.cwd()) {
	for (let dir = resolve(from); ; dir = dirname(dir)) {
		if (existsSync(join(dir, CONFIG_FILE))) return dir;
		if (dirname(dir) === dir) return '';
	}
}

export function loadConfig(from = process.cwd()) {
	const root = findRoot(from);
	let user = {};
	if (root) {
		const file = join(root, CONFIG_FILE);
		try {
			user = JSON.parse(readFileSync(file, 'utf8'));
		} catch (e) {
			throw new Error(`${file} isn't valid JSON: ${e.message}`);
		}
	}
	const config = merge(DEFAULTS, user);
	const problems = validate(config);
	if (problems.length) throw new Error(`${CONFIG_FILE}: ${problems.join('; ')}`);
	config.memory = { ...config.memory, dir: memoryDir(config.memory.dir) };
	const out = { ...config, root: root || resolve(from) };
	// The shared memory is what every agent reads before working, and only the Coordinator changes it: any PR
	// touching it gets the stricter review, so the Coordinator notices a Builder's. Once it's set up (its index
	// here or on the base); before that, only a PR adding the index, so a code folder that happens to be called
	// memory/ isn't flagged.
	const memory = memoryRepoPath(out);
	const memoryRisky = !memory ? [] : memorySetUp(out, memory) ? [`${memory}/`] : [`${memory}/MEMORY.md`];
	out.riskyPaths = [...new Set([...RISKY_ALWAYS, ...memoryRisky, ...config.riskyPaths])];
	return out;
}

/** Is the memory set up: its index in this checkout, or else on origin/<base> (one cheap git call)? */
function memorySetUp(config, path) {
	if (existsSync(join(memoryFolder(config), 'MEMORY.md'))) return true;
	try { execFileSync('git', ['-C', config.root, 'cat-file', '-e', `origin/${config.baseBranch}:${path}/MEMORY.md`], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** The shared memory's folder, the one definition everything uses: <config root>/<memory.dir>. '' when off. */
export const memoryFolder = (config) => (config.memory?.dir ? join(config.root, config.memory.dir) : '');

/**
 * The memory folder as a path from the repo's top ("memory", or "packages/app/memory" for a config in a
 * subfolder), as PRs list their files. Found by walking up to the .git folder: no git call, so loading the
 * config stays cheap (the guard hook loads it for every command). '' when off.
 */
export function memoryRepoPath(config) {
	const folder = memoryFolder(config);
	if (!folder) return '';
	return relative(repoTop(config.root), folder).split(sep).join('/');
}

/** The repo's top folder (the one holding .git), from `root`; `root` itself outside a repo. No git call. */
export function repoTop(root) {
	for (let dir = root; ; dir = dirname(dir)) {
		if (existsSync(join(dir, '.git'))) return dir;
		if (dirname(dir) === dir) return root;
	}
}

/** memory.dir as written or as compared: no leading ./ or trailing /. */
export const memoryDir = (dir) => (typeof dir === 'string' ? dir.replace(/^\.\/|\/+$/g, '') : dir);

/** A folder inside the repo ("memory", "docs/memory"), or '' for none. */
export function validMemoryDir(raw) {
	if (typeof raw !== 'string') return false;
	const dir = memoryDir(raw);
	return !dir || (/^[\w.-]+(\/[\w.-]+)*$/.test(dir) && !dir.split('/').some((s) => s === '.' || s === '..'));
}

function merge(base, over) {
	const out = { ...base };
	for (const [k, v] of Object.entries(over ?? {})) {
		const b = base[k];
		out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? merge(b, v) : v;
	}
	return out;
}

function validate(c) {
	const problems = [];
	const str = (k) => typeof c[k] === 'string' || problems.push(`${k} must be a string`);
	const list = (k) => (Array.isArray(c[k]) && c[k].every((x) => typeof x === 'string')) || problems.push(`${k} must be a list of strings`);
	['baseBranch', 'requiredCheck', 'approvalContext', 'launchComment', 'planFile', 'verifyCommand', 'docsOnly'].forEach(str);
	['staleCheckPaths', 'riskyPaths', 'hotspots', 'playbooks'].forEach(list);
	if (!/^[\w./-]+$/.test(c.baseBranch ?? '')) problems.push('baseBranch must be a plain branch name');
	if (!c.approvalContext) problems.push('approvalContext can\'t be empty');
	if (!c.ownerOk || typeof c.ownerOk !== 'object' || typeof c.ownerOk.phrase !== 'string' || typeof c.ownerOk.label !== 'string') problems.push('ownerOk must have a phrase and a label (strings; empty switches that part off)');
	if (!c.launchComment) problems.push('launchComment can\'t be empty');
	try { new RegExp(c.docsOnly); } catch { problems.push('docsOnly must be a regular expression'); }
	if (!Number.isInteger(c.maxBuilders) || c.maxBuilders < 1) problems.push('maxBuilders must be a whole number of at least 1');
	const adapters = [c.env?.adapter].flat();
	if (!adapters.length || !adapters.every((a) => typeof a === 'string' && a)) problems.push('env.adapter must name an adapter, or list several');
	const mem = c.memory ?? {};
	if (!validMemoryDir(mem.dir)) problems.push('memory.dir must be a folder inside the repo, like "memory" or "docs/memory" (or empty: no shared memory)');
	const wd = c.watchdog ?? {};
	const whole = (k, min) => (Number.isInteger(wd[k]) && wd[k] >= min) || problems.push(`watchdog.${k} must be a whole number of at least ${min}`);
	whole('everyMinutes', 1); whole('staleMinutes', 0); whole('maxSessionsPerDay', 0);
	['dir', 'setup', 'prompt'].forEach((k) => typeof wd[k] === 'string' || problems.push(`watchdog.${k} must be a string`));
	if (!(Array.isArray(wd.command) && wd.command.length && wd.command.every((x) => typeof x === 'string'))) problems.push('watchdog.command must be a non-empty list of strings');
	if (!wd.env || typeof wd.env !== 'object' || Array.isArray(wd.env) || !Object.values(wd.env).every((v) => typeof v === 'string')) problems.push('watchdog.env must map names to strings');
	return problems;
}

/** The environment the merge scripts read their settings from. (Not the memory folder: they read that from the base.) */
export function scriptEnv(config) {
	return {
		FOREMAN_BASE: config.baseBranch,
		FOREMAN_APPROVAL_CONTEXT: config.approvalContext,
		FOREMAN_REQUIRED_CHECK: config.requiredCheck,
		FOREMAN_STALE_PATHS: config.staleCheckPaths.join('\n'),
		FOREMAN_DOCS_ONLY: config.docsOnly,
	};
}
