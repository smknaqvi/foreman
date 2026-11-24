#!/usr/bin/env node
/**
 * Prints the shared memory's folder from the foreman.config.json on stdin (the base branch's copy, from
 * `git show origin/<base>:foreman.config.json`), for scripts/merge.sh and approve.sh. Reading the base's copy
 * means a PR can't switch the memory rule off for itself by changing its own config. No config: the
 * default. A config that doesn't parse, or a folder that isn't valid: the default too, so the rule stays on.
 */
import { readFileSync } from 'node:fs';
import { DEFAULTS, memoryDir, validMemoryDir } from '../lib/config.mjs';

let dir = DEFAULTS.memory.dir;
try {
	const text = readFileSync(0, 'utf8');
	const set = text.trim() ? JSON.parse(text).memory?.dir : undefined;
	if (set !== undefined && validMemoryDir(set)) dir = memoryDir(set);
} catch {}
process.stdout.write(`${dir}\n`);
