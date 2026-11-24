/**
 * `foreman guard --self-test`: are this repo's guards wired in and refusing what they should? Runs the
 * installed hook the way each agent tool wired into it does (that tool's payload on stdin, its answer read
 * back) and git's pre-push check the way git does, with no GitHub access, so CI can run it on every PR. (`foreman doctor` checks more, including
 * GitHub, for a person setting up a checkout.)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS, SHIM, refused, samplePayload } from './agents.mjs';
import { OVERRIDE } from './guard.mjs';
import { expectedAgents, wiredAgents } from './init.mjs';

export function selfTest(config) {
	const root = config.root;
	const base = config.baseBranch;
	const hook = join(root, SHIM);
	const results = [];
	const check = (name, fn) => {
		let ok = false, note = '';
		try { ok = fn(); } catch (e) { note = e.message.split('\n')[0]; }
		results.push([name, ok, note]);
	};

	const env = { ...process.env };
	delete env[OVERRIDE]; // A person's override must not skew the test.
	delete env.CLAUDE_PROJECT_DIR; // The hook finds its checkout from its own location, as it does for every tool.
	const wired = wiredAgents(root);
	check(`the hook is wired into an agent tool (${wired.map((id) => AGENTS[id].settings).join(', ') || 'none'})`, () => existsSync(hook) && wired.length > 0);
	// A tool the repo is set up for whose hook entry went missing (a PR dropped it) fails, even with others wired.
	const missing = expectedAgents(root).filter((id) => !wired.includes(id));
	if (missing.length) check(`every tool set up here runs it (missing: ${missing.map((id) => AGENTS[id].settings).join(', ')})`, () => false);
	for (const agent of wired) {
		const tag = wired.length > 1 || agent !== 'claude' ? `${AGENTS[agent].name}: ` : '';
		const denied = (command) => {
			if (!existsSync(hook)) throw new Error(`${SHIM} is missing: npx --no-install foreman init`);
			const args = agent === 'claude' ? [hook] : [hook, '--agent', agent];
			const stdout = execFileSync('node', args, { input: JSON.stringify(samplePayload(agent, command, root)), cwd: root, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
			return refused(agent, { stdout });
		};
		check(`${tag}blocks gh pr merge`, () => denied('gh pr merge 1'));
		check(`${tag}blocks pushing to ${base}`, () => denied(`git push origin ${base}`));
		check(`${tag}blocks a hand-written approval`, () => denied(`gh api repos/o/r/statuses/abc -f state=success -f context=${config.approvalContext}`));
		check(`${tag}lets foreman merge through`, () => !denied('npx --no-install foreman merge 1 --rebased-from 0123456789abcdef0123456789abcdef01234567'));
		check(`${tag}lets ordinary commands through (and trusts the installed foreman)`, () => !denied('git push -u origin builder/issue-1-example') && !denied('gh pr view 1') && !denied(config.verifyCommand));
	}

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
