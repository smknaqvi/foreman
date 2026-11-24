/**
 * The coding agent tools foreman knows how to wire the merge guard into, and what each one sends a hook and
 * expects back. Every tool runs the same shim (.claude/hooks/foreman-guard.mjs, installed by `foreman init`),
 * told which tool called it with `--agent <id>`; the shim hands the decision to lib/guard.mjs.
 *
 *   Claude Code  .claude/settings.json   PreToolUse, matcher Bash             payload tool_input.command
 *   Codex        .codex/hooks.json       PreToolUse, matcher Bash             payload tool_input.command
 *   Cursor       .cursor/hooks.json      beforeShellExecution (every command) payload command
 *   Gemini CLI   .gemini/settings.json   BeforeTool, matcher run_shell_command payload tool_input.command
 *   Antigravity  .agents/hooks.json      PreToolUse, matcher run_command      payload toolCall.args.CommandLine
 *                (CLI, IDE and app; it also finds the playbooks through links in .agents/skills/)
 *
 * Any other tool: call `foreman guard --command "<the command>"` from its own hook (exit 2 and the reason on
 * stderr when it's refused), or follow the rule in AGENTS.md by hand. git's pre-push check covers every tool.
 * The shim lives under .claude/ in every repo (as do the playbooks, .claude/skills/): that folder name is
 * historical, and every tool reads it.
 */
import { resolve } from 'node:path';

export const SHIM = '.claude/hooks/foreman-guard.mjs';

/** The commands refused whenever the guard can't check them: anything running gh, and git pushes. */
export const GUARDED = /\bgh\b|\bgit\b[^\n;&|]*\bpush\b/;

// Antigravity's fallback when the shim can't be found: refuse gh and git push, allow the rest (same rule as the
// shim's own when it can't trust the guard). Kept free of single quotes: it sits inside one in a shell command.
const AG_FALLBACK = `let r="";process.stdin.on("data",(d)=>r+=d).on("end",()=>{let c="";try{c=String(JSON.parse(r).toolCall.args.CommandLine||"")}catch(e){}process.stdout.write(JSON.stringify(${GUARDED}.test(c)?{decision:"deny",reason:"The foreman merge guard (${SHIM}) was not found from this folder, so it refuses gh and git push. Open the repository itself as the workspace."}:{decision:"allow"}))})`;

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
		// $GEMINI_PROJECT_DIR when Gemini CLI sets it, else the checkout holding the session's folder.
		command: `node "\${GEMINI_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/${SHIM}" --agent gemini`,
		add: (s, command) => list(list(s, 'hooks', {}), 'BeforeTool', []).push({ matcher: 'run_shell_command', hooks: [{ name: 'foreman-guard', type: 'command', command, timeout: 10000 }] }),
		entries: (s) => (s.hooks?.BeforeTool || []).flatMap((m) => m.hooks || []),
	},
	antigravity: {
		name: 'Antigravity',
		settings: '.agents/hooks.json',
		// Antigravity's docs don't say which folder hooks run in (its examples use ./scripts/..., so presumably
		// the workspace): find the checkout's root from there, and if the shim can't be found, refuse rather than
		// say nothing (what Antigravity does with no answer isn't documented).
		command: `f="$(git rev-parse --show-toplevel 2>/dev/null)/${SHIM}"; if [ -f "$f" ]; then exec node "$f" --agent antigravity; fi; exec node -e '${AG_FALLBACK}'`,
		// Its hooks.json maps a hook name to its events.
		add: (s, command) => list(list(s, 'foreman-guard', {}), 'PreToolUse', []).push({ matcher: 'run_command', hooks: [{ type: 'command', command, timeout: 10 }] }),
		// A named hook with "enabled": false doesn't run.
		entries: (s) => Object.values(s).flatMap((v) => (v && typeof v === 'object' && v.enabled !== false ? v.PreToolUse || [] : []).flatMap((m) => m.hooks || [])),
		// Every hook, switched off or not (to switch ours back on), and how to switch the named hook back on.
		raw: (s) => Object.values(s).flatMap((v) => (v && typeof v === 'object' ? v.PreToolUse || [] : []).flatMap((m) => m.hooks || [])),
		// Any named hook holding our command (moved under another name or not).
		enable: (s) => { for (const v of Object.values(s)) if (v && typeof v === 'object' && JSON.stringify(v.PreToolUse || []).includes('foreman-guard')) delete v.enabled; },
		// .agents/ alone may be another tool's (Codex reads .agents/skills/ too): only the hooks file means Antigravity.
		marker: '.agents/hooks.json',
		// Antigravity looks for skills in .agents/skills/, not .claude/skills/: link each playbook there.
		skills: '.agents/skills',
	},
};

