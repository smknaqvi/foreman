#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook (Bash): only `foreman merge` may merge a PR, nothing writes to the base
 * branch directly, and only `foreman approve` writes the Coordinator's approval. Where GitHub branch
 * protection isn't available this is what enforces the gate for every agent; where it is, it's a second layer.
 *
 * It reads the command an agent typed, the way bash would: quotes, line continuations, heredocs and
 * here-strings, $(...) and backticks, redirections, `cd`, branch switches, keywords (if/then, loops, { })
 * and wrappers (timeout, xargs, nohup, bash -c, eval, scripts piped into a shell). It catches accidental
 * bypasses, not deliberate obfuscation. Programs it calls (foreman merge, foreman approve) aren't
 * inspected, which is what lets them do their job. People merging by hand are not affected.
 * Installed in a repo by `foreman init` (.claude/hooks/foreman-guard.mjs calls runHook below).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { loadConfig } from './config.mjs';

// The environment variable a person sets to push to the base branch on purpose (.githooks/pre-push).
export const OVERRIDE = 'FOREMAN_ALLOW_BASE_PUSH';
const MERGE = 'Only foreman merges PRs here (it checks the approval, that the PR is up to date and that checks are green). Run: npx --no-install foreman merge <PR> [--rebased-from <approved sha>]';
const PUSH = (base) => `Nothing writes to ${base} directly. Push your branch and open a PR; it merges through foreman merge after review.`;
const APPROVE = 'Only the Coordinator approves a PR, with foreman approve after reviewing it. Builders report back and wait.';
const GRAPHQL = 'This GraphQL call\'s query isn\'t visible (it comes from a file, stdin or a substitution), so the merge guard can\'t check it. Put the query inline with -f query=\'...\'.';

