---
name: work-an-issue
description: Take a GitHub issue from start to pull request while other agents work in parallel: read the issue, scope the change, branch, build, verify, collect plan updates, open a PR that closes the issue, and merge it through foreman once the Coordinator approves. Use when asked to "work on #N", "pick up the next issue", or to finish a task as a PR.
---

<!-- Managed by foreman (npx foreman init --force replaces it). Put project-specific guidance in AGENTS.md or a playbook listed in foreman.config.json. -->

# Work an issue

## Start
```sh
gh issue view <N> --comments
git fetch origin && git rebase origin/<base>     # the base branch in foreman.config.json
```
- Read the issue's checklist and "Done when", AGENTS.md, and every playbook listed in `foreman.config.json`.
- Blocked on people (files, decisions, accounts)? Do what you can, leave clear placeholders, and comment on the issue with exactly what's needed, in plain language. Don't invent content.
- Check the open PRs (`gh pr list`) for work touching the same files.

## Build
- Keep to the issue's scope and your lane. Edits to a `hotspots` file stay small and are called out in the PR. Unrelated problems become new issues (`gh issue create`).
- Commit in small, meaningful steps with imperative messages.

## Before the PR
- Run the repo's `verifyCommand` (in `foreman.config.json`) and whatever the playbooks add.
- Don't edit the plan file (`planFile`): parallel agents would conflict. Collect changes for the PR's "Plan updates" section.
- `git fetch origin && git rebase origin/<base>`, then verify again.

## PR
```sh
git push -u origin HEAD
gh pr create --base <base> --title "<what changed, plainly>" --body-file <file>
```
PR body:
- What changed, in plain language.
- `Closes #<N>`.
- How it was verified, with results.
- What's left, and anything needing people.
- Edits to shared hotspots.
- **Plan updates**: done items, new decisions and findings, written so the Coordinator can paste them in.

Watch the checks (`gh pr checks --watch`) and fix any failure. Then report back and **wait for the Coordinator's review**.

## Merge (only after the Coordinator says "approved")
The Coordinator approves the PR's **current commit** (`foreman approve`). That approval covers only that exact code. Fix any findings first: push, wait for checks, report back, and get re-approved. Once approved:
```sh
approved=<sha from the Coordinator's "Approved at <sha>" message>   # not HEAD: it changes when you rebase
git fetch origin && git rebase origin/<base>      # needed if other PRs merged meanwhile
git push --force-with-lease                       # no need to wait for checks on a clean rebase
npx foreman merge <PR> --rebased-from "$approved"  # same command on every retry
```
`foreman merge` merges only if the change is identical to what was approved (a pure rebase), the PR is up to date, and the required check passed. If the rebase needed conflict fixes, the change differs: report back for re-review. If it refuses for another reason, do what it says and retry. Never merge any other way, and never merge someone else's PR (a hook blocks `gh pr merge` and pushes to the base anyway; if it stops you, you're on the wrong path). Afterwards stop your environment and report the merge.
