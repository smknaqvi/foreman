/**
 * `foreman init`: set a repo up for the crew. Writes only what's missing, unless --force:
 *   foreman.config.json                    the repo's settings (base branch detected from origin)
 *   .githooks/pre-push                      git refuses pushes to the base branch
 *   .claude/hooks/foreman-guard.mjs        the merge guard, wired into .claude/settings.json
 *   .claude/skills/coordinate-agents, work-an-issue   the Coordinator's and Builders' playbooks
 *   --ci        .github/workflows/verify.yml            the check `foreman merge` waits for
 *     --self-hosted <labels>   ...on a self-hosted runner, with .github/foreman/keep-awake.sh
 *   --conductor .conductor/settings.toml                one workspace per Builder in Conductor
 * Then switches on the pre-push check for this checkout.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, loadConfig } from './config.mjs';
import { enablePrePush } from './crew.mjs';
import { git } from './sh.mjs';

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
export const MANAGED = 'Managed by foreman'; // Marks a playbook `init --force` may replace.
const HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/foreman-guard.mjs"';

export function init(cwd, { force = false, ci = false, 'self-hosted': selfHosted = '', conductor = false } = {}) {
	let root;
	try {
		root = git('-C', cwd, 'rev-parse', '--show-toplevel');
	} catch {
		throw new Error('Run foreman init inside a git repository.');
	}
	const wrote = [], kept = [];
	const put = (rel, content, mode) => {
		const file = join(root, rel);
		if (existsSync(file) && !force) return kept.push(rel);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
		if (mode) chmodSync(file, mode);
		wrote.push(rel);
	};
	const template = (rel) => readFileSync(join(TEMPLATES, rel), 'utf8');

	// The config first: everything below reads the base branch from it.
	if (!existsSync(join(root, CONFIG_FILE))) put(CONFIG_FILE, template('foreman.config.json').replace('__BASE__', detectBase(root)));
	else kept.push(CONFIG_FILE);
	const config = loadConfig(root);
	const base = config.baseBranch;

	put('.githooks/pre-push', template('githooks/pre-push').replaceAll('__BASE__', base), 0o755);
	put('.claude/hooks/foreman-guard.mjs', template('claude/foreman-guard.mjs'), 0o755);
	if (addHook(join(root, '.claude/settings.json'))) wrote.push('.claude/settings.json (merge guard hook)');
	else kept.push('.claude/settings.json');

	// Playbooks: replace our own on --force, never one the repo wrote itself.
	for (const skill of readdirSync(join(TEMPLATES, 'skills'))) {
		const rel = `.claude/skills/${skill}/SKILL.md`;
		const file = join(root, rel);
		if (existsSync(file) && (!force || !readFileSync(file, 'utf8').includes(MANAGED))) { kept.push(rel); continue; }
		mkdirSync(dirname(file), { recursive: true });
		cpSync(join(TEMPLATES, 'skills', skill, 'SKILL.md'), file);
		wrote.push(rel);
	}
	if (selfHosted && !ci) throw new Error('--self-hosted goes with --ci');
	if (ci && selfHosted) {
		const labels = [...new Set(['self-hosted', ...selfHosted.split(',').map((l) => l.trim()).filter(Boolean)])].join(', ');
		put('.github/workflows/verify.yml', template('verify-self-hosted.yml').replaceAll('__BASE__', base).replaceAll('__LABELS__', labels).replace('__VERIFY__', () => config.verifyCommand));
		put('.github/foreman/keep-awake.sh', template('github/keep-awake.sh'), 0o755);
	} else if (ci) put('.github/workflows/verify.yml', template('verify.yml').replaceAll('__BASE__', base).replace('__VERIFY__', () => config.verifyCommand));
	if (conductor) put('.conductor/settings.toml', template('conductor-settings.toml'));

	const hooksOn = enablePrePush(root);

	if (wrote.length) console.log(`Wrote:\n${wrote.map((f) => `  ${f}`).join('\n')}`);
	if (kept.length) console.log(`Already there, left alone${force ? '' : ' (--force replaces them; your own playbooks are never replaced)'}:\n${kept.map((f) => `  ${f}`).join('\n')}`);
	if (hooksOn) console.log('\nSwitched on git\'s pre-push check for this checkout (core.hooksPath .githooks).');
	console.log(`
Next:
  1. Fill in ${CONFIG_FILE}: requiredCheck (your CI job's name), verifyCommand, hotspots, playbooks, env.
  2. Create the labels: gh label create "${config.labels.working}" && gh label create "${config.labels.needsInput}" && gh label create "${config.labels.decision}"
  3. Say in AGENTS.md (or CLAUDE.md) that merges go through foreman, and list each lane's files.
  4. npx --no-install foreman doctor`);
	return 0;
}

function detectBase(root) {
	try {
		return git('-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '');
	} catch {
		return 'main';
	}
}

/** Add the guard to .claude/settings.json's PreToolUse hooks for Bash. False if it was already there. */
export function addHook(file) {
	const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
	const pre = ((settings.hooks ??= {}).PreToolUse ??= []);
	if (pre.some((m) => (m.hooks || []).some((h) => h.command?.includes('foreman-guard')))) return false;
	pre.push({ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 10 }] });
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
	return true;
}
