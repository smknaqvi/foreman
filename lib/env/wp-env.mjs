/**
 * WordPress through @wordpress/env. Each checkout gets its own port in .wp-env.override.json; running sites
 * are wp-env's "wordpress" containers, and the checkout each serves is the common folder of its mounts.
 * Options: none.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { containers, docker, hostPort } from './docker.mjs';

const OVERRIDE = '.wp-env.override.json';

export default {
	usesDocker: true,

	setup({ root, port }) {
		if (!port) return;
		const file = join(root, OVERRIDE);
		const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
		if (current.port === port) return;
		if (current.port) return console.log(`${OVERRIDE} already uses port ${current.port}; leaving it.`);
		writeFileSync(file, `${JSON.stringify({ ...current, port }, null, '\t')}\n`);
		console.log(`WordPress for this checkout will run at http://localhost:${port}`);
	},

	list() {
		return containers().filter((c) => /-wordpress-1$/.test(c.name) && !/-tests-wordpress-1$/.test(c.name)).map((c) => {
			let mounts = [];
			try {
				mounts = docker('inspect', '-f', '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\\n"}}{{end}}{{end}}', c.name).split('\n').filter(Boolean);
			} catch {} // It may have just stopped.
			// wp-env's own copy of WordPress lives under ~/.wp-env; the rest are the checkout's mapped folders.
			const own = mounts.filter((m) => !m.split(sep).includes('.wp-env'));
			return { name: c.name, port: hostPort(c.ports, 80), folder: commonFolder(own) };
		});
	},
};

function commonFolder(paths) {
	if (!paths.length) return '';
	if (paths.length === 1) return dirname(paths[0]);
	const parts = paths.map((p) => p.split(sep));
	const common = [];
	for (let i = 0; parts.every((p) => p[i] !== undefined && p[i] === parts[0][i]); i++) common.push(parts[0][i]);
	return common.join(sep) || sep;
}
