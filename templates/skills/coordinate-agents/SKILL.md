---
name: coordinate-agents
description: Run the multi-agent loop as Coordinator: pick the next wave of issues, launch one isolated Builder per issue with its own environment, review each PR, approve it and have its Builder merge, then apply plan and memory updates, keep the shared memory true, and report to the user. Use when asked to run, continue or check on the agents.
---

<!-- Managed by foreman (npx --no-install foreman init --force replaces it). Put project-specific guidance in AGENTS.md or a playbook listed in foreman.config.json. -->

# Coordinate agents

You are the **Coordinator**. Builders each take one issue to a PR. You review and approve; the Builder merges through `foreman merge`, which refuses anything you didn't approve. The user reviews results through your summaries (and screenshots, for visual work), not by approving each merge.

**Any coding agent can be the Coordinator or a Builder** (Claude Code, Codex, Cursor, Antigravity, Gemini CLI or another): everything here is git, `gh`, `npx --no-install foreman` and Markdown. Where a step needs something from your agent tool, it says what, then how Claude Code does it. Use your tool's equivalent:
- **Launch a Builder:** start a separate agent session in its own git worktree, in the background, that you can message later. Claude Code: the Agent tool with `isolation: "worktree"`, `run_in_background: true`. Without one, give each Builder its own worktree (`git worktree add ../<repo>-issue-<N> -b <branch> origin/<base>`) and start your agent's CLI there with the prompt below.
- **Message a Builder:** Claude Code: SendMessage. Otherwise resume its session, or comment on its PR and have it read the comments.
- **Watch in the background:** keep `npx --no-install foreman observe` running and react to each line it prints. Claude Code: the Monitor tool. Otherwise run it in a background terminal and check its output, or poll `npx --no-install foreman observe --once`.
- **Review a PR:** a careful read of its diff for bugs and for what the issue asks. Claude Code: `/code-review <level> <N>`.

Settings live in `foreman.config.json`: the base branch, the required check, `hotspots`, `riskyPaths`, `playbooks`, `planFile`, `memory`, `maxBuilders`, `env`. Read it, AGENTS.md and the shared memory's index (`memory/MEMORY.md`, or `memory.dir`) first.

**You are the only one who writes the shared memory** (`memory/`): durable facts every agent reads before working. Builders propose changes in their PRs' "Memory updates" sections; you apply them, and keep the notes true (section 5). `foreman merge` refuses a PR that changes the folder unless you approved it with `foreman approve --memory`, which only your own memory PRs get. One fact per note (`memory/<slug>.md`, with `name`, `description`, `type` and `updated` at the top), one line per note in `MEMORY.md`.

**Start every session with `npx --no-install foreman status`,** and run it again when you come back to a session after a pause. It shows the base branch's CI, which issues have a Builder, each open PR's checks, approval and risky files, recent merges, whether the last agent session stopped at a usage limit, the watchdog, and local environments still running. It's built from GitHub and the machine, so it's the same picture after an interruption as before. **If it says a Coordinator started by the watchdog is running, don't start a second one:** follow it (`npx --no-install foreman watchdog status`), or take over with `npx --no-install foreman watchdog stop` first.

## When to use the full loop
- **A milestone, or 3+ independent issues:** the full loop (waves, the Observer, one plan-updates PR at the end).
- **One or two small issues:** launch a single Builder the same way (claim, review, approve, merge), without waves or the Observer. Keep its "Plan updates" and apply several small PRs' updates together in one later Coordinator PR.
- **A one-line fix you're already looking at:** still a branch and a PR through the same review and merge, but no Builder needed.

## 1. Pick the wave
- `gh issue list --state open` (or `--milestone "<current milestone>"`). Skip issues labeled "needs team input" that can't progress, and "decision" issues: those are the user's.
- Up to `maxBuilders` at a time whose files don't overlap. Serialize anything touching the same `hotspots` entry. If two issues would edit the same file, move that piece from one to the other first, and say so in an issue comment.
- Size to the machine: if environments use Docker, `npx --no-install foreman observe` warns when memory gets high (`observe.memoryHigh` and `memoryCritical` in the config). Stop your own environment if you need the room.

## 2. Launch
First record it on GitHub, so the run can be picked up if this session stops:
```sh
npx --no-install foreman claim <N> --branch <prefix>/issue-<N>-<slug> --port <port>
```
(`npx --no-install foreman release <N>` if you abandon it; closing the issue makes it irrelevant.)

