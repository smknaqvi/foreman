#!/usr/bin/env node
/**
 * The shared memory's merge rule (lib/memory-rule.mjs) for scripts/merge.sh and approve.sh, run from anywhere
 * in the checkout (where the memory is comes from the base branch's config, not the checkout's):
 *   memory-dir.mjs files <base ref> <head>   the memory files the PR at <head> changes, NUL-separated: none
 *                                            when the memory isn't set up on the base (and the PR doesn't
 *                                            add its index), or is switched off there
 *   memory-dir.mjs path <base ref>           the memory folder from the repo's top ('' when off)
 * Exits 1 when it can't tell (a commit it can't read): the scripts then refuse rather than guess.
 */
import { changedFiles, memoryFiles, memoryRule } from '../lib/memory-rule.mjs';

const [what, ref, head] = process.argv.slice(2);
const root = process.cwd(); // Anywhere in the checkout: where the config is comes from the base, not from here.
try {
	const rule = memoryRule(root, ref);
	if (rule.several.length) process.stderr.write(`Several foreman.config.json files on ${ref} (${rule.several.join(', ')}): the shared memory follows the top-most, ${rule.several[0]}.\n`);
	if (what === 'path') process.stdout.write(`${rule.path}\n`);
	else if (what === 'files') {
		const files = memoryFiles(rule, changedFiles(root, ref, head));
		process.stdout.write(files.map((f) => `${f}\0`).join(''));
	} else throw new Error('usage: memory-dir.mjs files <base ref> <head> | path <base ref>');
} catch (e) {
	process.stderr.write(`Couldn't check the shared memory: ${String(e.stderr || e.message).trim().split('\n')[0]}\n`);
	process.exit(1);
}
