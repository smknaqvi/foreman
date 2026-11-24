/**
 * `foreman init`: set a repo up for the crew. Writes only what's missing, unless --force:
 *   foreman.config.json                    the repo's settings (base branch detected from origin)
 *   .githooks/pre-push                      git refuses pushes to the base branch
 *   .claude/hooks/foreman-guard.mjs        the merge guard, wired into each agent tool's hooks:
 *     --agents claude,codex,cursor,antigravity,gemini   which tools (default: those the repo is set up for, see
 *                                           expectedAgents; Claude Code in a repo set up for none)
 *   .claude/skills/coordinate-agents, work-an-issue   the Coordinator's and Builders' playbooks (plain
 *                                           Markdown: Claude Code loads them, other tools read them via AGENTS.md)
 *   --ci        .github/workflows/verify.yml            the check `foreman merge` waits for
 *     --self-hosted <labels>   ...on a self-hosted runner, with .github/foreman/keep-awake.sh
 *   --conductor .conductor/settings.toml                one workspace per Builder in Conductor
 * Then switches on the pre-push check for this checkout.
 */
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, SHIM } from './agents.mjs';
import { CONFIG_FILE, loadConfig } from './config.mjs';
import { enablePrePush } from './crew.mjs';
import { git } from './sh.mjs';

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
export const MANAGED = 'Managed by foreman'; // Marks a playbook `init --force` may replace.

export function init(cwd, { force = false, ci = false, 'self-hosted': selfHosted = '', conductor = false, agents: agentList = '' } = {}) {
	if (selfHosted && !ci) throw new Error('--self-hosted goes with --ci');
	let root;
	try {
		root = git('-C', cwd, 'rev-parse', '--show-toplevel');
	} catch {
		throw new Error('Run foreman init inside a git repository.');
	}
	const agents = chooseAgents(root, agentList); // Before writing anything: an unknown tool stops here.
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
	// The shim is ours: replace it when it's another version (an older one doesn't know newer tools' formats).
	const shim = template('claude/foreman-guard.mjs');
	const shimVersion = (text) => text.match(/foreman-shim: (\d+)/)?.[1] ?? '';
	if (!force && existsSync(join(root, SHIM)) && shimVersion(readFileSync(join(root, SHIM), 'utf8')) !== shimVersion(shim)) {
		writeFileSync(join(root, SHIM), shim);
		wrote.push(`${SHIM} (updated: it was another version)`);
	} else put(SHIM, shim, 0o755);
	for (const id of agents) {
		const rel = AGENTS[id].settings;
		if (addHook(join(root, rel), id)) wrote.push(`${rel} (merge guard hook for ${AGENTS[id].name})`);
		else kept.push(rel);
	}

	// Playbooks: replace our own on --force, never one the repo wrote itself.
	for (const skill of readdirSync(join(TEMPLATES, 'skills'))) {
		const rel = `.claude/skills/${skill}/SKILL.md`;
		const file = join(root, rel);
		if (existsSync(file) && (!force || !readFileSync(file, 'utf8').includes(MANAGED))) { kept.push(rel); continue; }
		mkdirSync(dirname(file), { recursive: true });
		cpSync(join(TEMPLATES, 'skills', skill, 'SKILL.md'), file);
		wrote.push(rel);
	}
	// Tools that look for skills elsewhere (Antigravity: .agents/skills/) get a link to each playbook, the
	// repo's own included, so there's one copy to keep up to date.
	for (const id of agents) {
		if (!AGENTS[id].skills) continue;
		const r = linkSkills(root, AGENTS[id].skills);
		wrote.push(...r.linked.map((s) => `${AGENTS[id].skills}/${s} (${r.copied.includes(s) ? 'a copy of' : 'link to'} .claude/skills/${s})`), ...r.removed.map((s) => `${AGENTS[id].skills}/${s} (removed: its playbook is gone)`));
		kept.push(...r.theirs.map((s) => `${AGENTS[id].skills}/${s} (the repo's own folder, so ${AGENTS[id].name} reads it instead of .claude/skills/${s})`));
		if (r.copied.length) console.log(`Couldn't make links here (Windows without Developer Mode?), so ${r.copied.join(', ')} ${r.copied.length > 1 ? 'are copies' : 'is a copy'}: run init again after changing a playbook.`);
	}
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
  3. Say in AGENTS.md (every agent tool reads it) that merges go through foreman, list each lane's files, and
     point to the playbooks: .claude/skills/coordinate-agents/SKILL.md and work-an-issue/SKILL.md.
  4. npx --no-install foreman doctor
${wrote.some((f) => f.startsWith(AGENTS.codex.settings)) ? `\nCodex runs a new or changed hook only once someone trusts it: open Codex in this repo and approve it under /hooks.\n` : ''}`);
	return 0;
}

function detectBase(root) {
	try {
		return git('-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '');
	} catch {
		return 'main';
	}
}

/**
 * Which tools to wire the guard into: `list` ("claude,codex"), or the tools the repo is set up for (already
 * wired, or with their settings: expectedAgents), or Claude Code in a repo set up for none.
 */
export function chooseAgents(root, list = '') {
	if (list) {
		const ids = [...new Set(list.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean))];
		const unknown = ids.filter((id) => !AGENTS[id]);
		if (unknown.length) throw new Error(`Unknown agent tool ${unknown.join(', ')}: foreman wires the guard into ${Object.keys(AGENTS).join(', ')}. For another tool, call \`foreman guard --command\` from its own hook.`);
		return ids;
	}
	const found = [...new Set([...wiredAgents(root), ...expectedAgents(root)])];
	return found.length ? Object.keys(AGENTS).filter((id) => found.includes(id)) : ['claude'];
}

