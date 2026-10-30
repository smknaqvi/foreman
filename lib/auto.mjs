/**
 * `foreman auto-approve [--merge] [--dry-run]`: approves, without a Coordinator, open PRs whose change is narrow
 * enough for a rule to check (`autoApprove` in the config, e.g. version pins only), once their required check
 * passed; with --merge, merges them through the gate as `foreman tick` does (rebasing cleanly if behind).
 * Made for CI, e.g. right after a dependency-update PR's checks pass. A PR that matches a rule's branch but not
 * the rest is left alone, with the reason printed. It never writes code.
 */
import { gh, git, sh, why } from './sh.mjs';
import { rebaseAndMerge } from './tick.mjs';

/**
 * Does this change fit the rule? `change`: { files: [{ path, status, binary, lines: ['+…', '-…'] }] }.
 * '' if it does, otherwise why not. Pure, so it can be tested on its own.
 */
export function checkChange(rule, change) {
	if (!change.files.length) return 'it changes nothing';
	for (const f of change.files) {
		const pattern = Object.hasOwn(rule.files, f.path) ? rule.files[f.path] : undefined;
		if (pattern === undefined) return `it changes ${f.path}, which the rule doesn't cover`;
		if (f.status !== 'M') return `it ${({ A: 'adds', D: 'deletes' })[f.status] ?? `changes (${f.status})`} ${f.path} instead of only editing it`;
		if (f.binary) return `${f.path} changes as a binary file`;
		const re = new RegExp(pattern);
		const bad = f.lines.find((l) => !re.test(l.slice(1)));
		if (bad !== undefined) return `a line in ${f.path} isn't one the rule allows: ${bad.slice(0, 120)}`;
	}
	return '';
}

/** What `head` changes compared with where it left `origin/<base>`, read from git. */
function readChange(root, base, head) {
	const range = `origin/${base}...${head}`;
	const binary = new Set(git('-C', root, 'diff', '--numstat', '--no-renames', range).split('\n').filter((l) => l.startsWith('-\t-\t')).map((l) => l.slice(4)));
	const files = git('-C', root, 'diff', '--name-status', '--no-renames', range).split('\n').filter(Boolean).map((l) => {
		const [status, path] = l.split('\t');
		return { path, status: status[0], binary: binary.has(path), lines: [] };
	});
	for (const f of files) {
		if (f.status !== 'M' || f.binary) continue;
		f.lines = sh('git', ['-C', root, 'diff', '-U0', '--no-renames', '--no-color', range, '--', f.path]).split('\n')
			.filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
	}
	return { files };
}

/** Did the required check pass on this commit? (With no required check: every check on the PR.) */
function checksPassed(config, repo, pr, head) {
	if (!config.requiredCheck) {
		try { sh('gh', ['pr', 'checks', String(pr)]); return true; } catch { return false; }
	}
	const runs = gh('api', '-X', 'GET', `repos/${repo}/commits/${head}/check-runs`, '-f', `check_name=${config.requiredCheck}`).check_runs ?? [];
	return runs.find((r) => r.status === 'completed')?.conclusion === 'success';
}

export async function autoApprove(config, { merge = false, dryRun = false, log = console.log } = {}) {
	const say = (msg) => log(`${dryRun ? '(dry run) ' : ''}${msg}`);
	const rules = config.autoApprove;
	if (!rules.length) { say('No autoApprove rules in the config: nothing to do.'); return 0; }
	const repo = gh('repo', 'view', '--json', 'nameWithOwner').nameWithOwner;
	const base = config.baseBranch;
	const prs = gh('pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,headRefOid,isCrossRepository,isDraft,baseRefName');
	let failed = 0;
	let matched = 0;
	for (const pr of prs) {
		const rule = rules.find((r) => new RegExp(r.branch).test(pr.headRefName));
		if (!rule) continue;
		matched++;
		const head = pr.headRefOid;
		const skip = (why) => say(`PR #${pr.number} (${pr.headRefName}): not auto-approved: ${why}.`);
		if (pr.isCrossRepository) { skip('it comes from a fork'); continue; }
		if (pr.isDraft) { skip('it is a draft'); continue; }
		if (pr.baseRefName !== base) { skip(`it targets ${pr.baseRefName}, not ${base}`); continue; }
		try {
			git('-C', config.root, 'fetch', '-q', 'origin', base, `+refs/pull/${pr.number}/head:refs/foreman/auto-${pr.number}`);
			if (git('-C', config.root, 'rev-parse', `refs/foreman/auto-${pr.number}`) !== head) { skip('it moved while being read; next time'); continue; }
			const problem = checkChange(rule, readChange(config.root, base, head));
			if (problem) { skip(problem); continue; }
			if (!checksPassed(config, repo, pr.number, head)) { skip(`${config.requiredCheck || 'its checks'} hasn't passed on ${head.slice(0, 7)} yet`); continue; }
			if (dryRun) { say(`would approve PR #${pr.number} at ${head.slice(0, 7)} (${rule.name})${merge ? ' and merge it' : ''}`); continue; }
			sh('gh', ['api', `repos/${repo}/statuses/${head}`, '-f', 'state=success', '-f', `context=${config.approvalContext}`, '-f', `description=Auto-approved: ${rule.name}`.slice(0, 140)]);
			say(`Approved PR #${pr.number} at ${head.slice(0, 7)}: ${rule.name}.`);
			if (merge && !(await rebaseAndMerge(config, { ...pr, foreman: { approvedSha: head } }, say))) failed++;
		} catch (e) {
			say(`PR #${pr.number}: ${why(e)}`);
			failed++;
		} finally {
			try { git('-C', config.root, 'update-ref', '-d', `refs/foreman/auto-${pr.number}`); } catch {}
		}
	}
	if (!matched) say('No open PR matches an autoApprove rule.');
	return failed ? 1 : 0;
}
