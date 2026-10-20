/**
 * An environment adapter of your own: point "env.adapter" in foreman.config.json at this file
 * ("./tools/foreman-env.mjs"); everything else in "env" arrives as `options`.
 * This one runs a plain dev server per checkout on its own port and finds running ones with lsof.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default {
	usesDocker: false,

	// Called by `foreman workspace --port <port>` (or with $CONDUCTOR_PORT) in a fresh checkout.
	setup({ root, port }) {
		if (port) writeFileSync(join(root, '.port'), `${port}\n`); // The dev script reads it.
	},

	// The environments running on this machine, so `foreman status` can match them to Builders and spot
	// orphans: [{ name, port, folder }].
	list({ options }) {
		const [from, to] = options.portRange ?? [5100, 5199];
		let out = '';
		try { out = execFileSync('lsof', ['-nP', `-iTCP:${from}-${to}`, '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' }); } catch { return []; }
		const envs = [];
		let pid = '';
		for (const line of out.split('\n')) {
			if (line.startsWith('p')) pid = line.slice(1);
			if (line.startsWith('n')) {
				const cwd = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
				envs.push({ name: `pid ${pid}`, port: line.split(':').pop(), folder: cwd });
			}
		}
		return envs;
	},
};
