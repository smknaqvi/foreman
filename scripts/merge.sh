#!/usr/bin/env bash
# Merges a PR only when it is safe to:
#   1. the Coordinator approved this exact code (foreman approve): an approval status on the head commit,
#      or on the pre-rebase commit given with --rebased-from, provided replaying that approved change onto
#      the current base yields exactly the head's files (so only a clean rebase passes),
#   2. it is up to date with the base branch,
#   3. the required check passed, and nothing else failed. Not waited for when every changed file matches
#      $FOREMAN_DOCS_ONLY, or when it is a clean rebase of an approved commit whose own required check
#      passed (the base branch's CI still runs after the merge) and none of $FOREMAN_STALE_PATHS changed
#      on the base since that commit.
# Merges are serialized with a lock shared by all worktrees of the repo, so two agents can't both merge
# against the same base.
# Usage (through the CLI, which sets the environment from foreman.config.json):
#   foreman merge <PR number> [--rebased-from <approved commit sha>]
set -euo pipefail
base="${FOREMAN_BASE:-main}"
context="${FOREMAN_APPROVAL_CONTEXT:-coordinator-review}"
required="${FOREMAN_REQUIRED_CHECK-verify}"
stale_paths="${FOREMAN_STALE_PATHS:-}" # One per line.
docs_only="${FOREMAN_DOCS_ONLY-\.md$}" # Empty: no PR counts as docs-only.
lock_wait="${FOREMAN_LOCK_WAIT:-60}" # Tries, 5 seconds apart.

pr="${1:?usage: foreman merge <PR number> [--rebased-from <sha>]}"
rebased_from=""
[ "${2:-}" = "--rebased-from" ] && rebased_from="${3:?--rebased-from needs the approved commit sha}"
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

