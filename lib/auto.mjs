/**
 * `foreman auto-approve [--merge] [--dry-run]`: approves, without a Coordinator, open PRs whose change is narrow
 * enough for a rule to check (`autoApprove` in the config, e.g. version pins only), opened and committed only by
 * the accounts the rule trusts, once every check on their head passed; with --merge, merges them through the gate
 * as `foreman tick` does (rebasing cleanly if behind). Made for CI, e.g. right after a dependency-update PR's
 * checks pass. A PR that matches a rule's branch but not the rest is left alone, with the reason printed. It never
 * writes code. --dry-run reads everything from GitHub's API and changes nothing, locally or on GitHub.
 */
import { appendFileSync } from 'node:fs';
import { whole } from './config.mjs';
import { gh, git, sh, why } from './sh.mjs';
import { approvalsBeforeRebase, baseFailing, baseRuns, baseWorkflows, readCommitGreen, readRuns, readWorkflows } from './state.mjs';
import { rebaseAndMerge, settle } from './tick.mjs';

/** Who may open, and commit to, a PR a rule approves, unless the rule lists `authors`: GitHub Actions' bot. */
export const DEFAULT_AUTHORS = ['github-actions[bot]'];

/**
 * A version: digits, optionally dotted (6.18.4.1), standing on their own: not glued to letters or underscores
 * (php8.3, php7-compat stay literal text), and not the middle of another number. It may follow a dot or dash
 * (calendar.6.18.4.1.zip, wordpress-7.1.5.zip) or a lone v (v1.2). The version itself is the first group; the
 * lookahead and backreference keep a run from being cut short to make it fit (22.04abc isn't 22.0).
 */
const VERSION = /(?:(?<![A-Za-z_\d.])v|(?<![A-Za-z_\d])(?<!\d\.))(?=(\d+(?:\.\d+)*))\1(?![A-Za-z_])/g;
const versions = (line) => [...line.slice(1).matchAll(VERSION)].map((m) => m[1]);
const shape = (line) => line.slice(1).replace(VERSION, (m, v) => `${m.slice(0, m.length - v.length)}0`);

/** -1, 0 or 1 as version a is lower than, equal to or higher than b, part by part (a missing part counts as 0). */
export function compareVersions(a, b) {
	const x = a.split('.'), y = b.split('.');
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = BigInt(x[i] ?? 0) - BigInt(y[i] ?? 0);
		if (d) return d > 0n ? 1 : -1;
	}
	return 0;
}

/** One way to write an account: gh shows GitHub Actions' bot as app/github-actions, the REST API as github-actions[bot]. */
const account = (login) => (login ?? '').replace(/^app\/(.+)$/, '$1[bot]');

/**
 * Did only accounts the rule trusts open the PR and make its commits (author and committer of each)? `commits`:
 * the PR's commits from the REST API. '' if so, otherwise why not.
 */
export function checkAuthors(rule, pr, commits = []) {
	const trusted = new Set((rule.authors ?? DEFAULT_AUTHORS).map(account));
	const list = [...trusted].join(' or ');
	const opener = account(pr.author?.login);
	if (!trusted.has(opener)) return `it was opened by ${opener || 'an unknown account'}, not ${list}`;
	for (const c of commits) {
		for (const role of ['author', 'committer']) {
			const who = account(c[role]?.login);
			if (!trusted.has(who)) return `commit ${c.sha.slice(0, 7)}'s ${role} is ${who || `${c.commit?.[role]?.email || 'someone'} (no GitHub account)`}, not ${list}`;
		}
	}
	return '';
}

/**
 * Does this change fit the rule? With `versionsOnly`, each changed line must also differ from the one it replaces
 * only in its versions, each of them higher. `change`: { files: [{ path, status, binary, modeChange, mode, lines: ['+…', '-…'] }] }.
 * '' if it does, otherwise why not. Pure, so it can be tested on its own.
 */
