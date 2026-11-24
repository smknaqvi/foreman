/**
 * `foreman auto-approve [--merge] [--dry-run]`: approves, without a Coordinator, open PRs whose change is narrow
 * enough for a rule to check (`autoApprove` in the config, e.g. version pins only), once their required check
 * passed; with --merge, merges them through the gate as `foreman tick` does (rebasing cleanly if behind).
 * Made for CI, e.g. right after a dependency-update PR's checks pass. A PR that matches a rule's branch but not
 * the rest is left alone, with the reason printed. It never writes code.
 */
import { gh, git, sh, why } from './sh.mjs';
import { baseFailing } from './state.mjs';
import { rebaseAndMerge } from './tick.mjs';

/** A rule's pattern, matched against the whole text (so a line merely containing a version doesn't pass). */
export const whole = (pattern) => new RegExp(`^(?:${pattern})$`);

/**
 * Does this change fit the rule? With `versionsOnly`, each changed line must also differ from the one it replaces
 * only in its numbers. `change`: { files: [{ path, status, binary, modeChange, mode, lines: ['+…', '-…'] }] }.
 * '' if it does, otherwise why not. Pure, so it can be tested on its own.
 */
export function checkChange(rule, change) {
	if (!change.files.length) return 'it changes nothing';
	for (const f of change.files) {
		const pattern = Object.hasOwn(rule.files, f.path) ? rule.files[f.path] : undefined;
		if (pattern === undefined) return `it changes ${f.path}, which the rule doesn't cover`;
		if (f.status !== 'M') return `it ${({ A: 'adds', D: 'deletes' })[f.status] ?? `changes (${f.status})`} ${f.path} instead of only editing it`;
		if (f.modeChange) return `it changes the file mode of ${f.path} (${f.modeChange})`;
		if (f.mode && !['100644', '100755'].includes(f.mode)) return `${f.path} isn't a regular file (mode ${f.mode})`;
		if (f.binary) return `${f.path} changes as a binary file`;
		const re = whole(pattern);
		const bad = f.lines.find((l) => !re.test(l.slice(1)));
		if (bad !== undefined) return `a line in ${f.path} isn't one the rule allows: ${bad.slice(0, 120)}`;
		if (rule.versionsOnly) {
			// Each removed line must come back, in order, with only its numbers changed (no swapped names).
			const shape = (l) => l.slice(1).replace(/\d+/g, '0');
			const removed = f.lines.filter((l) => l[0] === '-');
			const added = f.lines.filter((l) => l[0] === '+');
			if (removed.length !== added.length || removed.some((l, i) => shape(l) !== shape(added[i])))
				return `${f.path} changes more than version numbers`;
		}
	}
	return '';
}

/**
 * Parse `git diff -U0 --no-renames` output into { files }. Split on the `diff --git` lines (a changed line always
 * starts with + or -, so it can't be one); in each file, everything before its first `@@` is header (status,
 * mode, binary), and only `+`/`-` lines after it are changes. Matching header text instead would drop real
 * changed lines such as `++ x` (shown as `+++ x`). A path git had to quote stays quoted, so no rule covers it.
 */
export function parseDiff(text) {
	const files = [];
	let f = null;
	for (const line of text.split('\n')) {
		if (line.startsWith('diff --git ')) {
			const names = line.slice('diff --git '.length);
			// No renames, so it reads "a/<path> b/<path>": the same path twice.
			const path = names.startsWith('"') ? names : names.slice(2, 2 + (names.length - 5) / 2);
			f = { path, status: 'M', binary: false, modeChange: '', mode: '', lines: [], inHunk: false };
			files.push(f);
		} else if (!f) continue;
		else if (f.inHunk) { if (line[0] === '+' || line[0] === '-') f.lines.push(line); }
		else if (line.startsWith('@@')) f.inHunk = true;
		else if (line.startsWith('new file mode ')) f.status = 'A';
		else if (line.startsWith('deleted file mode ')) f.status = 'D';
		else if (line.startsWith('old mode ')) f.modeChange = line.slice('old mode '.length);
		else if (line.startsWith('new mode ')) f.modeChange += ` → ${line.slice('new mode '.length)}`;
		else if (line.startsWith('index ')) f.mode ||= line.split(' ')[2] ?? '';
		else if (line.startsWith('Binary files ') || line === 'GIT binary patch') f.binary = true;
	}
	for (const x of files) delete x.inHunk;
	return { files };
}