Then launch one Builder per issue (above: its own worktree, in the background), with a **unique port** each. In Conductor, take ports from your workspace's range (`$CONDUCTOR_PORT`+1 … +9); your own environment uses `$CONDUCTOR_PORT`. The prompt must be self-contained:
- read AGENTS.md, the `work-an-issue` skill and every playbook in `foreman.config.json`; then `gh issue view N`
- `git checkout -b <branch>`, `npm install`, `npx --no-install foreman workspace --port <port>`, then start its environment as the playbooks say (`npx --no-install foreman env start` with the dev-server, nextjs and rails adapters)
- never touch other environments or containers
- its lane (the files it owns) and the hotspot rule
- read `memory/MEMORY.md` and the notes that touch its work; never edit `memory/`
- the deliverable: a PR with `Closes #N`, "Plan updates" and "Memory updates" sections, green checks, and (for visual work) comparison image paths in its final report
- then **stop and wait for review**; don't merge until told

For a wave, start the **Observer**: keep `npx --no-install foreman observe` running in the background (Claude Code: the Monitor tool; re-arm it when it expires, about every 30 minutes). It prints a line when a PR opens or merges, checks finish, the base branch's CI fails, or Docker memory runs high. It only reports; you decide. Checks that show as **queued** are waiting for a runner (a self-hosted one may be asleep): that isn't a failure, so don't re-push.

## 3. Review each PR as it arrives
1. Look at what the Builder reports (screenshots, test output). Does it really do what the issue asks?
2. `gh pr checks <N>` must be green.
3. Note the head first (`sha=$(gh pr view <N> --json headRefOid --jq .headRefOid)`), then review the PR (Claude Code: `/code-review medium <N>`). For visual work, a preview deployment of the head (shown by `foreman status`) saves starting the Builder's environment.
4. **Check it against the issue,** not just for bugs: every checklist item and "Done when", and nothing outside its lane. Read the diff as a skeptic. Its "Memory updates" should hold what a future agent needs (or "none"), and nothing private.
5. **Risky PRs get more** (`npx --no-install foreman status` marks them RISKY: `riskyPaths`, plus CI, agent settings (`.claude/`, `.codex/`, `.cursor/`, `.agents/`, `.gemini/`), git hooks, the config and the dependency files, which pin foreman itself). Review at a higher level and get a second opinion from a fresh agent session, ideally on a different model: "Does PR #<N> do what issue #<M> asks, and only that? What could it break?"
6. Findings: message the Builder specific fixes, then re-review after it pushes.
7. Approve: `npx --no-install foreman approve <N> "$sha"` (add `--memory` only for your own memory PR). It stamps the reviewed commit and refuses if the PR moved on during review. Then message the Builder: "Approved at <full sha>. Follow the Merge section of work-an-issue, using that sha for --rebased-from." Anything pushed after this needs re-approval, except a pure rebase, which `foreman merge --rebased-from` verifies.
8. After a merge, tell the Builders with open PRs to rebase (`git fetch && git rebase origin/<base>`, `npm install` if `package-lock.json` changed, push, re-check).

## 4. After merges
- If the repo has a `planFile`, apply the PRs' "Plan updates" to it in a small Coordinator PR, through the same review and merge.
- **Apply the memory updates:** `npx --no-install foreman memory updates` prints the "Memory updates" sections of merged PRs that no memory PR has applied yet. On a branch of your own (`foreman/memory-<date>`), write each new fact as a note (`npx --no-install foreman memory add <slug> --description "<one line>" --type <type>` starts one and its index line), fix the notes it corrects (and set their `updated`), and delete the ones it retires (and their index lines). Put `source: "PR #N"` on notes a PR gave you. `npx --no-install foreman memory check` must pass. Open a small PR (it can be the plan-updates PR: same branch, both changes) whose description has the line **`Applies memory updates from #12, #40`**, listing every PR you handled, including any you decided not to apply: that line is how `memory updates` knows they're done. Review it like any other, then approve it with **`npx --no-install foreman approve <N> "$sha" --memory`**: `foreman merge` refuses a PR that changes `memory/` without that memory approval. Only your own memory PRs get `--memory`, never a Builder's: if a Builder's PR changes `memory/`, have it move that into its "Memory updates" section. Nothing stops an agent running `foreman approve --memory` itself (as with `foreman approve`): that rule is yours to keep, and `foreman status` marks a PR that changes the memory without the memory approval.
- Close or adjust issues. File new issues the Builders surfaced.
- Report to the user in plain language: what merged, what's waiting on them (decisions, files, accounts), what's next. Images can't be attached with `gh`: show them in your report instead.

