/**
 * `foreman guard --self-test`: are this repo's guards wired in and refusing what they should? Runs the
 * installed Claude Code hook the way Claude Code does (a payload on stdin) and git's pre-push check the way
 * git does, with no GitHub access, so CI can run it on every PR. (`foreman doctor` checks more, including
 * GitHub, for a person setting up a checkout.)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OVERRIDE } from './guard.mjs';

export function selfTest(config) {
	const root = config.root;
	const base = config.baseBranch;
	const hook = join(root, '.claude/hooks/foreman-guard.mjs');
	const settings = join(root, '.claude/settings.json');
	const results = [];
	const check = (name, fn) => {
		let ok = false, note = '';
		try { ok = fn(); } catch (e) { note = e.message.split('\n')[0]; }
		results.push([name, ok, note]);
	};

	const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
	delete env[OVERRIDE]; // A person's override must not skew the test.
	const denied = (command) => {
		if (!existsSync(hook)) throw new Error('.claude/hooks/foreman-guard.mjs is missing: npx --no-install foreman init');
		const out = execFileSync('node', [hook], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root }), encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
		return JSON.parse(out || '{}').hookSpecificOutput?.permissionDecision === 'deny';
	};
	check('the hook is wired into .claude/settings.json', () => existsSync(hook) && existsSync(settings) && readFileSync(settings, 'utf8').includes('foreman-guard'));
	check('blocks gh pr merge', () => denied('gh pr merge 1'));
	check(`blocks pushing to ${base}`, () => denied(`git push origin ${base}`));
	check('blocks a hand-written approval', () => denied(`gh api repos/o/r/statuses/abc -f state=success -f context=${config.approvalContext}`));
	check('lets foreman merge through', () => !denied('npx --no-install foreman merge 1 --rebased-from 0123456789abcdef0123456789abcdef01234567'));
	check('lets ordinary commands through (and trusts the installed foreman)', () => !denied('git push -u origin builder/issue-1-example') && !denied('gh pr view 1') && !denied(config.verifyCommand));

	// The pre-push check as committed (CI checkouts don't switch core.hooksPath on).
	const prePush = join(root, '.githooks/pre-push');
	const refuses = (target) => {
		if (!existsSync(prePush)) throw new Error('.githooks/pre-push is missing: npx --no-install foreman init');
		try { execFileSync('bash', [prePush], { cwd: root, input: `refs/heads/x 1 refs/heads/${target} 2\n`, stdio: ['pipe', 'ignore', 'ignore'], env }); return false; } catch { return true; }
	};
	check(`pre-push refuses ${base}`, () => refuses(base));
	check('pre-push allows other branches', () => !refuses(`${base}-fix`));

	const failed = results.filter(([, ok]) => !ok);
	for (const [name, ok, note] of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${note ? ` (${note})` : ''}`);
	console.log(`merge guard: ${results.length - failed.length}/${results.length} passed`);
	return failed.length ? 1 : 0;
}
