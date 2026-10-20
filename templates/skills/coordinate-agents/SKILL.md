---
name: coordinate-agents
description: Run the multi-agent loop as Coordinator: pick the next wave of issues, launch one isolated Builder per issue with its own environment, review each PR, approve it and have its Builder merge, then apply plan updates and report to the user. Use when asked to run, continue or check on the agents.
---

<!-- Managed by foreman (npx --no-install foreman init --force replaces it). Put project-specific guidance in AGENTS.md or a playbook listed in foreman.config.json. -->

# Coordinate agents

You are the **Coordinator**. Builders each take one issue to a PR. You review and approve; the Builder merges through `foreman merge`, which refuses anything you didn't approve. The user reviews results through your summaries (and screenshots, for visual work), not by approving each merge.

Settings live in `foreman.config.json`: the base branch, the required check, `hotspots`, `riskyPaths`, `playbooks`, `planFile`, `maxBuilders`, `env`. Read it, and AGENTS.md, first.

**Start every session with `npx --no-install foreman status`.** It shows the base branch's CI, which issues have a Builder, each open PR's checks, approval and risky files, recent merges, and local environments still running. It's built from GitHub and the machine, so it's the same picture after an interruption as before.

## When to use the full loop
- **A milestone, or 3+ independent issues:** the full loop (waves, the Observer, one plan-updates PR at the end).
- **One or two small issues:** launch a single Builder the same way (claim, review, approve, merge), without waves or the Observer.
- **A one-line fix you're already looking at:** still a branch and a PR through the same review and merge, but no Builder needed.

## 1. Pick the wave
- `gh issue list --state open` (or the current milestone). Skip issues labeled "needs team input" that can't progress, and "decision" issues: those are the user's.
- Up to `maxBuilders` at a time whose files don't overlap. Serialize anything touching the same `hotspots` entry. If two issues would edit the same file, move that piece from one to the other first, and say so in an issue comment.
- Size to the machine: if environments use Docker, `npx --no-install foreman observe` warns when memory gets high.

## 2. Launch
First record it on GitHub, so the run can be picked up if this session stops:
```sh
npx --no-install foreman claim <N> --branch <prefix>/issue-<N>-<slug> --port <port>
```
(`npx --no-install foreman release <N>` if you abandon it; closing the issue makes it irrelevant.)

Then use the Agent tool, one per issue: `isolation: "worktree"`, `run_in_background: true`, a **unique port** each. The prompt must be self-contained:
- read AGENTS.md, the `work-an-issue` skill and every playbook in `foreman.config.json`; then `gh issue view N`
- `git checkout -b <branch>`, `npm install`, `npx --no-install foreman workspace --port <port>`, then start its environment as the playbooks say
- never touch other environments or containers
- its lane (the files it owns) and the hotspot rule
- the deliverable: a PR with `Closes #N`, a "Plan updates" section, green checks, and (for visual work) comparison image paths in its final report
- then **stop and wait for review**; don't merge until told

For a wave, start the **Observer**: run `npx --no-install foreman observe` with the Monitor tool (re-arm it when it expires). It prints a line when a PR opens or merges, checks finish, the base branch's CI fails, or Docker memory runs high. It only reports; you decide.

## 3. Review each PR as it arrives
1. Look at what the Builder reports (screenshots, test output). Does it really do what the issue asks?
2. `gh pr checks <N>` must be green.
3. Note the head first (`sha=$(gh pr view <N> --json headRefOid --jq .headRefOid)`), then review the PR (e.g. `/code-review medium <N>`).
4. **Check it against the issue,** not just for bugs: every checklist item and "Done when", and nothing outside its lane. Read the diff as a skeptic.
5. **Risky PRs get more** (`npx --no-install foreman status` marks them RISKY: `riskyPaths`, plus CI, Claude settings, git hooks, the config and the dependency files, which pin foreman itself). Review at a higher level and get a second opinion from a fresh Agent on a different model: "Does PR #<N> do what issue #<M> asks, and only that? What could it break?"
6. Findings: SendMessage the Builder specific fixes, then re-review after it pushes.
7. Approve: `npx --no-install foreman approve <N> "$sha"`. It stamps the reviewed commit and refuses if the PR moved on during review. Then SendMessage the Builder: "Approved at <full sha>. Follow the Merge section of work-an-issue, using that sha for --rebased-from." Anything pushed after this needs re-approval, except a pure rebase, which `foreman merge --rebased-from` verifies.
8. After a merge, tell the Builders with open PRs to rebase (`git fetch && git rebase origin/<base>`, push, re-check).

## 4. After merges
- If the repo has a `planFile`, apply the PRs' "Plan updates" to it in a small Coordinator PR, through the same review and merge.
- Close or adjust issues. File new issues the Builders surfaced.
- Report to the user in plain language: what merged, what's waiting on them (decisions, files, accounts), what's next.

## Resuming after an interruption
Usage limits or a closed session can stop agents mid-task, sometimes mid-merge, and the user may have merged things by hand meanwhile. Background Builders stop with the session. Before acting:
1. `npx --no-install foreman status`. The base branch must be green. Apply "Plan updates" from recent merges if that hadn't happened.
2. **Approved and green PRs:** it prints the exact `foreman merge` command. Rebase if needed and run it yourself.
3. **Claimed issues with no PR, or a PR still in review:** relaunch a Builder on the same branch and port. It continues from what was pushed.
4. **Environments left running:** one marked ORPHANED (its folder is gone) is safe to remove. Remove one on a port you claimed only once you're sure its Builder is gone. Leave the rest: they may be another workspace's.
5. Restart the Observer if a wave is still going.

## Guardrails
- Copy commit IDs from `gh` output; never type or recall them.
- Merges go only through `foreman merge`. A Claude Code hook blocks `gh pr merge`, merge API calls, writes to the base branch and hand-written approvals for every agent; git's pre-push check refuses pushes to the base however they're typed. If the guard blocks something legitimate, fix it in foreman rather than working around it. Your own PRs go through the same review and merge.
- Agents never merge each other's PRs or edit the plan file.
- Outward-facing actions beyond the repo (DNS, hosting, emails, posting publicly) need the user's explicit go-ahead.
- Clean up: stop the Observer when the wave is done; Builders stop their environments when done.
