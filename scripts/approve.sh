#!/usr/bin/env bash
# Coordinator only: record that a review approved a PR at the commit that was reviewed.
# The approval is a commit status ($FOREMAN_APPROVAL_CONTEXT) on that exact commit, so anything pushed
# afterwards is unapproved, except a pure rebase, which `foreman merge --rebased-from` accepts.
# Refuses if the PR has moved on since the review, so a later, unreviewed push is never approved.
# --memory: the Coordinator's own memory PR. Also writes the memory approval ("<context>-memory") on that
# commit, which `foreman merge` requires of any PR that changes the shared memory (memory.dir, read from the
# base branch's foreman.config.json). Refused for a PR that doesn't change it. Builders never get it.
# Usage (through the CLI, which sets the environment from foreman.config.json):
#   sha=$(gh pr view <PR> --json headRefOid --jq .headRefOid)   # before the review
#   foreman approve <PR> "$sha" [--memory]                     # after it comes back clean
set -euo pipefail
base="${FOREMAN_BASE:-main}"
context="${FOREMAN_APPROVAL_CONTEXT:-coordinator-review}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
memory=0
args=()
for a in "$@"; do
	if [ "$a" = "--memory" ]; then memory=1; else args+=("$a"); fi
done
set -- ${args[@]+"${args[@]}"}
usage="usage: foreman approve <PR number> <reviewed commit sha> [--memory]"
pr="${1:?$usage}"
reviewed="${2:?$usage}"
[[ "$reviewed" =~ ^[0-9a-f]{40}$ ]] || { echo "Give the full 40-character sha of the reviewed commit." >&2; exit 1; }
head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
if [ "$head" != "$reviewed" ]; then
	echo "PR #$pr is now at ${head:0:7}, not the reviewed ${reviewed:0:7}. Review the new commits before approving." >&2
	exit 1
fi
if [ "$memory" = 1 ]; then
	# Only for a PR that changes the memory: the approval says "this memory change was reviewed".
	git fetch -q origin "$base" "pull/$pr/head"
	memory_dir=$({ git show "origin/$base:foreman.config.json" 2>/dev/null || true; } | node "$here/memory-dir.mjs")
	[ -n "$memory_dir" ] || { echo "Shared memory is off on $base (memory.dir is empty): --memory isn't needed." >&2; exit 1; }
	touches=0
	while IFS= read -r -d '' f; do
		case "$f" in "$memory_dir"/*) touches=1 ;; esac
	done < <(git -c core.quotePath=false diff --name-only --no-renames -z "origin/$base...$head")
	[ "$touches" = 1 ] || { echo "PR #$pr doesn't change $memory_dir/: approve it without --memory." >&2; exit 1; }
fi
gh api "repos/{owner}/{repo}/statuses/$head" -f state=success -f context="$context" \
	-f description="Approved after review" >/dev/null
if [ "$memory" = 1 ]; then
	gh api "repos/{owner}/{repo}/statuses/$head" -f state=success -f context="$context-memory" \
		-f description="Memory change approved by the Coordinator" >/dev/null
	echo "Approved PR #$pr at ${head:0:7}, memory change included."
else
	echo "Approved PR #$pr at ${head:0:7}."
fi
