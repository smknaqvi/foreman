/**
 * Where the crew stands, read from GitHub alone (no Coordinator memory needed): the base branch's CI, the
 * issues Builders are on (the working label plus the launch comment `foreman claim` wrote), each open PR's
 * checks and approval (including one from before a rebase), and PRs merged recently. `foreman status`
 * prints it; `foreman tick` and the watchdog act on it.
 */
import { CONFIG_FILE } from './config.mjs';
import { MEMORY_APPROVAL, baseRef, memoryChanges, memoryFiles, ruleFor } from './memory-rule.mjs';
import { gh, git, sh, why } from './sh.mjs';

export async function readCrew(config, { fetchBase = false } = {}) {
	const { baseBranch: base, approvalContext: context, labels, launchComment } = config;
	let runs, issues, prs, merged, repo;
	try {
		repo = gh('repo', 'view', '--json', 'owner,name');
		runs = gh('run', 'list', '--branch', base, '--limit', '30', '--json', 'workflowName,status,conclusion,displayTitle,event');
		issues = gh('issue', 'list', '--label', labels.working, '--state', 'open', '--limit', '50', '--json', 'number,title,comments');
		const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
		merged = gh('pr', 'list', '--state', 'merged', '--search', `merged:>=${since}`, '--limit', '100', '--json', 'number,title,mergedAt');
		prs = gh('pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,headRefOid,isCrossRepository,isDraft,mergeable,mergeStateStatus,statusCheckRollup,closingIssuesReferences,files');
	} catch (e) {
		throw new Error(`Couldn't read GitHub (is gh logged in? try: gh auth status): ${why(e)}`);
	}
	// The memory rule and risky paths read the base branch locally: bring it up to date first (status, tick).
	if (fetchBase) { try { git('-C', config.root, 'fetch', '-q', 'origin', base); } catch {} }

	const statusAtHead = (pr, ctx) => (pr.statusCheckRollup || []).some((c) => c.__typename === 'StatusContext' && c.context === ctx && c.state === 'SUCCESS');
	const approvedHead = (pr) => statusAtHead(pr, context);
	// The shared memory's rule, as foreman merge applies it: a PR changing the memory also needs the
	// Coordinator's memory approval, or it isn't ready (tick would rebase and push it every round, for merge
	// to refuse).
	const memoryContext = `${context}-memory`;
	const rule = ruleFor(config);
	// gh lists at most 100 files per PR: past that, ask for them all, or a memory file could hide in the rest.
	// If that fails, the PR counts as changing the memory (and risky): fail closed.
	const UNLISTED = '(files GitHub wouldn\'t list: may include the shared memory)';
	for (const pr of prs) {
		if ((pr.files || []).length < 100) continue;
		try { pr.files = sh('gh', ['api', '--paginate', `repos/${repo.owner.login}/${repo.name}/pulls/${pr.number}/files`, '--jq', '.[].filename']).split('\n').filter(Boolean).map((path) => ({ path })); } catch { pr.filesIncomplete = true; }
	}
	const paths = (pr) => (pr.files || []).map((f) => f.path);
	// What each PR changes in the memory, as merge.sh would see it (lib/memory-rule.mjs). A PR changing a
	// foreman.config.json needs its head here, to see whether that moves or switches off the memory.
	const memoryOf = new Map();
	const prMemory = (pr) => {
		if (!memoryOf.has(pr.number)) {
			const files = paths(pr);
			let mine = memoryFiles(rule, files);
			if (pr.filesIncomplete && rule.path) mine = [...mine, UNLISTED];
			else if (rule.onBase && files.some((f) => /(^|\/)foreman\.config\.json$/i.test(f))) {
				try {
					git('-C', config.root, 'fetch', '-q', 'origin', `pull/${pr.number}/head`);
					mine = memoryChanges(config.root, baseRef(config.root, base), pr.headRefOid, files, rule);
				} catch {
					mine = [...mine, ...files.filter((f) => /(^|\/)foreman\.config\.json$/i.test(f))]; // Can't tell: count it.
				}
			}
			memoryOf.set(pr.number, mine);
		}
		return memoryOf.get(pr.number);
	};
	const changesMemory = (pr) => prMemory(pr).length > 0;
	// Risky: the configured paths, any foreman.config.json at any depth (the gate reads the base's), and what
	// it changes in the memory (once the base has its index, or this PR adds it).
	const riskyPath = (p) => p === CONFIG_FILE || p.endsWith(`/${CONFIG_FILE}`) || config.riskyPaths.some((r) => p === r || (r.endsWith('/') && p.startsWith(r)));
	const risky = (pr) => [...new Set([...paths(pr).filter(riskyPath), ...prMemory(pr)])];

	// Approvals on commits a PR had before a force-push (a rebase), for every PR not approved at its head, in
	// one query. `foreman merge --rebased-from` takes this sha.
	const approvedBefore = new Map();
	const memoryAtHead = new Map(); // PR number → the memory approval is on its head (by foreman's wording).
	let rebaseLookupFailed = '';
	// A memory approval counts only with the wording foreman approve --memory writes (merge.sh checks the
	// same), and gh's status rollup has no descriptions: read them, for PRs that change the memory, here too.
	const memoryApproved = (contexts = []) => contexts.some((c) => c.context === memoryContext && c.state === 'SUCCESS' && (c.description ?? '').startsWith(MEMORY_APPROVAL));
	const lookup = prs.filter((p) => !approvedHead(p) || changesMemory(p));
	if (lookup.length) {
		const status = 'status{contexts{context state description}}';
		const pr = (n) => `p${n}:pullRequest(number:${n}){commits(last:1){nodes{commit{oid ${status}}}} timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],last:20){nodes{...on HeadRefForcePushedEvent{beforeCommit{oid statusCheckRollup{state} ${status}}}}}}`;
		const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${lookup.map((p) => pr(p.number)).join(' ')}}}`;
		try {
			const data = gh('api', 'graphql', '-f', `query=${query}`, '-f', `owner=${repo.owner.login}`, '-f', `name=${repo.name}`).data.repository;
			for (const p of lookup) {
				const node = data[`p${p.number}`];
				memoryAtHead.set(p.number, memoryApproved(node.commits?.nodes?.[0]?.commit?.status?.contexts));
				const nodes = [...node.timelineItems.nodes].reverse();
				const hit = nodes.find((n) => n.beforeCommit?.status?.contexts.some((c) => c.context === context && c.state === 'SUCCESS'));
				if (hit) approvedBefore.set(p.number, { sha: hit.beforeCommit.oid, green: hit.beforeCommit.statusCheckRollup?.state === 'SUCCESS', memory: memoryApproved(hit.beforeCommit.status.contexts) });
			}
		} catch (e) {
			rebaseLookupFailed = why(e); // Memory approvals then count as missing: fail closed.
		}
	}

	for (const pr of prs) {
		const rollup = pr.statusCheckRollup || [];
		const checks = rollup.filter((c) => c.__typename === 'CheckRun');
		const failed = [
			...checks.filter((c) => c.status === 'COMPLETED' && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion)).map((c) => c.name),
			...rollup.filter((c) => c.__typename === 'StatusContext' && ['FAILURE', 'ERROR'].includes(c.state)).map((c) => c.context),
		];
		const running = checks.filter((c) => c.status !== 'COMPLETED').map((c) => c.name);
		const queued = checks.filter((c) => c.status === 'QUEUED').map((c) => c.name);
		const head = approvedHead(pr);
		const prior = head ? null : approvedBefore.get(pr.number);
		// Always name the approved commit: after the rebase that's usually needed first, the head is a new commit.
		const approvedSha = head ? pr.headRefOid : prior?.sha ?? '';
		// A clean rebase of an approved commit reuses that commit's checks; an approved head needs its own.
		// foreman merge re-checks all of this and refuses if the push after approval was more than a rebase.
		// On the commit foreman merge will use as the approved one, exactly as merge.sh looks: the head if it's
		// approved itself, else the commit from before the rebase (--rebased-from).
		const needsMemoryApproval = changesMemory(pr) && !(head ? memoryAtHead.get(pr.number) : prior?.memory);
		const ready = Boolean(approvedSha) && !needsMemoryApproval && !failed.length && !pr.isDraft && pr.mergeable !== 'CONFLICTING' && Boolean(prior ? prior.green : checks.length && !running.length);
		pr.foreman = {
			closes: (pr.closingIssuesReferences || []).map((i) => i.number),
			failed, running, queued, checks: checks.length,
			approvedAtHead: head, approvedBefore: prior?.sha ?? '', approvedSha, ready, needsMemoryApproval,
			merge: approvedSha ? `npx --no-install foreman merge ${pr.number} --rebased-from ${approvedSha}` : '',
			risky: risky(pr),
		};
	}

	for (const issue of issues) {
		const launch = [...issue.comments].reverse().find((c) => c.body.startsWith(launchComment));
		issue.launch = launch ?? null;
		issue.branch = launch?.body.match(/branch `([^`]+)`/)?.[1] ?? '';
		issue.port = launch?.body.match(/\bport (\d+)\b/)?.[1] ?? '';
	}

	const day = Date.now() - 24 * 3600 * 1000;
	merged = merged.filter((p) => Date.parse(p.mergedAt) > day).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
	// The newest run of each workflow, newest first.
	const latest = (list) => [...new Map([...list].reverse().map((r) => [r.workflowName, r])).values()].reverse();
	return { repo, runs: latest(runs), pushRuns: latest(runs.filter((r) => r.event === 'push')), issues, prs, merged, rebaseLookupFailed };
}

/**
 * The base branch's CI is red: some workflow's latest run for a push failed. Scheduled and hand-started runs
 * don't count, and don't hide a failed push run either.
 */
export const baseFailing = (crew) => crew.pushRuns.filter((r) => r.status === 'completed' && !['success', 'skipped', 'neutral'].includes(r.conclusion));

/**
 * Work that's under way and would stop if every agent stopped: issues a Builder claimed, and approved PRs.
 * `key` changes whenever any of it moves (a new push, a new claim, a merge).
 */
export function inFlight(crew) {
	const items = [
		...crew.issues.map((i) => `#${i.number}`),
		...crew.prs.filter((p) => p.foreman.approvedSha || p.foreman.closes.some((n) => crew.issues.some((i) => i.number === n))).map((p) => `PR #${p.number}@${p.headRefOid.slice(0, 7)}`),
	];
	return { items, key: [...new Set(items)].sort().join(' ') };
}
