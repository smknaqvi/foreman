#!/usr/bin/env bash
# Coordinator only: record that a review approved a PR at the commit that was reviewed.
# The approval is a commit status ($FOREMAN_APPROVAL_CONTEXT) on that exact commit, so anything pushed
# afterwards is unapproved, except a pure rebase, which `foreman merge --rebased-from` accepts.
# Refuses if the PR has moved on since the review, so a later, unreviewed push is never approved.
# Usage (through the CLI, which sets the environment from foreman.config.json):
#   sha=$(gh pr view <PR> --json headRefOid --jq .headRefOid)   # before the review
#   foreman approve <PR> "$sha"                                # after it comes back clean
set -euo pipefail
context="${FOREMAN_APPROVAL_CONTEXT:-coordinator-review}"
pr="${1:?usage: foreman approve <PR number> <reviewed commit sha>}"
reviewed="${2:?usage: foreman approve <PR number> <reviewed commit sha>}"
[[ "$reviewed" =~ ^[0-9a-f]{40}$ ]] || { echo "Give the full 40-character sha of the reviewed commit." >&2; exit 1; }
head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
if [ "$head" != "$reviewed" ]; then
	echo "PR #$pr is now at ${head:0:7}, not the reviewed ${reviewed:0:7}. Review the new commits before approving." >&2
	exit 1
fi
gh api "repos/{owner}/{repo}/statuses/$head" -f state=success -f context="$context" \
	-f description="Approved after review" >/dev/null
echo "Approved PR #$pr at ${head:0:7}."