approved() { # Does commit $1 carry the Coordinator's approval?
	[ "$(gh api "repos/$repo/commits/$1/statuses" --jq "map(select(.context==\"$context\")) | first | .state // \"\"")" = "success" ]
}
replayed_tree() { # Tree of "current base + the change approved at commit $1" (3-way merge, no worktree; git 2.38+).
	local out
	out=$(git merge-tree --write-tree "origin/$base" "$1" 2>/dev/null) || return 1 # Conflicts: not a clean rebase.
	printf '%s\n' "${out%%$'\n'*}"
}

# One merge at a time across every worktree on this machine.
lock="$(git rev-parse --git-common-dir)/foreman-merge.lock"
got_lock=0
for _ in $(seq 1 "$lock_wait"); do
	if mkdir "$lock" 2>/dev/null; then got_lock=1; break; fi
	sleep 5
done
[ "$got_lock" = 1 ] || { echo "Another merge is holding $lock. Retry later (remove it only if no merge is running)." >&2; exit 1; }
trap 'rmdir "$lock"' EXIT # Only after we own the lock, so we never remove someone else's.

read -r state draft head mergeable < <(gh pr view "$pr" --json state,isDraft,headRefOid,mergeable --jq '"\(.state) \(.isDraft) \(.headRefOid) \(.mergeable)"')
[ "$state" = "OPEN" ] || { echo "PR #$pr is $state; nothing to merge." >&2; exit 1; }
[ "$draft" = "false" ] || { echo "PR #$pr is a draft." >&2; exit 1; }
[ "$mergeable" != "CONFLICTING" ] || { echo "PR #$pr has conflicts: rebase on origin/$base first." >&2; exit 1; }
git fetch -q origin "$base" "pull/$pr/head"

# 1. Up to date with the base (checked under the lock, so no other merge can slip in). Checked first: a PR
#    that is merely behind needs another rebase, not a re-review.
if ! git merge-base --is-ancestor "origin/$base" "$head"; then
	echo "PR #$pr is behind $base: rebase on origin/$base, push --force-with-lease, then rerun with --rebased-from <the sha you were approved at>." >&2
	exit 1
fi

checked="$head" # The commit whose checks must be green.
# 2. Approval of this exact change (the base is now an ancestor of head, so replaying onto it is exact).
if ! approved "$head"; then
	if [ -n "$rebased_from" ] && approved "$rebased_from"; then
		git fetch -q origin "$rebased_from" 2>/dev/null || true
		# Exact check: replaying the approved change onto the current base must give exactly the PR's files.
		expected=$(replayed_tree "$rebased_from") || expected=""
		actual=$(git rev-parse "$head^{tree}")
		if [ -n "$expected" ] && [ "$expected" = "$actual" ]; then
			gh api "repos/$repo/statuses/$head" -f state=success -f context="$context" \
				-f description="Approval carried over: clean rebase of ${rebased_from:0:7}" >/dev/null
			echo "Approval carried over from ${rebased_from:0:7} (clean rebase: identical to the approved change on current $base)."
			checked="$rebased_from" # Its checks already ran on the approved change.
			if [ -z "$required" ]; then
				checked="$head" # No named check to reuse: wait for the head's own.
			elif [ -n "$stale_paths" ]; then
				# Unless something the checks compare against changed on the base since then: the approved
				# commit was never checked against it, so wait for the head's own checks (the approval stands).
				set -f; IFS=$'\n'; stale=($stale_paths); unset IFS; set +f
				if ! git diff --quiet "$(git merge-base "$rebased_from" "origin/$base")" "origin/$base" -- "${stale[@]}"; then
					echo "$base changed ${stale[*]} since ${rebased_from:0:7} was checked: waiting for ${head:0:7}'s own checks."
					checked="$head"
				fi
			fi
		else
			echo "PR #$pr changed since approval at ${rebased_from:0:7} (not just a rebase). Ask the Coordinator to re-review." >&2
			exit 1
		fi
	else
		echo "PR #$pr isn't approved at ${head:0:7}. The Coordinator approves with foreman approve after reviewing." >&2
		exit 1
	fi
fi

# 3. The required check must have run and passed (not just "nothing failed yet"): on this exact commit, or
#    on the approved commit for a clean rebase. On the head itself, every other check must be green too
#    (gh exits non-zero if any check failed or is pending). Docs-only PRs skip this.
files=$(git diff --name-only --no-renames "origin/$base" "$head") # Captured first: grep -q exiting early must not count.
if [ -n "$files" ] && [ -n "$docs_only" ]; then
	rc=0; grep -qvE -- "$docs_only" <<<"$files" || rc=$? # 1: every file matched. 2: a bad pattern, which must not count.
	if [ "$rc" = 1 ]; then
		echo "PR #$pr only changes documentation: not waiting for checks."
		checked=""
	elif [ "$rc" = 2 ]; then
		echo "docsOnly ($docs_only) isn't a pattern grep -E understands: treating PR #$pr as code." >&2
	fi
fi
if [ -n "$checked" ] && [ -n "$required" ]; then
	# -X GET -f encodes the name into the query, so names with spaces or & work ("Build & Test").
	result=$(gh api -X GET "repos/$repo/commits/$checked/check-runs" -f check_name="$required" --jq '[.check_runs[] | select(.status=="completed")] | first | .conclusion // ""')
	if [ "$result" != "success" ]; then
		echo "PR #$pr: the $required check hasn't passed on ${checked:0:7} yet (${result:-not finished}). Wait with: gh pr checks $pr --watch" >&2
		exit 1
	fi
fi
if [ "$checked" != "$head" ]; then # Not waiting on the head's checks, but never ignore one that already failed.
	failed=$(gh api --paginate "repos/$repo/commits/$head/check-runs" --jq '.check_runs[] | select(.status=="completed" and (.conclusion | IN("success","skipped","neutral") | not)) | .name' | paste -sd ',' - | sed 's/,/, /g')
	[ -z "$failed" ] || { echo "PR #$pr: checks failed on ${head:0:7}: $failed" >&2; exit 1; }
fi
if [ "$checked" = "$head" ] && ! gh pr checks "$pr" >/dev/null 2>&1; then
	echo "PR #$pr: checks aren't all passing on ${head:0:7}:" >&2
	gh pr checks "$pr" >&2 || true
	exit 1
fi

# No --delete-branch: it tries to switch branches in this worktree. Let the repo delete merged branches.
gh pr merge "$pr" --squash --match-head-commit "$head"
[ "$(gh pr view "$pr" --json state --jq .state)" = "MERGED" ] || { echo "Merge of PR #$pr didn't complete." >&2; exit 1; }
echo "Merged PR #$pr."