export function checkChange(rule, change) {
	if (!change.files.length) return 'it changes nothing';
	for (const f of change.files) {
		const pattern = Object.hasOwn(rule.files, f.path) ? rule.files[f.path] : undefined;
		if (pattern === undefined) return `it changes ${f.path}, which the rule doesn't cover`;
		if (f.mode === '160000' || (f.modeChange ?? '').includes('160000')) return `${f.path} is a submodule (a gitlink), which is never auto-approved`;
		if (f.status !== 'M') return `it ${({ A: 'adds', D: 'deletes' })[f.status] ?? `changes (${f.status})`} ${f.path} instead of only editing it`;
		if (f.modeChange) return `it changes the file mode of ${f.path} (${f.modeChange})`;
		if (f.mode && !['100644', '100755'].includes(f.mode)) return `${f.path} isn't a regular file (mode ${f.mode})`;
		if (f.binary) return `${f.path} changes as a binary file`;
		const re = whole(pattern);
		const bad = f.lines.find((l) => !re.test(l.slice(1)));
		if (bad !== undefined) return `a line in ${f.path} isn't one the rule allows: ${bad.slice(0, 120)}`;
		if (rule.versionsOnly) {
			// Each removed line must come back, in order, with only its versions changed (no swapped names), and
			// each version that changed must go up.
			const removed = f.lines.filter((l) => l[0] === '-');
			const added = f.lines.filter((l) => l[0] === '+');
			if (removed.length !== added.length || removed.some((l, i) => shape(l) !== shape(added[i])))
				return `${f.path} changes more than version numbers`;
			for (const [i, l] of removed.entries()) {
				const was = versions(l), now = versions(added[i]);
				const down = was.findIndex((v, j) => v !== now[j] && compareVersions(now[j], v) <= 0);
				if (down >= 0) return `${f.path} goes from ${was[down]} to ${now[down]}, which isn't an upgrade (a rollback is left for a person)`;
			}
		}
	}
	return '';
}

/** A changed line in a hunk (context lines start with a space, notes with a backslash). */
const isChange = (line) => line[0] === '+' || line[0] === '-';

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
		else if (f.inHunk) { if (isChange(line)) f.lines.push(line); }
		else if (line.startsWith('@@')) f.inHunk = true;
		else if (line.startsWith('new file mode ')) { f.status = 'A'; f.mode = line.slice('new file mode '.length); }
		else if (line.startsWith('deleted file mode ')) { f.status = 'D'; f.mode = line.slice('deleted file mode '.length); }
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
	// Fixed prefixes, no external diff or textconv, and submodules always shown (as one line each): the repo's
	// own config mustn't change what we read.
	return parseDiff(sh('git', ['-C', root, 'diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv',
		'--submodule=short', '--ignore-submodules=none', '--src-prefix=a/', '--dst-prefix=b/', `origin/${base}...${head}`], { maxBuffer: 64 * 1024 * 1024 }));
}

/**
 * The same, from GitHub's compare API, for --dry-run (which fetches nothing). Its patches have context lines,
 * which only lines after a file's first `@@` that start with + or - are not. It doesn't show every mode change,
 * and a file without a patch counts as binary.
 */
function readChangeFromGitHub(repo, base, head) {
	const c = gh('api', `repos/${repo}/compare/${base}...${head}`);
	const files = (c.files ?? []).map((f) => {
		const status = ({ modified: 'M', changed: 'M', added: 'A', removed: 'D', renamed: 'R', copied: 'C' })[f.status] ?? f.status;
		const at = (f.patch ?? '').split('\n');
		const hunk = at.findIndex((l) => l.startsWith('@@'));
		return {
			path: f.filename, status, mode: '',
			modeChange: f.status === 'changed' ? 'as GitHub reports it' : '',
			binary: status === 'M' && f.status !== 'changed' && f.patch === undefined,
			lines: hunk < 0 ? [] : at.slice(hunk).filter(isChange),
		};
	});
	return { files, tooMany: files.length >= 300 };
}

/**
 * Start the base workflows (the ones that make requiredCheck) on a branch, by hand (workflow_dispatch): a push
 * made with CI's token starts none. The names started, or why not.
 */