const list = (o, key, empty) => (o[key] ??= empty);

/** The shell command in a hook payload from any of the tools above ('' if there's none). */
export function payloadCommand(input) {
	const c = input?.tool_input?.command ?? input?.toolCall?.args?.CommandLine ?? input?.command ?? '';
	if (Array.isArray(c)) {
		// An argv (older Codex shell tool): ["bash", "-lc", "<script>"] is the script; anything else, joined.
		const shell = /(^|\/)(ba|z|da)?sh$/.test(c[0] ?? '') && /^-\w*c$/.test(c[1] ?? '');
		return shell ? String(c[2] ?? '') : c.join(' ');
	}
	return typeof c === 'string' ? c : '';
}

/**
 * The folder the command runs in, from a hook payload: the shell tool's own folder when it names one
 * (Gemini CLI's dir_path, Codex's workdir), relative to the session's.
 */
export function payloadCwd(input) {
	const session = input?.cwd || input?.workspace_roots?.[0] || input?.workspacePaths?.[0] || '';
	const own = input?.tool_input?.dir_path || input?.tool_input?.workdir || input?.toolCall?.args?.Cwd || '';
	return own ? resolve(session || process.cwd(), own) : session;
}

/**
 * How to tell `agent` a command is refused: { stdout, stderr, exitCode }. Allowed commands get no output at
 * all (an explicit "allow" would skip the tool's own approval prompts), except where the tool requires an
 * answer: allowed() below.
 */
export function refusal(agent, reason) {
	switch (agent) {
		case 'cursor':
			return { stdout: JSON.stringify({ continue: true, permission: 'deny', user_message: reason, agent_message: reason }), exitCode: 0 };
		case 'gemini':
		case 'antigravity':
			return { stdout: JSON.stringify({ decision: 'deny', reason }), exitCode: 0 };
		case 'plain':
			return { stderr: `${reason}\n`, exitCode: 2 };
		default: // claude, codex (Codex refuses unknown fields: keep exactly these).
			return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }), exitCode: 0 };
	}
}

/**
 * What to print for an allowed command: nothing, except for Antigravity, whose PreToolUse hooks must answer.
 * Its "allow" hands the decision on to its own approval rules (unlike "auto_approve"), so nothing is skipped.
 */
export const allowed = (agent) => (agent === 'antigravity' ? JSON.stringify({ decision: 'allow' }) : '');

/** Was this payload refused, read back from what refusal() wrote? (For tests and the self-test.) */
export function refused(agent, { stdout = '', status = 0 } = {}) {
	if (agent === 'plain') return status === 2;
	let j = {};
	try { j = JSON.parse(stdout || '{}'); } catch { return false; }
	if (agent === 'cursor') return j.permission === 'deny';
	if (agent === 'gemini' || agent === 'antigravity') return j.decision === 'deny';
	return j.hookSpecificOutput?.permissionDecision === 'deny';
}

/** A hook payload in `agent`'s shape, for tests and the self-test. */
export function samplePayload(agent, command, cwd) {
	if (agent === 'cursor') return { hook_event_name: 'beforeShellExecution', command, cwd, workspace_roots: [cwd] };
	if (agent === 'gemini') return { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command }, cwd };
	if (agent === 'antigravity') return { toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: cwd } }, workspacePaths: [cwd], stepIdx: 0 };
	return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd };
}
