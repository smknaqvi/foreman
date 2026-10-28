/**
 * A Rails server per checkout (`bin/rails server --port <port>`), started with `foreman env start`. Rails'
 * development database is shared by every checkout unless told otherwise: give each its own through `vars`,
 * e.g. { "DATABASE_URL": "postgres://localhost/myapp_{checkout}" }, and have the Builder run
 * bin/rails db:prepare first. Options: those of dev-server.mjs.
 */
import { devServer } from './dev-server.mjs';

export default devServer({ name: 'rails', command: ['bin/rails', 'server', '--port', '{port}'] });
