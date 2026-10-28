/**
 * A Neon database branch per checkout: `foreman workspace` creates (or reuses) a branch of the project's
 * database for this checkout and writes its connection string to an env file, so each Builder migrates and
 * seeds its own copy. Usually combined with a server adapter: "adapter": ["nextjs", "neon"].
 * The branches are the project's branches named `prefix`…; which checkout each serves is recorded on this
 * machine (registry.mjs), so a branch whose checkout is gone is ORPHANED and `foreman tick` deletes it. Branches
 * made elsewhere are listed but never touched. `remove` deletes the branch (its data with it).
 * Needs NEON_API_KEY in the environment (never in the config). Options:
 *   projectId   the Neon project (or NEON_PROJECT_ID)
 *   parent      the branch to copy (default: the project's default branch)
 *   database, role   which database and role the connection string uses (default: the branch's first)
 *   pooled      use the pooled connection string (false)
 *   envFile (".env"), variable ("DATABASE_URL")
 *   prefix ("foreman/"), apiUrl (https://console.neon.tech/api/v2)
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setVars } from './envfile.mjs';
import { entries, prune, real, record } from './registry.mjs';

const settings = (options) => {
	const key = process.env.NEON_API_KEY;
	const project = options.projectId || process.env.NEON_PROJECT_ID;
	if (!key) throw new Error('NEON_API_KEY isn\'t set (an API key from the Neon console; keep it out of the config)');
	if (!project) throw new Error('set env.projectId (or NEON_PROJECT_ID) to the Neon project');
	return { key, project, api: (options.apiUrl ?? 'https://console.neon.tech/api/v2').replace(/\/$/, ''), prefix: options.prefix ?? 'foreman/' };
};

async function call(s, method, path, body) {
	for (let attempt = 0; ; attempt++) {
		const r = await fetch(`${s.api}/projects/${encodeURIComponent(s.project)}${path}`, {
			method,
			headers: { Authorization: `Bearer ${s.key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(30000),
		});
		// 423: another operation on the project is still running (a branch being created, say). Wait for it.
		if (r.status === 423 && attempt < 10) { await sleep(2000); continue; }
		const text = await r.text();
		if (!r.ok) throw Object.assign(new Error(`Neon API ${method} ${path}: ${r.status} ${text.slice(0, 200)}`), { status: r.status });
		return text ? JSON.parse(text) : {};
	}
}

/** This checkout's branch name: its folder's name plus a short hash of its path (two repos' "main" differ). */
export const branchName = (prefix, root) => `${prefix}${basename(root).replace(/[^\w.-]+/g, '-')}-${createHash('sha1').update(real(root)).digest('hex').slice(0, 6)}`;

export default {
	async setup({ root, port, options }) {
		const s = settings(options);
		prune(root);
		const name = branchName(s.prefix, root);
		const { branches } = await call(s, 'GET', '/branches');
		let branch = branches.find((b) => b.name === name);
		if (!branch) {
			const parent = options.parent ? branches.find((b) => b.name === options.parent || b.id === options.parent) : null;
			if (options.parent && !parent) throw new Error(`no branch "${options.parent}" (env.parent) in Neon project ${s.project}`);
			branch = (await call(s, 'POST', '/branches', { branch: { name, ...(parent ? { parent_id: parent.id } : {}) }, endpoints: [{ type: 'read_write' }] })).branch;
			console.log(`Made the Neon branch ${name}${parent ? ` from ${parent.name}` : ''}.`);
		} else console.log(`Using the Neon branch ${name}.`);
		const { databases } = await call(s, 'GET', `/branches/${branch.id}/databases`);
		const db = options.database ? databases.find((d) => d.name === options.database) : databases[0];
		if (!db) throw new Error(`the Neon branch ${name} has no database${options.database ? ` "${options.database}"` : ''}`);
		const q = new URLSearchParams({ branch_id: branch.id, database_name: db.name, role_name: options.role ?? db.owner_name, pooled: String(Boolean(options.pooled)) });
		const { uri } = await call(s, 'GET', `/connection_uri?${q}`);
		const file = options.envFile ?? '.env', variable = options.variable ?? 'DATABASE_URL';
		setVars(root, file, { [variable]: uri });
		record(root, root, { ...(port ? { port } : {}), neon: { branchId: branch.id, name } });
		console.log(`${file}: ${variable} points at it (database ${db.name}).`);
	},

	async list({ root, options }) {
		const s = settings(options);
		const mine = new Map(entries(root).filter((e) => e.neon?.branchId).map((e) => [e.neon.branchId, e]));
		const { branches } = await call(s, 'GET', '/branches');
		return branches.filter((b) => b.name.startsWith(s.prefix)).map((b) => {
			const e = mine.get(b.id);
			return { name: `neon ${b.name}`, port: e?.port ? String(e.port) : '', folder: e?.folder ?? '', branchId: b.id };
		});
	},

	/** One branch from list(), or this checkout's branch and any recorded for `port`. */
	async remove({ root, env, port, options }) {
		const s = settings(options);
		const targets = env ? [{ branchId: env.branchId, name: env.name }]
			: entries(root).filter((e) => e.neon?.branchId && (e.folder === real(root) || (port && Number(e.port) === Number(port)))).map((e) => ({ branchId: e.neon.branchId, name: `neon ${e.neon.name}`, folder: e.folder }));
		const removed = [], failed = [];
		for (const t of targets) {
			try {
				await call(s, 'DELETE', `/branches/${t.branchId}`);
				removed.push(t.name);
			} catch (e) {
				(e.status === 404 ? removed : failed).push(t.name);
			}
		}
		// Forget what was deleted, so the checkout makes a new branch next time.
		for (const e of entries(root)) if (e.neon && targets.some((t) => t.branchId === e.neon.branchId) && existsSync(e.folder)) record(root, e.folder, { neon: undefined });
		prune(root);
		removed.failed = failed;
		return removed;
	},
};
