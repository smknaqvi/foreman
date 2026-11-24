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
	# Only for a PR that changes the memory: the approval says "this memory change was reviewed". The same
	# rule foreman merge applies (lib/memory-rule.mjs).
	git fetch -q origin "$base" "pull/$pr/head"
	memory_files=$(node "$here/memory-dir.mjs" files "origin/$base" "$head" | tr '\0' '\n') || { echo "Couldn't check whether PR #$pr changes the shared memory." >&2; exit 1; }
	[ -n "$memory_files" ] || { echo "PR #$pr doesn't change the shared memory (or it isn't set up on $base): approve it without --memory." >&2; exit 1; }
	# The memory approval first: if the next call fails, the PR has no approval at all rather than half of one
	# (a memory PR with only the main approval would be refused at merge, and look done).
	gh api "repos/{owner}/{repo}/statuses/$head" -f state=success -f context="$context-memory" \
		-f description="Memory approved by foreman approve" >/dev/null # foreman merge checks this wording.
fi
gh api "repos/{owner}/{repo}/statuses/$head" -f state=success -f context="$context" \
	-f description="Approved after review" >/dev/null
if [ "$memory" = 1 ]; then
	echo "Approved PR #$pr at ${head:0:7}, memory change included."
else
	echo "Approved PR #$pr at ${head:0:7}."
fi
