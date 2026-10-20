/**
 * `foreman doctor`: is this checkout ready for the crew? Checks the tools, the config, that the guard and
 * git's pre-push check are switched on and work, the labels, and the required check. Exit 1 on a problem.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_FILE, findRoot, loadConfig } from './config.mjs';
import { loadAdapter } from './env/index.mjs';
import { blockedReason } from './guard.mjs';
import { git, sh, why } from './sh.mjs';

export async function doctor(cwd) {
	let problems = 0;
	const ok = (msg) => console.log(`  ok    ${msg}`);
	const warn = (msg) => console.log(`  warn  ${msg}`);
	const bad = (msg) => { problems++; console.log(`  FAIL  ${msg}`); };
	const version = (cmd, args, re) => { try { return sh(cmd, args).match(re)?.slice(1).map(Number) ?? null; } catch { return null; } };
	const atLeast = (v, min) => v && (v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]));

	console.log('Tools');
	const node = process.versions.node.split('.').map(Number);
	atLeast(node, [20, 0]) ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node}: needs 20 or later`);
	const gitV = version('git', ['--version'], /(\d+)\.(\d+)/);
	atLeast(gitV, [2, 38]) ? ok(`git ${gitV.join('.')}`) : bad(`git ${gitV?.join('.') ?? 'not found'}: needs 2.38 or later (merge-tree --write-tree)`);
	if (!version('gh', ['--version'], /(\d+)\.(\d+)/)) bad('gh (GitHub CLI) not found');
	else {
		try { sh('gh', ['auth', 'status']); ok('gh, logged in'); } catch { bad('gh is not logged in: gh auth login'); }
	}

	console.log('\nConfig');
	let config;
	if (!findRoot(cwd)) bad(`no ${CONFIG_FILE}: run npx foreman init`);
	try {
		config = loadConfig(cwd);
		ok(`${CONFIG_FILE}: base ${config.baseBranch}, required check ${config.requiredCheck || '(none: waits for every check)'}, environment ${config.env.adapter}`);
	} catch (e) {
		bad(e.message);
		return 1;
	}
	try {
		await loadAdapter(config);
		ok(`environment adapter "${config.env.adapter}" loads`);
	} catch (e) {
		bad(e.message);
	}
	for (const p of config.playbooks) existsSync(join(config.root, p)) ? ok(`playbook ${p}`) : bad(`playbook ${p} doesn't exist`);
	if (config.planFile && !existsSync(join(config.root, config.planFile))) warn(`planFile ${config.planFile} doesn't exist`);

	console.log('\nGuards');
	const root = config.root;
	let hooksPath = '';
	try { hooksPath = git('-C', root, 'config', 'core.hooksPath'); } catch {}
	// The pre-push hook git actually runs: .githooks normally, or the repo's own hooks folder (husky...).
	const prePush = resolve(root, hooksPath || join(git('-C', root, 'rev-parse', '--git-common-dir'), 'hooks'), 'pre-push');
	if (!hooksPath) bad('git\'s pre-push check is off in this checkout (core.hooksPath isn\'t set): npx foreman workspace');
	else if (!existsSync(prePush)) bad(`${hooksPath}/pre-push is missing: npx foreman init`);
	else {
		try { accessSync(prePush, constants.X_OK); } catch { bad(`${hooksPath}/pre-push is not executable: chmod +x ${hooksPath}/pre-push`); }
		const refuses = (target) => { try { execFileSync('bash', [prePush], { cwd: root, input: `refs/heads/x 1 refs/heads/${target} 2\n`, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, FOREMAN_ALLOW_BASE_PUSH: '' } }); return false; } catch { return true; } };
		refuses(config.baseBranch) && !refuses(`${config.baseBranch}-x`) ? ok(`${hooksPath}/pre-push refuses pushes to ${config.baseBranch}`) : bad(`${hooksPath}/pre-push doesn't refuse pushes to ${config.baseBranch} (made for another base branch? npx foreman init --force${hooksPath === '.githooks' ? '' : `, then call .githooks/pre-push from ${hooksPath}/pre-push`})`);
	}
	const settingsFile = join(root, '.claude/settings.json');
	const hooked = existsSync(settingsFile) && readFileSync(settingsFile, 'utf8').includes('foreman-guard');
	hooked && existsSync(join(root, '.claude/hooks/foreman-guard.mjs')) ? ok('Claude Code merge guard is wired in (.claude/settings.json)') : bad('the merge guard hook isn\'t installed: npx foreman init');
	const blocks = ['gh pr merge 1', `git push origin ${config.baseBranch}`, `gh api repos/o/r/statuses/abc -f state=success -f context=${config.approvalContext}`];
	const missed = blocks.filter((c) => !blockedReason(c, root, config));
	missed.length ? bad(`the guard lets through: ${missed.join(' | ')}`) : ok('the guard blocks merges, pushes to the base and self-approval');

	console.log('\nGitHub');
	try {
		const labels = JSON.parse(sh('gh', ['label', 'list', '--limit', '200', '--json', 'name'])).map((l) => l.name);
		for (const l of Object.values(config.labels)) labels.includes(l) ? ok(`label "${l}"`) : bad(`label "${l}" is missing: gh label create "${l}"`);
	} catch (e) {
		warn(`couldn't read labels: ${why(e)}`);
	}
	if (config.requiredCheck) {
		try {
			const sha = sh('gh', ['api', `repos/{owner}/{repo}/commits/${config.baseBranch}`, '--jq', '.sha']).trim();
			const names = sh('gh', ['api', `repos/{owner}/{repo}/commits/${sha}/check-runs`, '--jq', '.check_runs[].name']).split('\n').filter(Boolean);
			if (names.includes(config.requiredCheck)) ok(`"${config.requiredCheck}" runs on ${config.baseBranch}`);
			else warn(`no "${config.requiredCheck}" check on ${config.baseBranch}'s latest commit (seen: ${names.join(', ') || 'none'}). foreman merge will wait for it forever; fix requiredCheck or add the CI job (npx foreman init --ci).`);
		} catch (e) {
			warn(`couldn't read ${config.baseBranch}'s checks: ${why(e)}`);
		}
	}

	console.log(problems ? `\n${problems} problem${problems > 1 ? 's' : ''} to fix.` : '\nReady.');
	return problems ? 1 : 0;
}
