/**
 * The merge guard (lib/guard.mjs): it blocks merges, writes to the base branch and self-approval that
 * bypass `foreman merge` and `foreman approve`, and lets ordinary work through. Also runs the hook end to
 * end the way Claude Code calls it (through the CLI and through the shim `foreman init` installs), and
 * git's pre-push check.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { blockedReason } from '../lib/guard.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OPTIONS = { baseBranch: 'main', approvalContext: 'coordinator-review' };
const temps = [];
const tempDir = (name) => { const d = mkdtempSync(join(tmpdir(), `foreman-${name}-`)); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

// Throwaway repos with one commit each, on the given branch.
function repoOn(branch) {
	const dir = tempDir(`guard-${branch}`);
	const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
	git('init', '-q', '-b', branch);
	writeFileSync(join(dir, 'notes.txt'), 'x\n');
	git('add', 'notes.txt');
	git('commit', '-q', '-m', 'init');
	return dir;
}
const feature = repoOn('feature');
const main = repoOn('main');

// [command, directory it runs in]
const blocked = [
	// Merging a PR.
	['gh pr merge 123 --squash'],
	['gh -R octo/app pr merge 5'],
	['gh pr merge --auto --squash 9'],
	['cd /tmp && gh pr merge 1'],
	['FOO=1 gh pr merge 1'],
	['/opt/homebrew/bin/gh pr merge 1'],
	['if gh pr checks 5; then gh pr merge 5 --squash; fi'],
	['for n in 12 13; do gh pr merge $n --squash; done'],
	['{ gh pr merge 1; }'],
	['! gh pr merge 1'],
	['timeout 60 gh pr merge 1'],
	['nohup gh pr merge 1 &'],
	['echo 1 | xargs -n 1 gh pr merge'],
	["bash -c 'gh pr merge 1'"],
	['eval "gh pr merge 1"'],
	['echo $(gh pr merge 1)'],
	['git commit -m "Block `gh pr merge 1` outside safe-merge.sh"'], // Backticks run inside double quotes.
	["cat > body.md <<EOF\nuse `gh pr merge 7` and $(gh pr merge 8)\nEOF"], // ...and in unquoted heredocs.
	["cat > body.md <<'EOF'\nsome text\nEOF\ngh pr merge 3"],
	['read x <<< hello\ngh pr merge 1'],
	['git commit -m "fix <<EOF parsing"\ngh pr merge 1'],
	['gh api -X PUT repos/octo/app/pulls/12/merge'],
	['gh api repos/o/r/pulls/12/merge --method PUT'],
	['gh api repos/o/r/pulls/12/merge -f merge_method=squash'],
	['gh api -X POST repos/o/r/merges -f base=main -f head=feature'],
	["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'"],
	// Writing to main.
	['git push origin main'],
	['git push origin HEAD:main'],
	['git push -f origin +main'],
	['git push origin feature:refs/heads/main'],
	['git push origin :main'],
	['git push --mirror origin'],
	['git push --all'],
	['git --no-pager push origin main'],
	['git -C ../other push origin main'],
	['git push', main],
	['git push origin', main],
	['git push origin HEAD', main],
	['git push -u origin HEAD', main],
	['git push --force-with-lease origin HEAD', main],
	['git push origin @', main],
	['git push origin 2>&1', main],
	[`cd ${main} && git push`, feature],
	[`git -C ${main} push`, feature],
	['gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc'],
	['gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA=='],
	["gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { commit { oid } } }'"],
	['gh api \\\n  -X PUT \\\n  repos/o/r/pulls/5/merge'], // Line continuations.
	['gh pr \\\n merge 5'],
	['gh pr -R octo/app merge 5'],
	['gh api -X PUT repos/{owner}/{repo}/pulls/5/merge'],
	["bash -lc 'gh pr merge 1'"],
	["bash <<'EOF'\ngh pr merge 1\nEOF"], // A script on a shell's stdin runs.
	["echo 'gh pr merge 1' | bash"],
	["bash <<< 'gh pr merge 1'"],
	["gh api graphql --input - <<< '{\"query\":\"mutation{mergePullRequest(input:{}){clientMutationId}}\"}'"],
	['gh api graphql -F query=@m.graphql'], // A query the guard can't see.
	['gh api graphql -f query="$(cat m.graphql)"'],
	['git push --repo origin main'],
	['git push -u origin "$(git branch --show-current)"', main],
	['git push origin $BRANCH', main],
	['git checkout main && git push', feature],
	['gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA== -f branch=main'],
	["gh pr create --title t --body \"$(cat <<'EOF'\nNotes (optional: see #5\nEOF\n)\" && gh pr merge 5"], // An unmatched ( in a heredoc body.
	["git commit -m \"$(cat <<'EOF'\nFix the :( face\nEOF\n)\" && git push origin main"],
	['gh pr merge 5 --squash --body "-h"'],
	["Q='mutation{mergePullRequest(input:{}){clientMutationId}}'; gh api graphql -f query=\"$Q\""],
	["gh api https://api.github.com/graphql -f query='mutation{mergePullRequest(input:{}){clientMutationId}}'"],
	["gh api graphql/ -f query='mutation{mergePullRequest(input:{}){clientMutationId}}'"],
	['git --git-dir .git push origin main'],
	['git --work-tree . push origin main'],
	[`GIT_DIR=${main}/.git git push`],
	['git checkout notes.txt && git push', main], // Checking out a file doesn't switch branch.
	['git push --no-verify origin feature'], // Skips .githooks/pre-push.
	['git -c core.hooksPath=/dev/null push origin feature'],
	['FOREMAN_ALLOW_BASE_PUSH=1 git push origin feature'],
	['export FOREMAN_ALLOW_BASE_PUSH=1'],
	['git config --unset core.hooksPath'], // Switching off git's pre-push check.
	['git config core.hooksPath /dev/null'],
	['rm .githooks/pre-push'],
	['chmod -x .githooks/pre-push'],
	['sudo -u me gh pr merge 1'],
	['git push --no-verif origin feature'], // Git accepts abbreviated options.
	['git push --mirr origin'],
	['git push origin HEAD:"$B"'], // A destination the guard can't read could be main.
	['git push origin HEAD:refs/heads/$(echo main)'],
	['gh api -X PATCH repos/o/r/git/refs/heads/$B -f sha=abc -f force=true'],
	['git config unset core.hooksPath'], // Git 2.46+ syntax.
	['git config set core.hooksPath /tmp/x'],
	["echo 'gh pr merge 1' |& bash"],
	["cat <<E'OF'\nx\nEOF\ngh pr merge 1"], // A partly quoted delimiter still ends at EOF.
	['(( n = 1 << 2 ))\ngh pr merge 1'], // Arithmetic, not a heredoc.
	['env -C /tmp gh pr merge 1'],
	["env -S 'gh pr merge 1'"],
	['git push --al'],
	["git push origin 'refs/heads/*:refs/heads/*'"],
	['git switch - && git push'], // Back to the previous branch, which may be main.
	['echo ${A:-$(gh pr merge 1)}'], // A substitution in a default runs.
	['git push origin HEAD:heads/main'],
	['time -p gh pr merge 1'],
	['caffeinate -i gh pr merge 1'],
	['gh api -X PUT repos/o/r/contents/x -f message=m -f content=eA== -f branch="$B"'],
	["gh api graphql -f query=\"$(cat <<'EOF'\nmutation { mergePullRequest(input:{}) { clientMutationId } }\nEOF\n)\""],
	// Approving your own PR.
	['gh api repos/o/r/statuses/abc123 -f state=success -f context=coordinator-review'],
	['gh api repos/{owner}/{repo}/statuses/abc -f state=success -f context=coordinator-review'],
	['gh api repos/o/r/statuses/abc --input status.json'],
	['gh api repos/o/r/statuses/abc -fstate=success -fcontext=coordinator-review'], // Attached short-flag values.
	['gh api repos/o/r/statuses/abc -f state=success -f context="$(echo coordinator-review)"'],
	['gh api repos/o/r/statuses/abc -f state=success -f context="$CTX"'],
];
const allowed = [
	['npx foreman merge 123 --rebased-from 0123456789abcdef0123456789abcdef01234567'],
	['npx foreman approve 123 0123456789abcdef0123456789abcdef01234567'],
	['bash node_modules/@smknaqvi/foreman/scripts/merge.sh 123'],
	['git push -u origin HEAD'],
	['git push -u origin HEAD 2>&1 | tail -2'],
	['git push --force-with-lease'],
	['git push origin builder-1/issue-124-agent-guardrails'],
	['git push origin main-menu-fix'],
	[`cd ${feature} && git push`, main],
	['gh pr view 12 --json state'],
	['gh pr checks 12 --watch'],
	['gh api repos/octo/app/pulls/12'],
	['gh api repos/o/r/pulls/5/merge'], // GET: "is it merged?"
	["gh api repos/o/r/commits/abc/statuses --jq 'map(select(.context==\"coordinator-review\"))'"],
	['grep -n "gh pr merge" node_modules/@smknaqvi/foreman/scripts/merge.sh'],
	["echo 'never run gh pr merge; use safe-merge'"],
	['gh pr create --title x --body "Never run gh pr merge; use safe-merge.sh. Push to main? No."'],
	["gh pr comment 5 --body 'Approved at abc. Run `gh pr merge`? No: safe-merge.sh'"],
	["git commit -m 'Block `gh pr merge` outside safe-merge.sh'"],
	["cat > body.md <<'EOF'\n- Never merge with plain `gh pr merge`; use $(safe-merge.sh)\ngh pr merge 5\nEOF"],
	["python3 - <<'EOF'\nprint('git push origin main')\nEOF"],
	['git log --oneline origin/main'],
	['git rebase origin/main'],
	['git fetch origin main'],
	['echo ${HOME} # gh pr merge 1'],
	['gh api repos/{owner}/{repo}/pulls/5'],
	['gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA== -f branch=feat'],
	["gh api graphql -f query='{ viewer { login } }'"],
	["gh api graphql --input - <<< '{\"query\":\"{ viewer { login } }\"}'"],
	["gh pr create --title t --body-file - <<'EOF'\nUse `gh pr merge`? No: $(safe-merge.sh). Then git push origin main? No.\nEOF"],
	['git push -u origin "$(git branch --show-current)"'],
	['git checkout -b x && git push -u origin HEAD', main],
	['npm run verify 2>&1 | tail -5'],
	['ls | xargs -I{} echo {}'],
	['gh api repos/o/r/git/refs -f ref=refs/heads/main-fix -f sha=abc'],
	["gh api graphql -f query=\"$(cat <<'EOF'\nquery { viewer { login } }\nEOF\n)\""],
	['git config core.hooksPath .githooks'],
	['git config --get core.hooksPath'],
	['cat .githooks/pre-push'],
	["cat <<EOF > x.md\nUse \\`gh pr merge\\` never, and \\$(no) either\nEOF"], // Escaped: literal text.
	['git config core.hooksPath ./.githooks'],
	['git config core.hooksPath "$PWD/.githooks"'],
	['PR=${PR:-$(gh pr view --json number --jq .number)}'],
	['git push origin "$BRANCH"'],
	['npm run verify |& tail -3'],
	["cat <<E'OF' > notes.md\nuse `gh pr merge`\nEOF"],
	["gh api graphql -f query='query($owner:String!){ repository(owner:$owner, name:\"x\"){ id } }' -f owner=octo"],
	["gh pr create --title t --body \"$(cat <<'EOF'\nNotes (optional: see #5\nUse `gh pr merge`? No.\nEOF\n)\""],
	['case $x in a) echo hi;; esac'],
	['[[ -n "$x" ]] && echo $(( 1 + 2 ))'],
	["for f in a b; do\n  # comment with gh pr merge in it\n  echo $f\ndone"],
];

test('blocks merges, pushes to main and self-approval', () => {
	const missed = blocked.filter(([c, dir = feature]) => !blockedReason(c, dir, OPTIONS)).map(([c]) => c);
	assert.deepEqual(missed, []);
});

test('lets ordinary work through', () => {
	const wrong = allowed.filter(([c, dir = feature]) => blockedReason(c, dir, OPTIONS)).map(([c]) => c);
	assert.deepEqual(wrong, []);
});

test('follows the configured base branch and approval context', () => {
	const trunk = repoOn('trunk');
	const opts = { baseBranch: 'trunk', approvalContext: 'lead-review' };
	for (const c of ['git push origin trunk', 'git push origin HEAD:refs/heads/trunk', 'gh api -X PATCH repos/o/r/git/refs/heads/trunk -f sha=abc', 'gh api repos/o/r/statuses/abc -f state=success -f context=lead-review'])
		assert.ok(blockedReason(c, feature, opts), c);
	assert.ok(blockedReason('git push', trunk, opts));
	for (const c of ['git push origin main', 'git push origin trunk-fix', 'gh api repos/o/r/statuses/abc -f state=success -f context=ci/other'])
		assert.equal(blockedReason(c, feature, opts), '', c);
	assert.equal(blockedReason('git push', main, opts), '');
});

test('reads its settings from foreman.config.json when not given any', () => {
	const repo = repoOn('feature');
	writeFileSync(join(repo, 'foreman.config.json'), JSON.stringify({ baseBranch: 'develop' }));
	assert.ok(blockedReason('git push origin develop', repo));
	assert.equal(blockedReason('git push origin main', repo), '');
});

const hookInput = (command, cwd = feature) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });
const decision = (out) => JSON.parse(out || '{}').hookSpecificOutput?.permissionDecision;

test('a broken config refuses gh and git push rather than guessing the base branch', () => {
	const repo = repoOn('feature');
	writeFileSync(join(repo, 'foreman.config.json'), '{ "baseBranch": "master", ');
	const run = (command) => execFileSync('node', [join(ROOT, 'bin/foreman.mjs'), 'guard'], { input: hookInput(command, repo), encoding: 'utf8' });
	assert.equal(decision(run('git push origin master')), 'deny');
	assert.equal(decision(run('gh pr view 1')), 'deny');
	assert.equal(run('ls -la'), '');
});

test('runs end to end as `foreman guard`', () => {
	const run = (command) => execFileSync('node', [join(ROOT, 'bin/foreman.mjs'), 'guard'], { input: hookInput(command), encoding: 'utf8' });
	assert.equal(decision(run('gh pr merge 1')), 'deny');
	assert.equal(run('git status'), '');
});

test('runs end to end through the shim `foreman init` installs, and refuses gh until foreman is installed', () => {
	const project = tempDir('project');
	mkdirSync(join(project, '.claude/hooks'), { recursive: true });
	cpSync(join(ROOT, 'templates/claude/foreman-guard.mjs'), join(project, '.claude/hooks/foreman-guard.mjs'));
	writeFileSync(join(project, 'package.json'), '{}');
	const run = (command) => execFileSync('node', [join(project, '.claude/hooks/foreman-guard.mjs')], { input: hookInput(command), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: project } });
	// Not installed yet: any gh or git push is refused, other commands run.
	assert.equal(decision(run('gh pr view 1')), 'deny');
	assert.equal(decision(run('git push -u origin HEAD')), 'deny');
	assert.equal(run('npm install'), '');
	// Installed (a symlink, as npm link or a workspace would make it): the real guard decides.
	mkdirSync(join(project, 'node_modules/@smknaqvi'), { recursive: true });
	symlinkSync(ROOT, join(project, 'node_modules/@smknaqvi/foreman'));
	assert.equal(decision(run('gh pr merge 1')), 'deny');
	assert.equal(run('gh pr view 1'), '');
});

test('git\'s pre-push check refuses pushes to the base branch only', () => {
	const hook = join(tempDir('hooks'), 'pre-push');
	writeFileSync(hook, readFileSync(join(ROOT, 'templates/githooks/pre-push'), 'utf8').replaceAll('__BASE__', 'main'));
	const { FOREMAN_ALLOW_BASE_PUSH: _, ...env } = process.env; // A person's override must not skew the test.
	const pushes = (line, extra = {}) => { try { execFileSync('bash', [hook], { input: `${line}\n`, stdio: ['pipe', 'ignore', 'ignore'], env: { ...env, ...extra } }); return true; } catch { return false; } };
	assert.equal(pushes('refs/heads/x 1 refs/heads/main 2'), false);
	assert.equal(pushes('refs/heads/x 1 refs/heads/main-fix 2'), true);
	assert.equal(pushes('refs/heads/x 1 refs/heads/main 2', { FOREMAN_ALLOW_BASE_PUSH: '1' }), true);
});