function startChecks(config, holding, branch) {
	if (holding.all) return { started: [], why: `no workflow is named like ${config.requiredCheck || 'requiredCheck'} (set baseWorkflows)` };
	const names = holding.names;
	try {
		for (const n of names) sh('gh', ['workflow', 'run', n, '--ref', branch]);
		return { started: names, why: '' };
	} catch (e) {
		return { started: [], why: `couldn't start ${names.join(', ')}: ${why(e)}` };
	}
}

export async function autoApprove(config, { merge = false, dryRun = false, log = console.log } = {}) {
	const say = (msg) => log(`${dryRun ? '(dry run) ' : ''}${msg}`);
	const rules = config.autoApprove;
	if (!rules.length) { say('No autoApprove rules in the config: nothing to do.'); return 0; }
	const repo = gh('repo', 'view', '--json', 'nameWithOwner').nameWithOwner;
	const [owner, name] = repo.split('/');
	const base = config.baseBranch;
	const root = config.root;
	const prs = gh('pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,headRefOid,isCrossRepository,isDraft,baseRefName,author');
	let failed = 0;
	let matched = 0;
	const merged = [];
	let holding; // Which workflows hold merges back (baseWorkflows), read once, when first needed.
	const holdingWorkflows = () => {
		if (!holding) { holding = baseWorkflows(config, readWorkflows()); say(`Merges wait on ${base}'s ${holding.why}.`); }
		return holding;
	};
	let red; // Those workflows' failed runs on the base, read once.
	let deepened = false;
	// After a CI rebase whose merge failed, the new head has no checks: say what's needed, every run until done.
	const stuck = (n, s) => {
		if (!s.started.length) say(`Couldn't start the checks on PR #${n}'s new head: ${s.why}.`);
		say(`Rebased PR #${n} but couldn't merge it: its new head has no checks; ${s.started.length ? `started ${s.started.join(', ')} on it (the next run merges it once that passes)` : `re-run ${config.requiredCheck || 'its checks'} on it`} or run foreman tick.`);
		failed++;
	};

	// First what costs nothing (the PR list has it all), then each head's checks, then one query for approvals on
	// heads a rebase replaced.
	const todo = [];
	for (const pr of prs) {
		const candidates = rules.filter((r) => whole(r.branch).test(pr.headRefName));
		if (!candidates.length) continue;
		matched++;
		const skip = (why) => say(`PR #${pr.number} (${pr.headRefName}): not auto-approved: ${why}.`);
		if (pr.isCrossRepository) { skip('it comes from a fork'); continue; }
		if (pr.isDraft) { skip('it is a draft'); continue; }
		if (pr.baseRefName !== base) { skip(`it targets ${pr.baseRefName}, not ${base}`); continue; }
		const trusting = candidates.filter((r) => !checkAuthors(r, pr));
		if (!trusting.length) { skip(candidates.length === 1 ? checkAuthors(candidates[0], pr) : candidates.map((r) => `${r.name}: ${checkAuthors(r, pr)}`).join('; ')); continue; }
		try {
			todo.push({ pr, rules: trusting, skip, checks: readCommitGreen(config, repo, pr.headRefOid) });
		} catch (e) {
			say(`PR #${pr.number}: ${why(e)}`);
			failed++;
		}
	}
	let before = new Map();
	const bare = todo.filter((t) => t.checks.none).map((t) => t.pr.number);
	try { before = approvalsBeforeRebase(config, { owner: { login: owner }, name }, bare); } catch (e) { say(`Couldn't read earlier approvals: ${why(e)}`); }

	let mergedSince = false;
	for (const { pr, rules: candidates, skip, checks } of todo) {
		const head = pr.headRefOid;
		const at = head.slice(0, 7);
		if (checks.none && before.get(pr.number)?.description.startsWith('Auto-approved')) {
			stuck(pr.number, dryRun ? { started: [], why: 'a dry run starts nothing' } : startChecks(config, holdingWorkflows(), pr.headRefName));
			continue;
		}
		if (mergedSince) { await settle(); mergedSince = false; } // As tick does: let GitHub see the new base first.
		// The same ref name rebaseAndMerge uses, so --merge needn't fetch the PR again.
		const ref = `refs/foreman/pr-${pr.number}`;
		let fetched = false;
		try {
			const commits = gh('api', '-X', 'GET', `repos/${repo}/pulls/${pr.number}/commits`, '-f', 'per_page=100');
			if (commits.length >= 100) { skip('it has too many commits to check'); continue; }
			if (commits.at(-1)?.sha !== head) { skip('it moved while being read; next time'); continue; }
			let change;
			if (dryRun) {
				change = readChangeFromGitHub(repo, base, head);
				if (change.tooMany) { skip('it changes too many files to read from the API'); continue; }
			} else {
				// A shallow clone (CI's default checkout) has no merge base to diff against.
				if (!deepened && git('-C', root, 'rev-parse', '--is-shallow-repository') === 'true') git('-C', root, 'fetch', '-q', '--unshallow', 'origin');
				deepened = true;
				git('-C', root, 'fetch', '-q', 'origin', base, `+refs/pull/${pr.number}/head:${ref}`);
				fetched = true;
				if (git('-C', root, 'rev-parse', ref) !== head) { skip('it moved while being read; next time'); continue; }
				change = readChange(root, base, head);
			}
			// Every rule whose branch matches gets a try: the first that accepts the PR approves it.
			const verdicts = candidates.map((r) => ({ rule: r, problem: checkAuthors(r, pr, commits) || checkChange(r, change) }));
			const rule = verdicts.find((v) => !v.problem)?.rule;
			if (!rule) { skip(verdicts.length === 1 ? verdicts[0].problem : verdicts.map((v) => `${v.rule.name}: ${v.problem}`).join('; ')); continue; }
			if (checks.problem) { skip(checks.problem); continue; }
			if (merge) red ??= baseFailing(baseRuns(config, readRuns(base), holdingWorkflows()));
			const hold = merge && red.length
				? ` Not merging it yet: ${base}'s CI is failing (${red.map((r) => r.workflowName).join(', ')}). The next run (when a PR's check finishes, or on the schedule) or \`foreman tick\` merges it once ${base} is green.`
				: '';
			if (dryRun) {
				const what = checks.approved ? `find PR #${pr.number} already approved` : `approve PR #${pr.number}`;
				say(`would ${what} at ${at} (${rule.name})${merge && !hold ? ' and merge it' : ''}.${hold}`);
				continue;
			}
			if (checks.approved) say(`PR #${pr.number} is already approved at ${at}.${hold}`);
			else {
				sh('gh', ['api', `repos/${repo}/statuses/${head}`, '-f', 'state=success', '-f', `context=${config.approvalContext}`, '-f', `description=Auto-approved: ${rule.name}`.slice(0, 140)]);
				say(`Approved PR #${pr.number} at ${at}: ${rule.name}.${hold}`);
			}
			if (!merge || hold) continue;
			// A head rebased and pushed from CI (GITHUB_TOKEN) starts no checks, so never rely on them.
			const result = await rebaseAndMerge(config, { ...pr, foreman: { approvedSha: head } }, say, { fetched: true, noNewChecks: true });
			if (result.merged) { merged.push(pr.number); mergedSince = true; }
			else if (result.rebased) stuck(pr.number, startChecks(config, holdingWorkflows(), pr.headRefName));
			else failed++;
		} catch (e) {
			say(`PR #${pr.number}: ${why(e)}`);
			failed++;
		} finally {
			if (fetched) try { git('-C', root, 'update-ref', '-d', ref); } catch {}
		}
	}
	if (!matched) say('No open PR matches an autoApprove rule.');
	// For the workflow's next step: a merge made with CI's token starts no push runs on the base (README).
	if (process.env.GITHUB_OUTPUT && !dryRun) appendFileSync(process.env.GITHUB_OUTPUT, `merged=${merged.join(' ')}\n`);
	return failed ? 1 : 0;
}
