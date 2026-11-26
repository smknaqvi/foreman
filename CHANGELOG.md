# Changelog

Versions are git tags (`v*`). They're permanent: a ruleset stops them being moved or deleted, so a pinned version always means the same code.

## 0.6.0 (2026-11-26)
- **The merge guard refuses an agent giving a person's OK to merge** (`ownerOk`). Where a workflow merges a high-risk PR once a person comments "OK to merge" or removes "needs owner review", agents working through that person's GitHub login would look exactly like them. The guard now refuses an agent posting a comment or review that says just the phrase (`gh pr|issue comment`, `gh pr review`, `--body-file`, `gh api` comments and reviews with `-f body=`, `body=@file` or `--input`, GraphQL `addComment` and friends), and removing the label (`gh pr|issue edit --remove-label`, `gh label delete|edit`, `gh api` DELETE of the label, of every label, or a PUT that replaces the labels without it, GraphQL `removeLabelsFromLabelable`, `clearLabelsFromLabelable`, `deleteLabel`, `updateLabel`). Talking about the OK ("ready for your OK to merge") and adding the label are fine; a label the guard can't read is refused, a body it can't read isn't. Setting: `ownerOk: { phrase, label }` (defaults `OK to merge`, `needs owner review`; empty switches a part off). `guard --self-test` checks both.

## 0.5.0 (2026-11-25)
- **`guard --self-test` and `doctor` judge git's pre-push check by its exit status** (#32): a hook that let everything through but exited without reading its input could pass as refusing, now and then.
- **`foreman stats [--since <date|Nd>] [--until <date>] [--json] [--pr <N>]`**: how the crew is doing, counted from GitHub's history (no AI, read-only), for the PRs merged into the base in a window (the last 30 days by default). Per PR: review rounds (fresh approvals; approvals carried over a clean rebase are counted apart), pushes after it opened, time from claim to opened to first approval to merged, runs of the required check with failures and flakes (failed, then passed on a re-run of the same check suite), whether its merge turned the base red (its check failed on the merge commit and passed on the nearest earlier base commit whose check finished) or landed on a base that was already red, reverts, labels for people, and whether it merged with an approval on its last commit. Then a summary (medians, flake rate, merges that turned the base red, open PRs older than 7 days, claimed issues with no PR for over 2 days) and "worth a look" lines. `--json` gives all of it; `--pr` one PR's timeline. Compare windows before and after a playbook change to see whether it helped. See the README's "Stats".
- **`foreman dashboard`** shows the same summary in a "Last 30 days" panel, recounted hourly in the background.

