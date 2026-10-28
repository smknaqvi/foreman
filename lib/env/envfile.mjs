/** Writing variables into a checkout's env file (.env and friends), for the adapters. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { git } from '../sh.mjs';

/** Set `vars` ({ NAME: value }) in `file` (relative to `root`), keeping every other line. */
export function setVars(root, file, vars) {
	const path = join(root, file);
	const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l, i, all) => l || i < all.length - 1) : [];
	for (const [name, value] of Object.entries(vars)) {
		const at = lines.findIndex((l) => l.startsWith(`${name}=`));
		if (at >= 0) lines[at] = `${name}=${value}`;
		else lines.push(`${name}=${value}`);
	}
	writeFileSync(path, `${lines.join('\n')}\n`);
	if (tracked(root, file)) console.log(`Note: ${file} is tracked by git, so this change shows up in the checkout's diff. Don't commit it (or use a file git ignores).`);
}

export function tracked(root, file) {
	try { git('-C', root, 'ls-files', '--error-unmatch', file); return true; } catch { return false; }
}

/** "{port}" and "{checkout}" (the checkout folder's name, made safe for database names) in a template. */
export const fill = (template, { root, port }) => String(template)
	.replaceAll('{port}', String(port ?? ''))
	.replaceAll('{checkout}', basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'checkout');