/**
 * The tools this repo is set up for, which should all run the guard: Claude Code when .claude/settings.json
 * exists (.claude/ alone holds the shim and playbooks for every tool), the others when their folder does.
 */
export const expectedAgents = (root) => Object.keys(AGENTS).filter((id) => existsSync(join(root, AGENTS[id].marker ?? (id === 'claude' ? AGENTS[id].settings : dirname(AGENTS[id].settings)))));

/**
 * Link every playbook in .claude/skills/ into `dir` (relative links, so they work in every checkout), and remove
 * our links whose playbook is gone. A folder of the repo's own with the same name is left alone (`theirs`).
 * Where links can't be made (Windows without Developer Mode), copies the playbook instead (`copied`).
 */
export function linkSkills(root, dir) {
	const source = join(root, '.claude/skills');
	const out = { linked: [], copied: [], removed: [], theirs: [] };
	const target = join(root, dir);
	if (existsSync(target)) {
		for (const name of readdirSync(target)) {
			const link = join(target, name);
			let isLink = false;
			try { isLink = lstatSync(link).isSymbolicLink(); } catch {}
			if (isLink && readlinkSync(link).includes('.claude/skills/') && !existsSync(link)) { unlinkSync(link); out.removed.push(name); } // unlink: rmSync leaves a dangling link alone.
		}
	}
	if (!existsSync(source)) return out;
	for (const skill of readdirSync(source)) {
		if (!existsSync(join(source, skill, 'SKILL.md'))) continue;
		const link = join(target, skill);
		let st = null;
		try { st = lstatSync(link); } catch {}
		if (st?.isSymbolicLink()) continue; // Ours already.
		if (st) { out.theirs.push(skill); continue; }
		mkdirSync(target, { recursive: true });
		try {
			symlinkSync(relative(target, join(source, skill)), link, 'dir');
		} catch (e) {
			if (e.code !== 'EPERM') throw e;
			mkdirSync(link);
			cpSync(join(source, skill, 'SKILL.md'), join(link, 'SKILL.md'));
			out.copied.push(skill);
		}
		out.linked.push(skill);
	}
	return out;
}

/** The tools whose settings in `root` run the guard. */
export const wiredAgents = (root) => Object.keys(AGENTS).filter((id) => {
	const file = join(root, AGENTS[id].settings);
	// A hook switched off ("enabled": false, Antigravity's way) doesn't count.
	try { return AGENTS[id].entries(JSON.parse(readFileSync(file, 'utf8'))).some((h) => h.enabled !== false && h.command?.includes('foreman-guard')); } catch { return false; }
});

/** Add the guard to `agent`'s hook settings in `file`. False if it was already there. */
export function addHook(file, agent = 'claude') {
	const a = AGENTS[agent];
	const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
	if (a.entries(settings).some((h) => h.enabled !== false && h.command?.includes('foreman-guard'))) return false;
	// Ours, but switched off: switch it back on rather than adding a second one.
	const off = a.raw?.(settings) ?? a.entries(settings);
	const ours = off.filter((h) => h.command?.includes('foreman-guard'));
	if (ours.length) for (const h of ours) delete h.enabled;
	if (a.enable) a.enable(settings);
	if (!ours.length) a.add(settings, a.command);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
	return true;
}