## 0.4.0 (2026-11-25)
- **Antigravity.** `foreman init --agents antigravity` wires the merge guard into its `.agents/hooks.json` (its `run_command` tool; Antigravity's CLI, IDE and app) and links every playbook into `.agents/skills/`, where it looks for skills. The guard answers it `allow` for fine commands (its hooks must answer; that leaves the call to its own approval rules) and `deny` with the reason otherwise.
- **Shared memory: durable facts every agent reads, in the repo.** Gotchas, decisions and their reasons, where things live, what the team prefers: one fact per note in `memory/<slug>.md`, indexed in `memory/MEMORY.md`, in Claude Code's memory format (its nested `metadata:`, to any depth, and a plain `type` are both read), so every tool on every machine starts from the same facts. Setting: `memory.dir` (`memory`, relative to the config; empty switches it off).
  - **Only the Coordinator writes it, kept by review** like the plan file. Once it's set up, the folder is always a risky path, so `foreman status` marks any PR touching it and the Coordinator turns away a Builder's. Builders put what future agents should know in their PR's `## Memory updates` section instead. `foreman merge` doesn't check who changed it, but once the memory is set up on the base it runs `foreman memory check` on any PR that changes the folder (memory PRs are Markdown-only, so they skip CI) and refuses broken notes; the folder comes from the base's config, so a PR can't switch the check off.
  - **`foreman memory updates [--since <date|sha>]`** prints the "Memory updates" sections of merged PRs that no memory PR has applied yet. A memory PR records what it handled with a line "Memory PR: applies memory updates from #12, #40" (whatever it changed, so declining them all works too), and a note's `source: "PR #12"` on the base counts too. It looks back, by commit history, to when the index was added, and warns when GitHub's list was cut short.
  - **`foreman memory check`** fails on notes that don't parse, lack a name, one-line description or valid type, or aren't listed once in the index, and warns about broken `[[links]]`, near-duplicate descriptions, repo paths that no longer exist and notes not updated in 180 days. `foreman doctor` runs it; `foreman status` shows the number of notes and any errors.
  - **`foreman memory list`**, **`memory add <slug> --description … [--type …]`**, and **`memory import <folder> [--only a,b]`**, which copies a Claude Code memory folder in (skipping slugs already there, never changing the source) and reminds you to remove anything private before committing.
  - `foreman init` writes `memory/MEMORY.md` (never replaced by `--force`). It adopts an existing `memory/` folder only if it's empty or holds nothing but notes.
  - Playbooks: Builders read the memory before starting, never edit it, and add a "Memory updates" section to every PR. The Coordinator applies them in its own memory PRs, turns away Builder PRs that touch the folder, and runs a **memory review** at the end of each wave (and at least weekly): contradictions, notes the code has overtaken, duplicates, private information.
- **Upgrading:** run `npx --no-install foreman init --force` to refresh the playbooks and create `memory/MEMORY.md`, and add "Read memory/MEMORY.md before starting" to AGENTS.md. If your repo already has a `memory/` folder for something else, set `memory.dir` to another folder (or `""`) first. To bring in facts from a Claude Code memory: `npx --no-install foreman memory import ~/.claude/projects/<project>/memory`, then review every note.

## 0.3.0 (2026-11-24)
- **Any coding agent, not only Claude Code.**
  - **The merge guard works in Codex, Cursor and Gemini CLI too.** `foreman init --agents claude,codex,cursor,gemini` wires it into each tool's project hooks (`.codex/hooks.json`, `.cursor/hooks.json`, `.gemini/settings.json`); without `--agents`, the tools the repo is already set up for (or Claude Code). `.codex/`, `.cursor/` and `.gemini/` are always risky paths. The same shim answers each tool in its own format, and finds its checkout from its own location. `foreman guard --agent <tool>` reads that tool's payload; **`foreman guard --command "<cmd>"`** checks one command for any other tool's hooks (exit 2 when refused). `doctor` lists the wired tools; `guard --self-test` tests each one and fails when a tool the repo is set up for lost its hook. The guard checks the folder the shell tool itself runs in (Gemini CLI's `dir_path`, Codex's `workdir`).
  - **The playbooks are tool-neutral.** Each step says what it needs (a background agent in its own worktree, a message to it, a background `foreman observe`, a review), then how Claude Code does it.
  - **The watchdog runs any agent CLI** (`watchdog.command`). Its activity check now also counts git activity in every worktree but its own (HEAD moving, changed tracked files), which any tool leaves; `status` and the dashboard still show Claude Code sessions only. Only Claude Code's transcripts show usage-limit stops, so with another tool the watchdog acts after `staleMinutes`, and says so when that's 0. A Coordinator whose output isn't Claude Code's stream-json ends by its exit code.
- **More environment adapters.**
  - `nextjs`, `rails` and `dev-server` (any command): a dev server per checkout on its own port. `foreman workspace --port` records the port, the new **`foreman env start`** runs the server in the background with `PORT` (and `vars`, e.g. a per-checkout `DATABASE_URL`) set and waits until it listens, and `foreman env remove` stops it. Running servers are found with `lsof` on the recorded ports, so ones started by hand count too.
  - `neon`: a Neon database branch per checkout, its connection string written to an env file. `foreman tick` deletes branches whose checkout is gone. Needs `NEON_API_KEY`.
- **Combining adapters.** `env.adapter` may be a list (`["nextjs", "neon"]`), each with its own options under its name. Adapters' `list` and `remove` now also get `root`; an adapter may implement `start`.
- **Preview deployments.** `status`, `observe` and the dashboard show each PR head's live preview (Vercel, Netlify, Cloudflare Pages, Render: anything using GitHub's Deployments API).
- **`foreman notify`**: Slack, Discord, ntfy (your phone), a webhook, a command or macOS. On by default once a target is added: issues and PRs labeled for people (with their latest comment), a failed base branch, usage-limit stops, Coordinators the watchdog starts and finishes, and a Coordinator it won't restart. Off by default: watchdog merges, failed PR checks, previews. Targets are per machine, kept outside the repo. `observe` and every watchdog round send them, once per event.
- **`foreman dashboard`**: the crew in a browser, live, read-only, on 127.0.0.1.
- Playbooks: Builders start and stop dev servers with `foreman env start` / `env remove`; the Coordinator can review visual work on a PR's preview.
- **Upgrading:** run `npx --no-install foreman init --force` to refresh the playbooks.