const SP = '\u0001'; // Stands in for whitespace inside a quoted word, so the word stays one token.
const VAR = '\u0002'; // Stands in for a $variable: a value the guard can't know.
const varLength = (s, at) => { // Length of the $name, ${...} or $1/$@... starting at `at`, or 0.
	if (s[at] !== '$') return 0;
	if (s[at + 1] === '{') { const k = s.indexOf('}', at); return (k < 0 ? s.length : k + 1) - at; }
	if (/[@*#?!$0-9-]/.test(s[at + 1] ?? '')) return 2;
	const m = s.slice(at + 1).match(/^[A-Za-z_]\w*/);
	return m ? 1 + m[0].length : 0;
};
const SHELLS = ['bash', 'sh', 'zsh', 'dash'];
const HEREDOC = /^-?[ \t]*((?:'[^']*'|"[^"]*"|\\.|[^\s;&|<>()'"\\])+)/; // After <<: the delimiter word.
const heredocDelim = (m) => ({ delim: m[1].replace(/\\(.)|['"]/g, '$1'), quoted: /['"\\]/.test(m[1]) }); // E'OF' ends at EOF; any quoting makes the body text.
const HOOKS_OFF = 'Git\'s pre-push check (.githooks/pre-push, core.hooksPath) stays on: it is what stops pushes to the base branch. Push your branch and open a PR instead.';
const isScriptFlag = (w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w); // -c, -lc, -ec, -xc...

/**
 * Split a command line into simple commands: { words, pipedFrom }. Words have quotes removed. Command
 * substitutions found anywhere (in double quotes and unquoted heredoc bodies too) are returned in `subs`,
 * because bash runs them. Heredoc bodies and here-strings are returned in `stdin` with the command they
 * feed, so a shell reading its script from stdin can be checked. Single-quoted text and comments are data.
 */
function parse(cmd) {
	const commands = [], subs = [];
	let words = [], word = '', inWord = false, pipedFrom = null, redirect = null;
	const heredocs = [];
	let current = { words, stdin: [], pipedFrom };
	const endWord = () => {
		if (inWord) {
			if (redirect === 'herestring') current.stdin.push(word.replaceAll(SP, ' '));
			else if (!redirect) words.push(word);
		}
		if (inWord || redirect === null) redirect = null;
		word = ''; inWord = false;
	};
	const endCommand = (sep) => {
		endWord(); redirect = null;
		if (words.length || current.stdin.length) commands.push(current);
		const prev = words.length ? current : null;
		words = []; current = { words, stdin: [], pipedFrom: sep === '|' ? prev : null };
	};
	const closeParen = (from) => { // Index of the ')' matching the '(' at `from`, skipping quotes and heredoc bodies.
		let depth = 0;
		const pending = [];
		for (let k = from; k < cmd.length; k++) {
			const ch = cmd[k];
			if (ch === '\\') { k++; continue; }
			if (ch === "'") { const j = cmd.indexOf("'", k + 1); if (j < 0) return cmd.length; k = j; continue; }
			if (ch === '"') { let j = k + 1; while (j < cmd.length && cmd[j] !== '"') j += cmd[j] === '\\' ? 2 : 1; k = j; continue; }
			if (ch === '<' && cmd[k + 1] === '<' && cmd[k + 2] !== '<') {
				const m = cmd.slice(k + 2).match(HEREDOC);
				if (m) { pending.push(heredocDelim(m).delim); k += 1 + m[0].length; }
				continue;
			}
			if (ch === '\n' && pending.length) { // Skip heredoc bodies: their text can hold unmatched parentheses.
				for (const delim of pending.splice(0)) {
					let line;
					do {
						const nl = cmd.indexOf('\n', k + 1), end = nl < 0 ? cmd.length : nl;
						line = cmd.slice(k + 1, end);
						k = end;
					} while (k < cmd.length && line.replace(/^\t+/, '') !== delim);
				}
				continue;
			}
			if (ch === '(') depth++;
			else if (ch === ')' && --depth === 0) return k;
		}
		return cmd.length;
	};
	// ${A:-$(cmd)} runs cmd too. (The expansion's own end is found at the first }, so keep defaults simple.)
	const subsInVar = (text) => { for (const m of text.matchAll(/\$\(([^)]*)\)?|`([^`]*)`/g)) subs.push(m[1] ?? m[2]); };
	let i = 0;
	while (i < cmd.length) {
		const c = cmd[i];
		if (c === '\\') {
			if (cmd[i + 1] === '\n') { i += 2; continue; } // Line continuation.
			word += cmd[i + 1] ?? ''; inWord = true; i += 2; continue;
		}
		if (c === "'") {
			const j = cmd.indexOf("'", i + 1), end = j < 0 ? cmd.length : j;
			word += cmd.slice(i + 1, end).replace(/\s/g, SP); inWord = true; i = end + 1; continue;
		}
		if (c === '"') {
			let j = i + 1;
			while (j < cmd.length && cmd[j] !== '"') {
				if (cmd[j] === '\\') { if (cmd[j + 1] !== '\n') word += cmd[j + 1] ?? ''; j += 2; continue; }
				if (cmd[j] === '`') { const k = cmd.indexOf('`', j + 1), end = k < 0 ? cmd.length : k; subs.push(cmd.slice(j + 1, end)); word += VAR; j = end + 1; continue; }
				if (cmd[j] === '$' && cmd[j + 1] === '(') { const end = closeParen(j + 1); subs.push(cmd.slice(j + 2, end)); word += VAR; j = end + 1; continue; }
				if (varLength(cmd, j)) { subsInVar(cmd.slice(j, j + varLength(cmd, j))); word += VAR; j += varLength(cmd, j); continue; }
				word += /\s/.test(cmd[j]) ? SP : cmd[j]; j++;
			}
			inWord = true; i = j + 1; continue;
		}
		if (c === '`') { const k = cmd.indexOf('`', i + 1), end = k < 0 ? cmd.length : k; subs.push(cmd.slice(i + 1, end)); word += VAR; inWord = true; i = end + 1; continue; }
		if (c === '$' && cmd[i + 1] === '(') { const end = closeParen(i + 1); subs.push(cmd.slice(i + 2, end)); word += VAR; inWord = true; i = end + 1; continue; }
		if (varLength(cmd, i)) { subsInVar(cmd.slice(i, i + varLength(cmd, i))); word += VAR; inWord = true; i += varLength(cmd, i); continue; }
		if (c === '#' && !inWord) { while (i < cmd.length && cmd[i] !== '\n') i++; continue; }
		if (c === '(' && cmd[i + 1] === '(' && !inWord) { const k = cmd.indexOf('))', i + 2); i = k < 0 ? cmd.length : k + 2; continue; } // Arithmetic: (( n << 2 )) is no heredoc.
		if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] === '<') { endWord(); redirect = 'herestring'; i += 3; continue; }
		if (c === '<' && cmd[i + 1] === '<') { // Heredoc: note its delimiter; the body starts on the next line.
			endWord();
			const m = cmd.slice(i + 2).match(HEREDOC);
			if (m) { heredocs.push({ ...heredocDelim(m), owner: current }); i += 2 + m[0].length; }
			else i += 2;
			continue;
		}
		if (c === '<' || c === '>' || (c === '&' && cmd[i + 1] === '>')) { // Redirection: the next word is its target, not an argument.
			if (/^\d+$/.test(word)) { word = ''; inWord = false; } else endWord();
			i++;
			while (/[<>&|]/.test(cmd[i] ?? '')) i++;
			if (cmd[i - 1] === '&' && /[\d-]/.test(cmd[i] ?? '')) { while (/[\d-]/.test(cmd[i] ?? '')) i++; continue; }
			redirect = 'file';
			continue;
		}
		if (c === '\n') {
			endCommand('\n'); i++;
			for (const h of heredocs.splice(0)) { // Consume each pending heredoc body.
				const body = [];
				while (i < cmd.length) {
					const nl = cmd.indexOf('\n', i), end = nl < 0 ? cmd.length : nl;
					const line = cmd.slice(i, end);
					i = end + 1;
					if (line.replace(/^\t+/, '') === h.delim) break;
					body.push(line);
					if (!h.quoted) for (const m of line.matchAll(/(?<!\\)`([^`]*)`|(?<!\\)\$\(([^)]*)\)/g)) subs.push(m[1] ?? m[2]); // \` and \$( are literal.
				}
				h.owner.stdin.push(body.join('\n'));
			}
			continue;
		}
		if ((c === '{' || c === '}') && !inWord && /[\s;]|^$/.test(cmd[i + 1] ?? '')) { endCommand(c); i++; continue; } // Only a lone { or } groups.
		if (c === '|' && cmd[i + 1] === '&') { endCommand('|'); i += 2; continue; } // |& pipes stderr too.
		if (';&|()'.includes(c)) { const pipe = c === '|' && cmd[i + 1] !== '|' && cmd[i - 1] !== '|'; endCommand(pipe ? '|' : c); i++; continue; }
		if (c === ' ' || c === '\t') { endWord(); i++; continue; }
		word += c; inWord = true; i++;
	}
	endCommand('\n');
	return { commands, subs };
}

const literal = (w) => w.replaceAll(SP, ' ');

// Words that run the rest of the command: keywords, prefixes and wrappers. Returns the real command's words
// and the VAR=value assignments in front of it.
function unwrap(words) {
	const w = [...words], env = {};
	for (;;) {
		const h = w[0];
		if (h === undefined) return { w, env };
		const a = h.match(/^([A-Za-z_]\w*)=(.*)$/s);
		if (a) { env[a[1]] = literal(a[2]); w.shift(); continue; }
		if (['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'builtin', '{', '}'].includes(h)) { w.shift(); continue; }
		if (['time', 'nohup', 'caffeinate'].includes(h)) { w.shift(); while (w[0]?.startsWith('-')) { if (['-w', '-t', '-o'].includes(w.shift())) w.shift(); } continue; }
		if (['sudo', 'exec', 'command'].includes(h)) { w.shift(); while (w[0]?.startsWith('-')) { if (/^-[ugChpRrTUa]$/.test(w.shift())) w.shift(); } continue; }
		if (h === 'env' || h === 'nice') {
			w.shift();
			while (w[0]?.startsWith('-') || /^[A-Za-z_]\w*=/.test(w[0] ?? '')) {
				const x = w.shift(), m = x.match(/^([A-Za-z_]\w*)=(.*)$/s);
				if (m) env[m[1]] = literal(m[2]);
				else if (['-n', '-u', '-C', '--chdir'].includes(x)) w.shift();
				else if (x === '-S' || x === '--split-string') w.unshift(...literal(w.shift() ?? '').split(/\s+/).filter(Boolean));
			}
			continue;
		}
		if (h === 'timeout') { w.shift(); while (w[0]?.startsWith('-')) { if (['-s', '-k', '--signal', '--kill-after'].includes(w.shift())) w.shift(); } w.shift(); continue; }
		if (h === 'xargs') { w.shift(); while (w[0]?.startsWith('-')) { if (/^-[nIPLsdaE]$/.test(w.shift())) w.shift(); } continue; }
		return { w, env };
	}
}

function gitBranch(dir, gitDirPath) {
	try {
		const where = gitDirPath ? ['--git-dir', gitDirPath] : [];
		return execFileSync('git', [...where, 'symbolic-ref', '--short', '-q', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return '';
	}
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Is `ref` the base branch? Git also resolves heads/<base> and refs/heads/<base>.
const baseMatcher = (base) => { const re = new RegExp(`^(?:refs\\/)?(?:heads\\/)?${escape(base)}$`); return (ref) => re.test(ref); };

function checkPush(args, branchOf, rules) {
	const { isBase } = rules, PUSHED = PUSH(rules.base);
	const positional = [];
	let remoteGiven = false;
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		// Git accepts unambiguous abbreviations (--no-verif, --mirr). --no-verify skips .githooks/pre-push.
		if (/^--[a-z-]{2,}$/.test(a) && ['--all', '--mirror', '--branches', '--no-verify'].some((o) => o.startsWith(a))) return PUSHED;
		if (a === '--repo') { remoteGiven = true; k++; continue; }
		if (a.startsWith('--repo=')) { remoteGiven = true; continue; }
		if (['-o', '--push-option', '--receive-pack', '--exec'].includes(a)) { k++; continue; }
		if (a.startsWith('-') && a !== '-') continue;
		positional.push(a);
	}
	const refspecs = remoteGiven ? positional : positional.slice(1); // Otherwise the first is the remote.
	if (!refspecs.length) return isBase(branchOf()) ? PUSHED : '';
	for (const spec of refspecs) {
		const r = spec.replace(/^\+/, '');
		const [src, dst] = r.includes(':') ? r.split(':') : [r, r];
		if (isBase(dst) || (r.includes(':') && dst.includes(VAR)) || dst.includes('*')) return PUSHED; // src:$B or refs/heads/* could be the base.
		// The current branch, by name or by a value the guard can't read ("$(git branch --show-current)", $BRANCH).
		if (!r.includes(':') && (src === 'HEAD' || src === '@' || src === '' || src.includes(VAR)) && isBase(branchOf())) return PUSHED;
	}
	return '';
}

function checkApi(args, stdin, subs, rules) {
	const { isBase, base, context } = rules, PUSHED = PUSH(base);
	let method = '', hasFields = false, endpoint = '', input = false;
	const fields = [];
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (a === '-X' || a === '--method') { method = (args[++k] ?? '').toUpperCase(); continue; }
		const m = a.match(/^(?:-X|--method=)(\w+)$/);
		if (/^--input=/.test(a)) { hasFields = true; input = true; continue; }
		if (m) { method = m[1].toUpperCase(); continue; }
		if (a === '--input') { hasFields = true; input = true; k++; continue; }
		if (/^(?:-f|-F|--field|--raw-field)$/.test(a)) { hasFields = true; fields.push(args[++k] ?? ''); continue; }
		const f = a.match(/^(?:--field=|--raw-field=|-f|-F)(.+)$/);
		if (f) { hasFields = true; fields.push(f[1]); continue; }
		if (/^(?:-H|--header|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)$/.test(a)) { k++; continue; }
		if (a.startsWith('-')) continue;
		if (!endpoint) endpoint = a;
	}
	method ||= hasFields ? 'POST' : 'GET';
	// A query written as "$(cat <<'EOF' ... EOF)" is visible: its text is in the substitution.
	const heredocSubs = subs.filter((x) => /<<-?\s*['"]/.test(x));
	const text = literal([...args, ...stdin, ...heredocSubs].join(' '));
	const ep = endpoint.split('?')[0].replace(/^https?:\/\/[^/]+\//, '').replace(/^api\/v3\//, '').replace(/^\/+|\/+$/g, '');
	if (ep === 'graphql') {
		if (/\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/.test(text)) return MERGE;
		if (/\b(?:updateRef|updateRefs|createCommitOnBranch|deleteRef)\b/.test(text)) return PUSHED;
		const query = fields.find((x) => x.startsWith('query='))?.slice(6);
		const hidden = input ? !stdin.length : query === undefined || query.startsWith('@') || query === '' || (query.includes(VAR) && !(query === VAR && heredocSubs.length));
		if (hidden) return GRAPHQL;
		return '';
	}
	if (method === 'GET') return '';
	if (/\/pulls\/[^/]+\/merge$/.test(ep) || /\/merges$/.test(ep)) return MERGE;
	if (ep.endsWith(`/git/refs/heads/${base}`) || (/\/git\/refs$/.test(ep) && new RegExp(`refs\\/heads\\/${escape(base)}(?![\\w.\\/-])`).test(text))) return PUSHED;
	if (/\/git\/refs\b/.test(ep) && (ep.includes(VAR) || fields.some((x) => x.startsWith('ref=') && x.includes(VAR)))) return PUSHED; // Could be the base.
	if (/\/contents\//.test(ep) && ['PUT', 'DELETE'].includes(method)) {
		const branch = fields.find((x) => x.startsWith('branch='))?.slice(7);
		if (!branch || isBase(branch) || branch.includes(VAR) || branch.startsWith('@')) return PUSHED; // Without a branch, GitHub commits to the default branch.
	}
	// Statuses: refuse the approval context, or one the guard can't read (a file, stdin, a variable).
	if (/\/statuses\/[^/]+$/.test(ep) && (text.includes(context) || input || fields.some((x) => x.includes(VAR) || /^\w+=@/.test(x)))) return APPROVE;
	return '';
}

/**
 * Why this command must not run, or '' if it's fine. `options` defaults to the foreman.config.json found
 * from `cwd`: { baseBranch, approvalContext }.
 */
export function blockedReason(command, cwd = process.cwd(), options) {
	const { baseBranch: base, approvalContext: context } = options ?? loadConfig(cwd);
	return check(command, cwd, 0, { base, context, isBase: baseMatcher(base) });
}

function check(command, cwd, depth, rules) {
	if (depth > 4) return '';
	const PUSHED = PUSH(rules.base);
	const { commands, subs } = parse(command);
	let dir = cwd;
	const switched = new Map(); // Branch switches earlier in this command line, per directory.
	const branchIn = (d) => () => switched.get(d) ?? gitBranch(d);
	for (const cmdInfo of commands) {
		const { w, env } = unwrap(cmdInfo.words);
		if (!w.length) continue;
		const prog = basename(w[0]);
		const stdin = [...cmdInfo.stdin];
		// Text piped in from echo/printf is the script when a shell reads stdin.
		if (cmdInfo.pipedFrom) { const p = unwrap(cmdInfo.pipedFrom.words).w; if (['echo', 'printf'].includes(basename(p[0] ?? ''))) stdin.push(literal(p.slice(1).filter((x) => !x.startsWith('-')).join(' '))); stdin.push(...cmdInfo.pipedFrom.stdin); }
		if (prog === 'export' && w.some((x) => x.startsWith(OVERRIDE))) return PUSHED;
		if (['rm', 'mv', 'chmod', 'unlink', 'truncate'].includes(prog) && w.some((x) => /(?:^|\/)\.githooks(?:\/|$)/.test(literal(x)))) return HOOKS_OFF;
		if (prog === 'cd') { const to = w[1] ? literal(w[1]) : homedir(); if (to !== '-') dir = resolve(dir, to.replace(/^~(?=\/|$)/, homedir())); continue; }
		if (SHELLS.includes(prog)) {
			const c = w.findIndex(isScriptFlag);
			const scripts = c > 0 ? [w[c + 1] ? literal(w[c + 1]) : ''] : w.slice(1).every((x) => x.startsWith('-')) ? stdin : [];
			for (const s of scripts) { const r = check(s, dir, depth + 1, rules); if (r) return r; }
			continue;
		}
		if (prog === 'eval') { const r = check(literal(w.slice(1).join(' ')), dir, depth + 1, rules); if (r) return r; continue; }
		if (prog === 'gh') {
			const a = w.slice(1);
			const positional = a.filter((x, k) => !x.startsWith('-') && !/^(?:-R|--repo)$/.test(a[k - 1] ?? ''));
			if (positional[0] === 'pr' && positional[1] === 'merge') return MERGE;
			if (positional[0] === 'api') { const r = checkApi(a.slice(a.indexOf('api') + 1), stdin, subs, rules); if (r) return r; }
			continue;
		}
		if (prog === 'git') {
			const a = w.slice(1);
			let gitDir = dir, gitDirPath = env.GIT_DIR, config = [];
			while (a[0]?.startsWith('-')) {
				const opt = a.shift();
				const eq = opt.match(/^--(git-dir|work-tree|namespace|config-env)=(.*)$/);
				if (opt === '-C') gitDir = resolve(gitDir, literal(a.shift() ?? '.'));
				else if (opt === '-c' || opt === '--config-env') config.push(literal(a.shift() ?? ''));
				else if (opt === '--git-dir') gitDirPath = literal(a.shift() ?? '');
				else if (opt === '--work-tree' || opt === '--namespace') a.shift();
				else if (eq?.[1] === 'git-dir') gitDirPath = literal(eq[2]);
			}
			const [sub, ...rest] = a;
			// Changing core.hooksPath (anything but setting it to .githooks) switches off the pre-push check.
			if (sub === 'config' && rest.some((x) => /^core\.hookspath$/i.test(x))) {
				const value = rest[rest.findIndex((x) => /^core\.hookspath$/i.test(x)) + 1];
				const removing = rest.some((x) => /^(?:--)?(?:unset|unset-all|remove-section|rename-section|edit|replace-all)$/.test(x));
				const keepsIt = (v) => /^(?:\.\/)?\.githooks\/?$/.test(v) || /(?:^|\/)\.githooks\/?$/.test(v); // .githooks, ./.githooks, $PWD/.githooks
				if (removing || (value !== undefined && !value.startsWith('-') && !keepsIt(literal(value)))) return HOOKS_OFF;
			}
			if (sub === 'push') {
				// Turning off or overriding the pre-push check counts as pushing to the base.
				if (OVERRIDE in env || config.some((x) => /^core\.hookspath/i.test(x))) return PUSHED;
				const branchOf = gitDirPath ? () => gitBranch(gitDir, resolve(gitDir, gitDirPath)) : branchIn(gitDir);
				const r = checkPush(rest.map(literal), branchOf, rules);
				if (r) return r;
			}
			if (sub === 'checkout' || sub === 'switch') {
				const create = rest.findIndex((x) => /^-[bBcC]$/.test(x));
				const name = create >= 0 ? rest[create + 1] : rest.filter((x) => !x.startsWith('-')).length === 1 ? rest.find((x) => !x.startsWith('-')) : undefined;
				if (rest.includes('-') || name === '@{-1}') switched.set(gitDir, rules.base); // Back to the previous branch: could be the base.
				else if (name && !rest.includes('--') && (create >= 0 || !existsSync(resolve(gitDir, literal(name))))) switched.set(gitDir, literal(name));
			}
		}
	}
	for (const s of subs) { const r = check(s, dir, depth + 1, rules); if (r) return r; }
	return '';
}

/**
 * Why the command in a PreToolUse payload (the raw JSON Claude Code sends) must not run, or '' if it's fine.
 * A broken foreman.config.json refuses every gh and git push command rather than guessing the settings.
 */
export function decide(raw) {
	let input;
	try {
		input = JSON.parse(raw || '{}');
	} catch {
		return ''; // Not our business if the payload is unreadable.
	}
	const cwd = input.cwd || process.cwd();
	const command = input.tool_input?.command ?? '';
	try {
		return blockedReason(command, cwd, loadConfig(cwd));
	} catch (e) {
		// Without the config the guard doesn't know the base branch, so it can't tell which pushes and API
		// calls are safe: refuse them all until the config is fixed (other commands, like an edit, still run).
		if (!/^foreman.config.json|isn't valid JSON/.test(e.message)) throw e;
		return /\bgh\b|\bgit\b[^\n;&|]*\bpush\b/.test(command) ? `${e.message}. Until it's fixed the merge guard can't check gh and git push commands, so it refuses them.` : '';
	}
}

/** The hook itself: the payload on stdin, a deny decision on stdout when the command is blocked. */
export function runHook() {
	try {
		const reason = decide(readFileSync(0, 'utf8'));
		if (reason) {
			process.stdout.write(JSON.stringify({
				hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
			}));
		}
	} catch (e) {
		// A bug here must not stall every command: report it (exit 1 is a visible, non-blocking hook error).
		process.stderr.write(`foreman guard failed, command not checked: ${e.message}\n`);
		process.exitCode = 1;
	}
}
