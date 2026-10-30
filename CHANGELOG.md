# Changelog

Versions are git tags (`v*`). They're permanent: a ruleset stops them being moved or deleted, so a pinned version always means the same code.

## 0.3.0 (2026-10-30)
- **`foreman auto-approve [--merge] [--dry-run]`: routine updates without a Coordinator.** Rules in the new `autoApprove` config (a branch pattern, and for each file a PR may touch, a pattern every changed line must match) approve PRs narrow enough to check mechanically, such as version bumps (`versionsOnly`: each changed line may differ only in its numbers), once their required check passed; `--merge` merges them through the gate (rebasing cleanly if behind). Anything outside a rule is left open with the reason. Meant for CI. See the README.
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
