/**
 * WordPress through @wordpress/env. Each checkout gets its own port in .wp-env.override.json; running sites
 * are wp-env's "wordpress" containers, and the checkout each serves is the common folder of its mounts.
 * `remove` takes away a checkout's whole site (both environments, running or stopped, their database volumes
 * and network) but keeps wp-env's downloads (~/.wp-env/<project>) and the images, so the next start is quick.
 * Options: none.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, sep } from 'node:path';
import { PROJECT, containers, docker, hostPort, projectsOnPort, removeProjects } from './docker.mjs';

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
			return { name: c.name, port: hostPort(c.ports, 80), folder: commonFolder(own), project: c.labels[PROJECT] ?? '' };
		});
	},

	/** One environment from list(), or this checkout's (`root`) plus anything set to publish `port`. */
	async remove({ env, root, port }) {
		if (env) return removeProjects([env.project]);
		return removeProjects([await projectOf(root), ...projectsOnPort(port)]);
	},
};

/** wp-env names the compose project after its work folder for a checkout (~/.wp-env/<project>). */
async function projectOf(root) {
	if (!root) return '';
	try {
		const require = createRequire(join(root, 'package.json'));
		const { loadConfig } = require('@wordpress/env/lib/config');
		return basename((await loadConfig(root)).workDirectoryPath);
	} catch {
		return ''; // No wp-env installed here: only the port finds it.
	}
}

function commonFolder(paths) {
	if (!paths.length) return '';
	if (paths.length === 1) return dirname(paths[0]);
	const parts = paths.map((p) => p.split(sep));
	const common = [];
	for (let i = 0; parts.every((p) => p[i] !== undefined && p[i] === parts[0][i]); i++) common.push(parts[0][i]);
	return common.join(sep) || sep;
}