## 0.2.2 (2026-10-26)
- **The watchdog leaves merges to a Coordinator that's watching.** While a `foreman observe` in any worktree of the repo has finished a round in the last 5 minutes (or 3 of its intervals), the watchdog neither merges approved PRs nor starts a Coordinator: that Coordinator is only waiting on checks, and may be holding an approved PR back on purpose. Before, a Coordinator whose transcript was quiet for 10 minutes (waiting on a slow runner) had its plan-update PR merged ahead of the PRs it described. A usage-limit stop still wins. `foreman status` shows the Observer's last round.

## 0.2.1 (2026-10-26)
- `foreman env remove` is best effort, like a CI clean-up step should be: a container removed meanwhile, or a volume or network still in use, is reported and skipped instead of failing the job.
- Resuming a Builder: free its old port only if `foreman status` shows that environment serving the stopped Builder's worktree (or ORPHANED); otherwise use another port. `env remove --port` removes whatever is on the port.

## 0.2.0 (2026-10-26)
- **`foreman watchdog`: keeps the crew going after a usage limit, without AI.** A launchd job (macOS; a cron line elsewhere) runs a round every few minutes. When work is in flight and the newest agent session in the repo stopped at a usage limit (read from Claude Code's transcripts), it runs `foreman tick` and, once the limit resets, starts a Coordinator in the background (`claude -p`) in its own worktree to finish the work in flight. Retries after another limit stop; doesn't restart a Coordinator that ended normally until the work changes; at most `maxSessionsPerDay`. `install`, `uninstall`, `status`, `pause`, `unpause`, `stop`, `run [--dry-run]`. Settings: `watchdog` in the config.
- **`foreman tick [--dry-run]`**: rebases approved, green PRs onto the base (clean rebases only) and merges them through `foreman merge`; removes orphaned environments. Stops merging while the base branch's CI is red.
- **`foreman env remove [--port <p>]`**: removes this checkout's environment, running or stopped (containers, volumes, network; downloads and images stay), and anything on that port. Adapters can implement `remove`; wp-env and docker-compose do.
- **`foreman init --ci --self-hosted <labels>`**: a verify workflow for a self-hosted runner, with `.github/foreman/keep-awake.sh` (keeps a Mac awake for the job only).
- **`foreman guard --self-test`**: checks the hook and the pre-push check without GitHub, for CI.
- `foreman status` also shows self-hosted runners, queued checks as waiting for a runner, whether the last agent session stopped at a usage limit (and when it resets), and the watchdog.
- Playbooks: `npm install` after a rebase that changes `package-lock.json`; what `merge` does after a clean rebase (`staleCheckPaths`, docs-only PRs); queued checks aren't failures; images go in the report, not `gh`; batching small PRs' plan updates; Conductor port ranges; resuming after an interruption covers `tick`, the watchdog, reusing a branch another worktree has checked out, and freeing a stopped Builder's port.
- README: running the checks on your own machine; PRs opened by a workflow; checks that depend on the current branch.
- **Upgrading:** run `npx --no-install foreman init --force` to refresh the playbooks (yours are never replaced). `npx --no-install foreman watchdog install` if you want the watchdog.

## 0.1.2 (2026-10-20)
- **The Claude Code hook refuses `gh` and `git push` whenever it can't trust the guard.** That covers three cases:
  - the installed foreman isn't the one `package-lock.json` pins (for example after a rebase brought a version bump: run `npm install`),
  - the guard fails to load,
  - foreman isn't installed at all.

  Before, a load failure let every command through. A linked install (`npm link`, `file:`, workspaces) counts as matching.
- The hook no longer exits before its answer is fully written.
- The guard exports `decide(raw)`, which the hook calls with the payload it read.
- Playbooks, messages and `status` output use `npx --no-install foreman`. A different npm package is also called `foreman`, and plain `npx` could download it.
- **Upgrading:** run `npx --no-install foreman init --force` to refresh `.claude/hooks/foreman-guard.mjs`.

## 0.1.1 (2026-10-20)
- `foreman status | head` (or any reader that stops early) exits quietly instead of crashing with EPIPE.
- foreman's own repo merges its PRs through `foreman approve` and `foreman merge` (`foreman.config.json`).

## 0.1.0 (2026-10-19)
- First release, extracted from a working multi-agent setup:
  - commands: `approve`, `merge`, `status`, `observe`, `claim` / `release`, `workspace`, `init`, `doctor` and the Claude Code `guard`
  - `foreman.config.json`
  - environment adapters: none, wp-env, docker-compose, or your own
