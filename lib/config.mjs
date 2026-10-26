/**
 * foreman.config.json: everything that differs between repos. Found by walking up from the working
 * directory; missing fields take the defaults below, so an empty file (or none) is a valid config.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
	// Builders running at once.
	maxBuilders: 4,
	// Each Builder's local environment (see lib/env/). adapter: none | wp-env | docker-compose | ./path.mjs
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
export const RISKY_ALWAYS = ['.github/', '.claude/', '.githooks/', CONFIG_FILE, 'package.json', 'package-lock.json'];

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
	config.riskyPaths = [...new Set([...RISKY_ALWAYS, ...config.riskyPaths])];
	return { ...config, root: root || resolve(from) };
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
	if (!c.launchComment) problems.push('launchComment can\'t be empty');
	try { new RegExp(c.docsOnly); } catch { problems.push('docsOnly must be a regular expression'); }
	if (!Number.isInteger(c.maxBuilders) || c.maxBuilders < 1) problems.push('maxBuilders must be a whole number of at least 1');
	if (typeof c.env?.adapter !== 'string' || !c.env.adapter) problems.push('env.adapter must name an adapter');
	const wd = c.watchdog ?? {};
	const whole = (k, min) => (Number.isInteger(wd[k]) && wd[k] >= min) || problems.push(`watchdog.${k} must be a whole number of at least ${min}`);
	whole('everyMinutes', 1); whole('staleMinutes', 0); whole('maxSessionsPerDay', 0);
	['dir', 'setup', 'prompt'].forEach((k) => typeof wd[k] === 'string' || problems.push(`watchdog.${k} must be a string`));
	if (!(Array.isArray(wd.command) && wd.command.length && wd.command.every((x) => typeof x === 'string'))) problems.push('watchdog.command must be a non-empty list of strings');
	if (!wd.env || typeof wd.env !== 'object' || Array.isArray(wd.env) || !Object.values(wd.env).every((v) => typeof v === 'string')) problems.push('watchdog.env must map names to strings');
	return problems;
}

/** The environment the merge scripts read their settings from. */
export function scriptEnv(config) {
	return {
		FOREMAN_BASE: config.baseBranch,
		FOREMAN_APPROVAL_CONTEXT: config.approvalContext,
		FOREMAN_REQUIRED_CHECK: config.requiredCheck,
		FOREMAN_STALE_PATHS: config.staleCheckPaths.join('\n'),
		FOREMAN_DOCS_ONLY: config.docsOnly,
	};
}
