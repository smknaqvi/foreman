import { execFileSync } from 'node:child_process';

export const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
export const gh = (...args) => JSON.parse(sh('gh', args));
export const git = (...args) => sh('git', args).trim();
/** The error text worth showing from a failed command. */
export const why = (e) => String(e.stderr || e.message).trim().split('\n')[0];
