#!/usr/bin/env node
/**
 * Installed by `foreman init`. Claude Code runs this before every Bash command (.claude/settings.json);
 * it hands the decision to the merge guard in the installed foreman package, so a foreman upgrade updates it.
 * Whenever that guard can't be trusted to run, it refuses gh and git push commands (everything else runs):
 *   - foreman isn't installed in this checkout yet,
 *   - the installed foreman isn't the one package-lock.json pins (run npm install after a rebase),
 *   - the guard fails to load.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = '@smknaqvi/foreman';
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch {}
let command = '';
try { command = JSON.parse(raw || '{}').tool_input?.command ?? ''; } catch {}
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
// No process.exit(): exiting at once can cut off the answer while it's still being written to the pipe.
if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
