// Programmatic use: the same pieces the CLI is built from.
export { CONFIG_FILE, DEFAULTS, RISKY_ALWAYS, loadConfig, findRoot } from './config.mjs';
export { blockedReason, decide, runHook, OVERRIDE } from './guard.mjs';
export { loadAdapter } from './env/index.mjs';