/** What `head` changes compared with where it left `origin/<base>`, read from git in one pass. */
function readChange(root, base, head) {
	// Fixed prefixes, and no external diff or textconv: the repo's own config mustn't change what we read.
	return parseDiff(sh('git', ['-C', root, 'diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv',
		'--src-prefix=a/', '--dst-prefix=b/', `origin/${base}...${head}`], { maxBuffer: 64 * 1024 * 1024 }));
}

/** The base branch's CI is red (the latest push run of some workflow failed), as `foreman tick` checks. */
function baseRed(base) {
	const runs = gh('run', 'list', '--branch', base, '--limit', '30', '--json', 'workflowName,status,conclusion,event');
	const latest = new Map();
	for (const r of runs.filter((r) => r.event === 'push')) if (!latest.has(r.workflowName)) latest.set(r.workflowName, r);
	return baseFailing({ pushRuns: [...latest.values()] });
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
	const root = config.root;
	const prs = gh('pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,headRefOid,isCrossRepository,isDraft,baseRefName');
	let failed = 0;
	let matched = 0;
	let red; // The base branch's failing workflows, read once, the first time a merge is due.
	let deepened = false;
	for (const pr of prs) {
		const candidates = rules.filter((r) => whole(r.branch).test(pr.headRefName));
		if (!candidates.length) continue;
		matched++;
		const head = pr.headRefOid;
		const skip = (why) => say(`PR #${pr.number} (${pr.headRefName}): not auto-approved: ${why}.`);
		if (pr.isCrossRepository) { skip('it comes from a fork'); continue; }
		if (pr.isDraft) { skip('it is a draft'); continue; }
		if (pr.baseRefName !== base) { skip(`it targets ${pr.baseRefName}, not ${base}`); continue; }
		// The same ref name rebaseAndMerge uses, so --merge needn't fetch the PR again.
		const ref = `refs/foreman/pr-${pr.number}`;
		try {
			// A shallow clone (CI's default checkout) has no merge base to diff against.
			if (!deepened && git('-C', root, 'rev-parse', '--is-shallow-repository') === 'true') git('-C', root, 'fetch', '-q', '--unshallow', 'origin');
			deepened = true;
			git('-C', root, 'fetch', '-q', 'origin', base, `+refs/pull/${pr.number}/head:${ref}`);
			if (git('-C', root, 'rev-parse', ref) !== head) { skip('it moved while being read; next time'); continue; }
			// Every rule whose branch matches gets a try: the first that accepts the change approves it.
			const change = readChange(root, base, head);
			const verdicts = candidates.map((r) => ({ rule: r, problem: checkChange(r, change) }));
			const rule = verdicts.find((v) => !v.problem)?.rule;
			if (!rule) { skip(verdicts.length === 1 ? verdicts[0].problem : verdicts.map((v) => `${v.rule.name}: ${v.problem}`).join('; ')); continue; }
			if (!checksPassed(config, repo, pr.number, head)) { skip(`${config.requiredCheck || 'its checks'} hasn't passed on ${head.slice(0, 7)} yet`); continue; }
			if (merge) red ??= baseRed(base);
			const holdMerge = merge && red.length ? ` Not merging it: ${base}'s CI is failing (${red.map((r) => r.workflowName).join(', ')}); left until it's green.` : '';
			if (dryRun) { say(`would approve PR #${pr.number} at ${head.slice(0, 7)} (${rule.name})${merge && !holdMerge ? ' and merge it' : ''}.${holdMerge}`); continue; }
			sh('gh', ['api', `repos/${repo}/statuses/${head}`, '-f', 'state=success', '-f', `context=${config.approvalContext}`, '-f', `description=Auto-approved: ${rule.name}`.slice(0, 140)]);
			say(`Approved PR #${pr.number} at ${head.slice(0, 7)}: ${rule.name}.${holdMerge}`);
			// A head rebased and pushed from CI (GITHUB_TOKEN) starts no checks, so never rely on them.
			if (merge && !holdMerge && !(await rebaseAndMerge(config, { ...pr, foreman: { approvedSha: head } }, say, { fetched: true, noNewChecks: true }))) failed++;
		} catch (e) {
			say(`PR #${pr.number}: ${why(e)}`);
			failed++;
		} finally {
			try { git('-C', root, 'update-ref', '-d', ref); } catch {}
		}
	}
	if (!matched) say('No open PR matches an autoApprove rule.');
	return failed ? 1 : 0;
}
