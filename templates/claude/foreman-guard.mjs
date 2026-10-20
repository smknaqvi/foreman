#!/usr/bin/env node
/**
 * Installed by `foreman init`. Claude Code runs this before every Bash command (.claude/settings.json);
 * it hands over to the merge guard in the installed foreman package, so a foreman upgrade updates it.
 * Until dependencies are installed in this checkout, it refuses gh and git push commands outright.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let guard;
try {
	guard = createRequire(join(root, 'package.json')).resolve('@smknaqvi/foreman/guard');
} catch {
	let command = '';
	try { command = JSON.parse(readFileSync(0, 'utf8') || '{}').tool_input?.command ?? ''; } catch {}
	if (/\bgh\b|\bgit\b[^\n;&|]*\bpush\b/.test(command)) {
		process.stdout.write(JSON.stringify({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'deny',
				permissionDecisionReason: 'foreman isn\'t installed in this checkout, so its merge guard can\'t check gh and git push commands. Install dependencies first (e.g. npm install).',
			},
		}));
	}
	process.exit(0);
}
(await import(pathToFileURL(guard).href)).runHook();
