#!/usr/bin/env node
/**
 * foreman: a thin command line over the crew's tools. Each command loads foreman.config.json (found from
 * the working directory) and hands over to lib/ (Node) or scripts/ (the merge gate, in bash).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, scriptEnv } from '../lib/config.mjs';

const HELP = `foreman: run a crew of coding agents on one GitHub repo.

Coordinator
  status                                  where everything stands (CI, Builders, PRs, approvals, environments)
  claim <issue> --branch <b> [--port <p>] record that a Builder is on an issue
  release <issue>                         un-mark an abandoned issue
  approve <PR> <reviewed sha>             approve exactly the commit you reviewed
  observe [--once]                        print a line whenever something needs attention (run under Monitor)
  tick [--dry-run]                        what needs no judgement: merge approved, green PRs (clean rebases
                                          only) and remove orphaned environments

When every agent stops (a usage limit)
  watchdog install|uninstall              run a round every few minutes (launchd on macOS; prints a cron line
                                          elsewhere): after a usage-limit stop it runs tick, then starts a
                                          Coordinator once the limit resets
  watchdog status                         what it did and would do now
  watchdog pause|unpause|stop             hold it; stop the Coordinator it started
  watchdog run [--dry-run]                one round (what launchd runs)

Builders
  workspace [--port <p>]                  prepare this checkout (pre-push check, its own environment port)
  env remove [--port <p>]                 remove this checkout's environment (running or stopped) and anything
                                          on that port, e.g. before and after a CI job
  merge <PR> [--rebased-from <sha>]       merge an approved PR: refuses unless it's exactly what was approved,
                                          up to date and green

Setup
  init [--force] [--ci [--self-hosted <labels>]] [--conductor]
                                          set a repo up (config, hooks, guard, playbooks, CI)
  doctor                                  check this checkout is ready
  guard                                   the Claude Code hook itself (reads the hook payload on stdin)
  guard --self-test                       the hook and pre-push check refuse what they should (no GitHub
                                          needed: for CI)
`;

// Output piped into something that stops reading early (`foreman status | head`): just stop.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

const [command, ...rest] = process.argv.slice(2);
const script = (name) => fileURLToPath(new URL(`../scripts/${name}.sh`, import.meta.url));
const runScript = (name, args) => {
	const r = spawnSync('bash', [script(name), ...args], { stdio: 'inherit', env: { ...process.env, ...scriptEnv(loadConfig()) } });
	return r.status ?? 1;
};
const flags = (options) => parseArgs({ args: rest, options, allowPositionals: true });

async function main() {
	switch (command) {
		case 'approve':
			return runScript('approve', rest);
		case 'merge':
			return runScript('merge', rest);
		case 'status':
			return (await import('../lib/status.mjs')).status(loadConfig());
		case 'observe': {
			const { values } = flags({ once: { type: 'boolean' } });
			return (await import('../lib/observe.mjs')).observe(loadConfig(), values);
		}
		case 'tick': {
			const { values } = flags({ 'dry-run': { type: 'boolean' } });
			await (await import('../lib/tick.mjs')).tick(loadConfig(), { dryRun: values['dry-run'] });
			return 0;
		}
		case 'watchdog': {
			const { values, positionals } = flags({ 'dry-run': { type: 'boolean' }, launch: { type: 'boolean' } });
			const wd = await import('../lib/watchdog.mjs');
			const config = loadConfig();
			switch (positionals[0]) {
				case 'run': return wd.run(config, { dryRun: values['dry-run'] });
				case 'act': return wd.act(config, { launch: values.launch }); // Internal: the acting half of `run`.
				case 'session': return wd.session(config, positionals[1]); // Internal: a Coordinator started by `run`.
				case 'install': return wd.install(config);
				case 'uninstall': return wd.uninstall(config);
				case 'status': case undefined: return wd.status(config);
				case 'pause': return wd.pause(config, true);
				case 'unpause': return wd.pause(config, false);
				case 'stop': return wd.stop(config);
				default: throw new Error(`unknown watchdog command "${positionals[0]}" (install, uninstall, status, pause, unpause, stop, run)`);
			}
		}
		case 'env': {
			const { values, positionals } = flags({ port: { type: 'string' } });
			if (positionals[0] !== 'remove') throw new Error('usage: foreman env remove [--port <port>]');
			return (await import('../lib/crew.mjs')).removeEnv(loadConfig(), values);
		}
		case 'claim': {
			const { values, positionals } = flags({ branch: { type: 'string' }, port: { type: 'string' } });
			return (await import('../lib/crew.mjs')).claim(loadConfig(), positionals[0], values);
		}
		case 'release':
			return (await import('../lib/crew.mjs')).release(loadConfig(), rest[0]);
		case 'workspace': {
			const { values } = flags({ port: { type: 'string' } });
			return (await import('../lib/crew.mjs')).workspace(loadConfig(), values);
		}
		case 'init': {
			const { values } = flags({ force: { type: 'boolean' }, ci: { type: 'boolean' }, 'self-hosted': { type: 'string' }, conductor: { type: 'boolean' } });
			return (await import('../lib/init.mjs')).init(process.cwd(), values);
		}
		case 'doctor':
			return (await import('../lib/doctor.mjs')).doctor(process.cwd());
		case 'guard':
			if (rest.includes('--self-test')) return (await import('../lib/selftest.mjs')).selfTest(loadConfig());
			(await import('../lib/guard.mjs')).runHook();
			return 0;
		case undefined:
		case 'help':
		case '--help':
		case '-h':
			process.stdout.write(HELP);
			return 0;
		default:
			process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
			return 1;
	}
}

// exitCode, not exit(): exiting at once can cut off output still being written to a pipe (the guard's answer).
main().then((code) => { process.exitCode = code ?? 0; }, (e) => {
	process.stderr.write(`foreman ${command}: ${e.message}\n`);
	process.exitCode = 1;
});
