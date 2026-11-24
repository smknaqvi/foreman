/**
 * The coding agent tools foreman knows how to wire the merge guard into, and what each one sends a hook and
 * expects back. Every tool runs the same shim (.claude/hooks/foreman-guard.mjs, installed by `foreman init`),
 * told which tool called it with `--agent <id>`; the shim hands the decision to lib/guard.mjs.
 *
 *   Claude Code  .claude/settings.json   PreToolUse, matcher Bash             payload tool_input.command
 *   Codex        .codex/hooks.json       PreToolUse, matcher Bash             payload tool_input.command
 *   Cursor       .cursor/hooks.json      beforeShellExecution (every command) payload command
 *   Gemini CLI   .gemini/settings.json   BeforeTool, matcher run_shell_command payload tool_input.command
 *
 * Any other tool: call `foreman guard --command "<the command>"` from its own hook (exit 2 and the reason on
 * stderr when it's refused), or follow the rule in AGENTS.md by hand. git's pre-push check covers every tool.
 * The shim lives under .claude/ in every repo (as do the playbooks, .claude/skills/): that folder name is
 * historical, and every tool reads it.
 */
export const SHIM = '.claude/hooks/foreman-guard.mjs';

export const AGENTS = {
	claude: {
		name: 'Claude Code',
		settings: '.claude/settings.json',
		// $CLAUDE_PROJECT_DIR: Claude Code's project root, whichever folder the session is in.
		command: `node "$CLAUDE_PROJECT_DIR/${SHIM}"`,
		add: (s, command) => list(list(s, 'hooks', {}), 'PreToolUse', []).push({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10 }] }),
		entries: (s) => (s.hooks?.PreToolUse || []).flatMap((m) => m.hooks || []),
	},
	codex: {
		name: 'Codex',
		settings: '.codex/hooks.json',
		// Codex runs hooks in the session's folder: find the checkout's root from there. Codex asks a person to
		// trust a new or changed hook (/hooks) before running it.
		command: `node "$(git rev-parse --show-toplevel)/${SHIM}" --agent codex`,
		add: (s, command) => list(list(s, 'hooks', {}), 'PreToolUse', []).push({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'Checking the command with foreman\'s merge guard' }] }),
		entries: (s) => (s.hooks?.PreToolUse || []).flatMap((m) => m.hooks || []),
	},
	cursor: {
		name: 'Cursor',
		settings: '.cursor/hooks.json',
		// Project hooks run from the project root.
		command: `node ${SHIM} --agent cursor`,
		add: (s, command) => { s.version ??= 1; list(list(s, 'hooks', {}), 'beforeShellExecution', []).push({ command, timeout: 10 }); },
		entries: (s) => s.hooks?.beforeShellExecution || [],
	},
	gemini: {
		name: 'Gemini CLI',
		settings: '.gemini/settings.json',
		command: `node "$(git rev-parse --show-toplevel)/${SHIM}" --agent gemini`,
		add: (s, command) => list(list(s, 'hooks', {}), 'BeforeTool', []).push({ matcher: 'run_shell_command', hooks: [{ name: 'foreman-guard', type: 'command', command, timeout: 10000 }] }),
		entries: (s) => (s.hooks?.BeforeTool || []).flatMap((m) => m.hooks || []),
	},
};

const list = (o, key, empty) => (o[key] ??= empty);

/** The shell command in a hook payload from any of the tools above ('' if there's none). */
export function payloadCommand(input) {
	const c = input?.tool_input?.command ?? input?.command ?? '';
	if (Array.isArray(c)) {
		// An argv (older Codex shell tool): ["bash", "-lc", "<script>"] is the script; anything else, joined.
		const shell = /(^|\/)(ba|z|da)?sh$/.test(c[0] ?? '') && /^-\w*c$/.test(c[1] ?? '');
		return shell ? String(c[2] ?? '') : c.join(' ');
	}
	return typeof c === 'string' ? c : '';
}

/** The folder the command runs in, from a hook payload. */
export const payloadCwd = (input) => input?.cwd || input?.workspace_roots?.[0] || '';

/**
 * How to tell `agent` a command is refused: { stdout, stderr, exitCode }. Allowed commands get no output at
 * all, in every format (an explicit "allow" would skip the tool's own approval prompts).
 */
export function refusal(agent, reason) {
	switch (agent) {
		case 'cursor':
			return { stdout: JSON.stringify({ continue: true, permission: 'deny', user_message: reason, agent_message: reason }), exitCode: 0 };
		case 'gemini':
			return { stdout: JSON.stringify({ decision: 'deny', reason }), exitCode: 0 };
		case 'plain':
			return { stderr: `${reason}\n`, exitCode: 2 };
		default: // claude, codex (Codex refuses unknown fields: keep exactly these).
			return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }), exitCode: 0 };
	}
}

/** Was this payload refused, read back from what refusal() wrote? (For tests and the self-test.) */
export function refused(agent, { stdout = '', status = 0 } = {}) {
	if (agent === 'plain') return status === 2;
	let j = {};
	try { j = JSON.parse(stdout || '{}'); } catch { return false; }
	if (agent === 'cursor') return j.permission === 'deny';
	if (agent === 'gemini') return j.decision === 'deny';
	return j.hookSpecificOutput?.permissionDecision === 'deny';
}

/** A hook payload in `agent`'s shape, for tests and the self-test. */
export function samplePayload(agent, command, cwd) {
	if (agent === 'cursor') return { hook_event_name: 'beforeShellExecution', command, cwd, workspace_roots: [cwd] };
	if (agent === 'gemini') return { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command }, cwd };
	return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd };
}
