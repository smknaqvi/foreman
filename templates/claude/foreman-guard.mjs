#!/usr/bin/env node
/**
 * Installed by `foreman init`. Every agent tool it's wired into runs this before each shell command, saying which
 * tool it is with --agent (none: Claude Code, from .claude/settings.json; codex from .codex/hooks.json, cursor
 * from .cursor/hooks.json, gemini from .gemini/settings.json). It hands the decision to the merge guard in the
 * installed foreman package, so a foreman upgrade updates it, and answers in that tool's format.
 * Whenever that guard can't be trusted to run, it refuses gh and git push commands (everything else runs):
 *   - foreman isn't installed in this checkout yet,
 *   - the installed foreman isn't the one package-lock.json pins (run npm install after a rebase),
 *   - the guard fails to load.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = '@smknaqvi/foreman';
const at = process.argv.indexOf('--agent');
const agent = (at > 0 && process.argv[at + 1]) || 'claude';
// The checkout this file is in (<root>/.claude/hooks/), whichever tool runs it and from wherever.
const root = process.env.CLAUDE_PROJECT_DIR || fileURLToPath(new URL('../..', import.meta.url));
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch {}
let command = '';
try { const p = JSON.parse(raw || '{}'); command = [p.tool_input?.command ?? p.command ?? ''].flat().join(' '); } catch {}
const guarded = /\bgh\b|\bgit\b[^\n;&|]*\bpush\b/.test(command);
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

let reason = '';
try {
	const require = createRequire(join(root, 'package.json'));
	let pkgFile;
	try { pkgFile = require.resolve(`${PKG}/package.json`); } catch { throw new Error('foreman isn\'t installed in this checkout: run npm install'); }
	// The installed foreman must be the reviewed one: same version and, when npm recorded it, same source.
	const lockFile = join(root, 'package-lock.json');
	const locked = existsSync(lockFile) ? json(lockFile).packages?.[`node_modules/${PKG}`] : undefined;
	// A linked install (npm link, file:, workspaces) is local work on foreman itself: nothing pinned to compare.
	// No entry at all (an old lockfile, a nested workspace) also skips this check; the guard still runs.
	if (locked && !locked.link) {
		const hidden = join(root, 'node_modules/.package-lock.json');
		const installed = { version: json(pkgFile).version, resolved: existsSync(hidden) ? json(hidden).packages?.[`node_modules/${PKG}`]?.resolved : undefined };
		if (installed.version !== locked.version || (installed.resolved && locked.resolved && installed.resolved !== locked.resolved))
			throw new Error(`the installed foreman (${installed.version}) isn't the one package-lock.json pins (${locked.version}): run npm install`);
	}
	const { decide } = await import(pathToFileURL(require.resolve(`${PKG}/guard`)).href);
	if (typeof decide !== 'function') throw new Error('the installed foreman has no decide(): reinstall it');
	reason = decide(raw);
} catch (e) {
	if (guarded) reason = `The merge guard can't run (${e.message}), so it refuses gh and git push commands until that's fixed.`;
}
// Each tool's way of saying no (lib/agents.mjs, refusal()). An allowed command gets no output.
const answers = {
	cursor: (r) => ({ continue: true, permission: 'deny', user_message: r, agent_message: r }),
	gemini: (r) => ({ decision: 'deny', reason: r }),
	claude: (r) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r } }),
};
// No process.exit(): exiting at once can cut off the answer while it's still being written to the pipe.
if (reason) process.stdout.write(JSON.stringify((answers[agent] || answers.claude)(reason)));
