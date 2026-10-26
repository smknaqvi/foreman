/**
 * `foreman tick`: the resume steps that need no judgement, so they can run while no agent can (a usage
 * limit, a closed session). The watchdog runs it before starting a Coordinator; a person can run it by hand.
 *   - Merges approved PRs whose checks passed: rebases each onto the base in a temporary worktree (a clean
 *     rebase only), pushes, and runs `foreman merge --rebased-from <approved sha>`, which re-checks it all.
 *     A rebase with conflicts, a PR from a fork, or a red base branch is left for an agent.
 *   - Removes local environments whose checkout folder is gone (ORPHANED in `foreman status`).
 * It never reviews, approves or writes code.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { scriptEnv } from './config.mjs';
import { loadAdapter } from './env/index.mjs';
import { baseFailing, readCrew } from './state.mjs';
import { gh, git, why } from './sh.mjs';

const MERGE_SCRIPT = fileURLToPath(new URL('../scripts/merge.sh', import.meta.url));

export async function tick(config, { dryRun = false, log = console.log } = {}) {
	const crew = await readCrew(config);
	const base = config.baseBranch;
	const say = (msg) => log(`${dryRun ? '(dry run) ' : ''}${msg}`);
	const result = { merged: [], skipped: [], removed: [] };

	const ready = crew.prs.filter((p) => p.foreman.ready);
	const red = baseFailing(crew);
	if (ready.length && red.length) {
		say(`${base}'s CI is failing (${red.map((r) => r.workflowName).join(', ')}): not merging anything until an agent looks.`);
		result.skipped.push(...ready.map((p) => p.number));
	} else {
		for (const pr of ready) {
			if (pr.isCrossRepository) { say(`PR #${pr.number} comes from a fork: left for its Builder.`); result.skipped.push(pr.number); continue; }
			if (dryRun) { say(`would rebase PR #${pr.number} onto ${base} and run: ${pr.foreman.merge}`); continue; }
			const ok = rebaseAndMerge(config, pr, say);
			(ok ? result.merged : result.skipped).push(pr.number);
			if (!ok) continue;
			await sleep(2000); // Let GitHub see the new base before the next PR is rebased onto it.
		}
	}
	if (!ready.length) say('No approved PR is ready to merge.');

	const adapter = await loadAdapter(config);
	if (adapter.name !== 'none') {
		let envs = [];
		try { envs = await adapter.list(); } catch (e) { say(`Couldn't list environments: ${why(e)}`); }
		for (const env of envs.filter((e) => e.folder && !existsSync(e.folder))) {
			if (!adapter.canRemove) { say(`${env.name} is ORPHANED (its folder ${env.folder} is gone); this adapter can't remove it.`); continue; }
			if (dryRun) { say(`would remove ${env.name} (its folder ${env.folder} is gone)`); continue; }
			try {
				await adapter.remove({ env });
				say(`Removed ${env.name}: its folder ${env.folder} is gone.`);
				result.removed.push(env.name);
			} catch (e) {
				say(`Couldn't remove ${env.name}: ${why(e)}`);
			}
		}
	}
	return result;
}

/** Rebase one approved PR onto the base and merge it through the gate. True if it merged. */
export function rebaseAndMerge(config, pr, say) {
	const base = config.baseBranch;
	const root = config.root;
	const approved = pr.foreman.approvedSha;
	const dir = mkdtempSync(join(tmpdir(), `foreman-tick-${pr.number}-`));
	rmSync(dir, { recursive: true }); // git worktree add wants to create it.
	try {
		git('-C', root, 'fetch', '-q', 'origin', base, `+refs/pull/${pr.number}/head:refs/foreman/pr-${pr.number}`);
		git('-C', root, 'worktree', 'add', '-q', '--detach', dir, pr.headRefOid);
		let head = pr.headRefOid;
		try {
			git('-C', dir, 'merge-base', '--is-ancestor', `origin/${base}`, 'HEAD');
		} catch {
			try {
				git('-C', dir, 'rebase', '-q', `origin/${base}`);
			} catch {
				try { git('-C', dir, 'rebase', '--abort'); } catch {}
				say(`PR #${pr.number} doesn't rebase cleanly onto ${base}: left for its Builder (or the Coordinator).`);
				return false;
			}
			head = git('-C', dir, 'rev-parse', 'HEAD');
			// Only if the branch is still where it was: a Builder that came back and pushed wins.
			git('-C', dir, 'push', '-q', `--force-with-lease=refs/heads/${pr.headRefName}:${pr.headRefOid}`, 'origin', `HEAD:refs/heads/${pr.headRefName}`);
			say(`Rebased PR #${pr.number} onto ${base} (${pr.headRefOid.slice(0, 7)} → ${head.slice(0, 7)}).`);
			waitForHead(pr.number, head);
		}
		const r = spawnSync('bash', [MERGE_SCRIPT, String(pr.number), '--rebased-from', approved], {
			cwd: dir, encoding: 'utf8', env: { ...process.env, ...scriptEnv(config) },
		});
		for (const line of `${r.stdout}${r.stderr}`.trim().split('\n').filter(Boolean)) say(`  ${line}`);
		return r.status === 0;
	} catch (e) {
		say(`PR #${pr.number}: ${why(e)}`);
		return false;
	} finally {
		try { git('-C', root, 'worktree', 'remove', '--force', dir); } catch {}
		try { git('-C', root, 'update-ref', '-d', `refs/foreman/pr-${pr.number}`); } catch {}
	}
}

/** GitHub takes a moment to see a push. Up to a minute. */
function waitForHead(pr, sha) {
	for (let i = 0; i < 30; i++) {
		try { if (gh('pr', 'view', String(pr), '--json', 'headRefOid').headRefOid === sha) return; } catch {}
		spawnSync('sleep', ['2']);
	}
}
