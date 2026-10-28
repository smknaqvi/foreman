/**
 * Which checkout of the repo has which port, and what an adapter made for it (a dev server's pid, a database
 * branch), for adapters whose environments Docker can't describe. One file per checkout in the repo's shared
 * git folder (<git common dir>/foreman/environments/), so every worktree, `foreman tick` and the watchdog see
 * the same, and two checkouts never write the same file.
 *   { folder, port, <adapter name>: { ...what that adapter keeps } }
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../sh.mjs';

/** A folder's real path (lsof reports those: /private/var/… for /var/… on macOS), or the path itself if it's gone. */
export const real = (folder) => { try { return realpathSync(folder); } catch { return folder; } };
const dir = (root) => join(git('-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'foreman', 'environments');
const fileOf = (root, folder) => join(dir(root), `${createHash('sha1').update(real(folder)).digest('hex').slice(0, 16)}.json`);

/** Every checkout recorded for the repo `root` belongs to. */
export function entries(root) {
	let names = [];
	try { names = readdirSync(dir(root)).filter((n) => n.endsWith('.json')); } catch { return []; }
	return names.flatMap((n) => { try { return [JSON.parse(readFileSync(join(dir(root), n), 'utf8'))]; } catch { return []; } });
}

export function entry(root, folder = root) {
	try { return JSON.parse(readFileSync(fileOf(root, folder), 'utf8')); } catch { return null; }
}

/** Merge `patch` into the checkout's entry. A key set to undefined is dropped. */
export function record(root, folder, patch) {
	mkdirSync(dir(root), { recursive: true });
	const next = JSON.parse(JSON.stringify({ ...(entry(root, folder) ?? {}), folder: real(folder), ...patch }));
	const file = fileOf(root, folder);
	writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, '\t')}\n`);
	renameSync(`${file}.tmp`, file);
	return next;
}

export function forget(root, folder) {
	rmSync(fileOf(root, folder), { force: true });
}

/** Drop the entries of checkouts whose folder is gone. */
export function prune(root) {
	for (const e of entries(root)) if (e.folder && !existsSync(e.folder)) forget(root, e.folder);
}