## 5. Memory review
At the end of each wave, and at least once a week while agents are working, read the whole memory as a skeptic. Notes that are wrong are worse than none: every agent trusts them.
1. `npx --no-install foreman memory list`, then read every note.
2. `npx --no-install foreman memory check`. It fails on notes that don't parse or aren't listed once in `MEMORY.md`, and warns about links to missing notes, near-duplicate descriptions, repo paths that no longer exist, and notes not updated in 180 days.
3. Look for what a check can't see:
   - **Contradictions** between two notes: find which is true now (the code, recent PRs, the issue history) and fix or delete the other.
   - **Untrue now:** notes the code or recent merges (`gh pr list --state merged`) have overtaken.
   - **Duplicates:** merge them into one note, and fix links to the one that goes (`[[old-slug]]`).
   - **Private information:** secrets, tokens, where keys or passwords live, one person's own details. Remove it, and tell the user if a secret was ever committed (it's in git's history: it needs rotating).
4. Fix it all in the next memory PR (setting `updated` on each note you checked and kept), with `memory check` passing, approved with `--memory`. In your report, say what changed in plain words.

**A person's own agent memory stays personal.** Claude Code keeps one per user and machine (`~/.claude/projects/<project>/memory/`), in the same format. When the user wants facts from it shared, `npx --no-install foreman memory import <folder> [--only slug,slug]` copies them into `memory/` on your memory PR's branch (it skips notes already there and never changes the source). Read every imported note before committing: remove secrets, where keys live, and anything about one person that the team doesn't need. Facts a Builder learns reach the memory through its PR's "Memory updates", never through its own tool's memory.

## Resuming after an interruption
Usage limits or a closed session can stop agents mid-task, sometimes mid-merge, and the user may have merged things by hand meanwhile. Background Builders stop with the session; anything a Builder hadn't pushed is gone. If the repo runs the **watchdog** (`npx --no-install foreman watchdog install`), it notices a usage-limit stop, merges what's approved and green, and starts a Coordinator once the limit resets: you may be that Coordinator. Either way, rebuild the picture before acting:
1. `npx --no-install foreman status`. The base branch must be green. It lists PRs merged in the last 24 hours: apply their "Plan updates" if that hadn't happened. `npx --no-install foreman memory updates` lists merged PRs whose "Memory updates" no memory PR has applied yet.
2. **Approved and green PRs:** it prints the exact `foreman merge` command, with `--rebased-from <sha>` when the approval was on a commit from before a rebase. `npx --no-install foreman tick` rebases and merges all of them (clean rebases only); or rebase and run the command yourself.
3. **Claimed issues with no PR, or a PR still in review:** relaunch a Builder on the same branch and port. It continues from what was pushed. The stopped Builder's worktree may still have that branch checked out, so tell the new one to work on `git switch --detach origin/<branch>` and push with `git push origin HEAD:<branch>`; and its environment may still hold the port. Check `foreman status` first: only if the environment on that port serves the stopped Builder's old worktree (or is ORPHANED) remove it (`npx --no-install foreman env remove --port <port>`, from the new worktree; it removes whatever is on that port, database included). If it serves anything else, give the new Builder another port and re-claim.
4. **Environments left running:** one marked ORPHANED (its folder is gone) is safe to remove (`foreman tick` does it). Remove one on a port you claimed only once you're sure its Builder is gone. Leave the rest: they may be another workspace's.
5. Restart the Observer if a wave is still going.

Then continue from what actually happened.

**Started by the watchdog?** You're running unattended: nobody answers questions. Finish only what's in flight (claimed issues, their PRs, approved PRs) and claim nothing new. Run Builders in the foreground, so your session lasts until they're done (Claude Code: `run_in_background: false`; several Agent calls in one message still run at the same time). Don't end while a Builder is still working. Leave anything that needs a person with a comment saying what's needed, and end with a short summary.

## Guardrails
- Copy commit IDs from `gh` output; never type or recall them.
- Merges go only through `foreman merge`. The merge guard blocks `gh pr merge`, merge API calls, writes to the base branch and hand-written approvals, in every agent tool `foreman init` wired it into (`foreman doctor` lists them); git's pre-push check refuses pushes to the base however they're typed, from any tool. In a tool without the guard, the rule is yours to keep. If the guard blocks something legitimate, fix it in foreman rather than working around it. Your own PRs go through the same review and merge.
- Agents never merge each other's PRs or edit the plan file. Only you edit the memory folder, in your own memory PRs, and only those get `foreman approve --memory`.
- Outward-facing actions beyond the repo (DNS, hosting, emails, posting publicly) need the user's explicit go-ahead.
- Clean up: stop the Observer when the wave is done; Builders stop their environments when done.
- The watchdog (if installed) only starts a Coordinator after a usage-limit stop with work in flight. `npx --no-install foreman watchdog pause` holds it, for example while you reorganize the work by hand. When agents go quiet for 10 minutes it merges approved, green PRs, but not while your Observer is running: keep it running (re-arm it) while you hold an approved PR back on purpose, or don't approve it yet.
