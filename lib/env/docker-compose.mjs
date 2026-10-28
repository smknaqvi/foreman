/**
 * A docker compose project per checkout. Each checkout gets its own port through a variable in an env file
 * (compose reads .env by default); running environments are the containers of `service`, and the checkout
 * each serves is compose's working-directory label. `remove` takes containers, volumes and networks; images stay.
 * Options: service ("web"), containerPort (3000), envFile (".env"), portVariable ("PORT").
 */
import { PROJECT, containers, hostPort, projectsOnPort, removeProjects } from './docker.mjs';
import { setVars } from './envfile.mjs';

export default {
	usesDocker: true,

	setup({ root, port, options }) {
		if (!port) return;
		const name = options.portVariable ?? 'PORT';
		setVars(root, options.envFile ?? '.env', { [name]: port });
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
