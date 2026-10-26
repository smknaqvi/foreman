/**
 * Small commands around a Builder's life: claim an issue before launching it, release it when abandoned,
 * and prepare a checkout (git's pre-push check, the environment's port).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dockerUp } from './env/docker.mjs';
import { loadAdapter } from './env/index.mjs';
import { git, sh, why } from './sh.mjs';

/**
 * Record on GitHub that a Builder is on an issue, so the run survives the Coordinator's session:
 * the working label plus a comment `foreman status` reads the branch and port back from.
 */
export function claim(config, issue, { branch, port }) {
	if (!/^\d+$/.test(issue ?? '') || !branch) throw new Error('usage: foreman claim <issue> --branch <name> [--port <port>]');
	sh('gh', ['issue', 'edit', issue, '--add-label', config.labels.working]);
	const body = `${config.launchComment}: branch \`${branch}\`${port ? `, port ${port}` : ''}.`;
	sh('gh', ['issue', 'comment', issue, '--body', body]);
	console.log(`#${issue}: ${body}`);
	return 0;
}

export function release(config, issue) {
	if (!/^\d+$/.test(issue ?? '')) throw new Error('usage: foreman release <issue>');
	sh('gh', ['issue', 'edit', issue, '--remove-label', config.labels.working]);
	console.log(`#${issue}: no longer marked "${config.labels.working}".`);
	return 0;
}

/**
 * Point git at .githooks, unless the repo already uses another hooks folder (husky, lefthook...): then
 * leave it, and say how to add the check there instead.
 */
export function enablePrePush(root) {
	let current = '';
	try { current = git('-C', root, 'config', 'core.hooksPath'); } catch {} // Unset.
	if (current && !/^(?:\.\/)?\.githooks\/?$/.test(current)) {
		console.log(`git already runs hooks from ${current}; leaving that. Call .githooks/pre-push from ${current}/pre-push (pass its stdin through) so pushes to the base branch are refused.`);
		return false;
	}
	git('-C', root, 'config', 'core.hooksPath', '.githooks');
	return true;
}

/**
 * Prepare this checkout: switch on git's pre-push check and give the environment its own port
 * (--port, or Conductor's $CONDUCTOR_PORT). Safe to re-run.
 */
export async function workspace(config, { port } = {}) {
	if (existsSync(join(config.root, '.githooks', 'pre-push'))) enablePrePush(config.root);
	else console.log('No .githooks/pre-push here: run `npx --no-install foreman init` first.');
	const chosen = Number(port ?? process.env.CONDUCTOR_PORT) || 0;
	const adapter = await loadAdapter(config);
	try {
		await adapter.setup({ root: config.root, port: chosen });
	} catch (e) {
		throw new Error(`The ${adapter.name} environment's setup failed: ${why(e)}`);
	}
	return 0;
}

/**
 * Remove this checkout's environment, running or stopped (containers, volumes, network; downloads and images
 * stay), and anything set to publish `port`. For a CI job on a machine that isn't wiped between jobs: run it
 * first (a cancelled job's leftovers) and last (if: always()). Never touches other checkouts' environments.
 */
export async function removeEnv(config, { port } = {}) {
	const adapter = await loadAdapter(config);
	if (!adapter.canRemove) { console.log(`The ${adapter.name} environment adapter can't remove environments: nothing to do.`); return 0; }
	if (adapter.usesDocker && !dockerUp()) { console.log('Docker isn\'t running: nothing to remove.'); return 0; }
	let removed = [];
	try {
		removed = (await adapter.remove({ root: config.root, port: Number(port) || 0 })) ?? [];
	} catch (e) {
		console.log(`Couldn't finish removing: ${why(e)}`); // Best effort: a clean-up never fails the job it runs in.
		return 0;
	}
	const failed = removed.failed ?? [];
	if (removed.length || !failed.length) console.log(removed.length ? `Removed: ${removed.join(', ')}.` : 'Nothing to remove.');
	if (failed.length) console.log(`Couldn't remove all of: ${failed.join(', ')} (see docker ps -a); not failing for it.`);
	return 0;
}
