# Changelog

Versions are git tags (`v*`). They're permanent: a ruleset stops them being moved or deleted, so a pinned version always means the same code.

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
