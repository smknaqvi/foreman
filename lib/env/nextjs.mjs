/**
 * A Next.js dev server per checkout (`next dev --port <port>`), started with `foreman env start`. Next reads
 * PORT from the environment but not from .env files, so the port goes on the command line. Options: those of
 * dev-server.mjs; `command` defaults to node_modules/.bin/next dev --port {port}, `cwd` to the checkout.
 */
import { devServer } from './dev-server.mjs';

export default devServer({ name: 'nextjs', command: ['node_modules/.bin/next', 'dev', '--port', '{port}'] });
