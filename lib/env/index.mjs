/**
 * Environment adapters: how each Builder gets its own local environment (a dev server, containers, a
 * WordPress site, a database branch) on its own port, and how foreman finds the ones still running.
 *
 * An adapter is a module whose default export has any of:
 *   usesDocker: true                   Docker memory is watched by `foreman observe`.
 *   setup({ root, port, options })     Prepare this checkout to run on `port` (called by `foreman workspace`).
 *   start({ root, port, options })     Start this checkout's environment (`foreman env start`).
 *   list({ root, options })            The environments running on this machine: [{ name, port, folder }],
 *                                      `folder` being the checkout it serves ('' if unknown). Anything
 *                                      else in an entry is passed back to remove().
 *   remove({ root, options, env })     Remove one environment from list() (`foreman tick`: orphans).
 *   remove({ root, options, port })    Remove this checkout's environment, running or stopped, and anything
 *                                      on `port` (`foreman env remove`, e.g. before and after a CI job).
 * `root` is the checkout foreman runs in, `options` the "env" object from foreman.config.json plus, for a
 * combination, the object under the adapter's own name.
 * Built in: none, wp-env, docker-compose, dev-server, nextjs, rails, neon. Anything else is a path to your own
 * module, relative to the repo root (e.g. "./tools/foreman-env.mjs").
 * "adapter" may be a list (["nextjs", "neon"]): each does its part, in that order.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUILT_IN = {
	none: './none.mjs',
	'wp-env': './wp-env.mjs',
	'docker-compose': './docker-compose.mjs',
	'dev-server': './dev-server.mjs',
	nextjs: './nextjs.mjs',
	rails: './rails.mjs',
	neon: './neon.mjs',
};

export async function loadAdapter(config) {
	const names = [config.env.adapter].flat();
	const parts = [];
	for (const name of names) parts.push(await loadOne(config, name, names.length > 1));
	return parts.length === 1 ? parts[0] : combine(parts);
}

async function loadOne(config, name, combined) {
	const url = BUILT_IN[name] ? new URL(BUILT_IN[name], import.meta.url).href : pathToFileURL(resolve(config.root, name)).href;
	let mod;
	try {
		mod = await import(url);
	} catch (e) {
		throw new Error(`Couldn't load the environment adapter "${name}": ${e.message}`);
	}
	const adapter = mod.default ?? mod;
	const own = config.env[name];
	const options = { ...config.env, ...(own && typeof own === 'object' && !Array.isArray(own) ? own : {}) };
	const root = config.root;
	// In a combination, each entry says which adapter it came from, so remove() goes back to that one.
	const tag = (envs) => (combined ? (envs ?? []).map((e) => ({ ...e, adapter: name })) : envs ?? []);
	return {
		name,
		usesDocker: Boolean(adapter.usesDocker),
		setup: async (ctx) => adapter.setup?.({ root, options, ...ctx }),
		canStart: typeof adapter.start === 'function',
		start: async (ctx) => adapter.start?.({ root, options, ...ctx }),
		list: async () => tag(await adapter.list?.({ root, options })),
		canRemove: typeof adapter.remove === 'function',
		remove: async (ctx) => adapter.remove?.({ root, options, ...ctx }),
	};
}

function combine(parts) {
	const removing = parts.filter((p) => p.canRemove);
	return {
		name: parts.map((p) => p.name).join(' + '),
		parts,
		usesDocker: parts.some((p) => p.usesDocker),
		setup: async (ctx) => { for (const p of parts) await p.setup(ctx); },
		canStart: parts.some((p) => p.canStart),
		start: async (ctx) => { for (const p of parts.filter((x) => x.canStart)) await p.start(ctx); },
		/** What every part lists. A part that fails is named in `errors`; only if all fail does list() throw. */
		async list() {
			const results = await Promise.allSettled(parts.map((p) => p.list()));
			const errors = results.flatMap((r, i) => (r.status === 'rejected' ? [`${parts[i].name}: ${String(r.reason?.message ?? r.reason).split('\n')[0]}`] : []));
			if (errors.length === parts.length) throw new Error(errors.join('; '));
			return Object.assign(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])), { errors });
		},
		canRemove: removing.length > 0,
		async remove(ctx) {
			const targets = ctx.env ? removing.filter((p) => p.name === ctx.env.adapter) : removing;
			const removed = [], failed = [];
			for (const p of targets) {
				try {
					const r = (await p.remove(ctx)) ?? [];
					removed.push(...r);
					failed.push(...(r.failed ?? []));
				} catch (e) {
					// Best effort, like each adapter's own: one that fails doesn't stop the others.
					failed.push(`${p.name} (${String(e.message).split('\n')[0]})`);
				}
			}
			removed.failed = failed;
			return removed;
		},
	};
}
