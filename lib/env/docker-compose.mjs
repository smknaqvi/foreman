/**
 * A docker compose project per checkout. Each checkout gets its own port through a variable in an env file
 * (compose reads .env by default); running environments are the containers of `service`, and the checkout
 * each serves is compose's working-directory label. `remove` takes containers, volumes and networks; images stay.
 * Options: service ("web"), containerPort (3000), envFile (".env"), portVariable ("PORT").
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT, containers, hostPort, projectsOnPort, removeProjects } from './docker.mjs';

export default {
	usesDocker: true,

	setup({ root, port, options }) {
		if (!port) return;
		const file = join(root, options.envFile ?? '.env');
		const name = options.portVariable ?? 'PORT';
		const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l, i, all) => l || i < all.length - 1) : [];
		const at = lines.findIndex((l) => l.startsWith(`${name}=`));
		if (at >= 0) lines[at] = `${name}=${port}`;
		else lines.push(`${name}=${port}`);
		writeFileSync(file, `${lines.join('\n')}\n`);
		console.log(`${options.envFile ?? '.env'}: ${name}=${port}`);
	},

	list({ options }) {
		const service = options.service ?? 'web';
		return containers([`label=com.docker.compose.service=${service}`]).map((c) => ({
			name: c.name,
			port: hostPort(c.ports, options.containerPort ?? 3000),
			folder: c.labels['com.docker.compose.project.working_dir'] ?? '',
			project: c.labels[PROJECT] ?? '',
		}));
	},

	/** One environment from list(), or every project started from this checkout (`root`) plus anything on `port`. */
	remove({ env, root, port }) {
		if (env) return removeProjects([env.project]);
		const here = root ? containers([`label=com.docker.compose.project.working_dir=${root}`], { all: true }).map((c) => c.labels[PROJECT]) : [];
		return removeProjects([...here, ...projectsOnPort(port)]);
	},
};
