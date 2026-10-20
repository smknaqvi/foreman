/**
 * Environment adapters: how each Builder gets its own local environment (a dev server, containers, a
 * WordPress site) on its own port, and how foreman finds the ones still running.
 *
 * An adapter is a module whose default export has any of:
 *   usesDocker: true                   Docker memory is watched by `foreman observe`.
 *   setup({ root, port, options })     Prepare this checkout to run on `port` (called by `foreman workspace`).
 *   list({ options })                  The environments running on this machine: [{ name, port, folder }],
 *                                      `folder` being the checkout it serves ('' if unknown).
 * `options` is the "env" object from foreman.config.json. Built in: none, wp-env, docker-compose. Anything
 * else is a path to your own module, relative to the repo root (e.g. "./tools/foreman-env.mjs").
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUILT_IN = {
	none: './none.mjs',
	'wp-env': './wp-env.mjs',
	'docker-compose': './docker-compose.mjs',
};

export async function loadAdapter(config) {
	const name = config.env.adapter;
	const url = BUILT_IN[name] ? new URL(BUILT_IN[name], import.meta.url).href : pathToFileURL(resolve(config.root, name)).href;
	let mod;
	try {
		mod = await import(url);
	} catch (e) {
		throw new Error(`Couldn't load the environment adapter "${name}": ${e.message}`);
	}
	const adapter = mod.default ?? mod;
	const options = config.env;
	return {
		name,
		usesDocker: Boolean(adapter.usesDocker),
		setup: async (ctx) => adapter.setup?.({ options, ...ctx }),
		list: async () => (await adapter.list?.({ options })) ?? [],
	};
}
