/**
 * Shared memory (lib/memory.mjs): reading notes in foreman's and Claude Code's forms, `memory check`,
 * `add`, `import`, `updates` (against the fake gh), the config, and `foreman init` creating the index.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { appliedIn, checkMemory, formatNote, memorySection, parseIndex, parseNote } from '../lib/memory.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };

// A fake `gh` on PATH, for `memory updates`.
const bin = temp('foreman-bin-');
copyFileSync(join(ROOT, 'test/fake-gh.mjs'), join(bin, 'gh'));
chmodSync(join(bin, 'gh'), 0o755);

const repo = () => {
	const dir = temp('foreman-memory-');
	execFileSync('git', ['init', '-q', '-b', 'main', dir]);
	writeFileSync(join(dir, 'foreman.config.json'), '{}');
	return dir;
};
const cli = (cwd, args, env = {}) => {
	const r = spawnSync('node', [join(ROOT, 'bin/foreman.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, CONDUCTOR_PORT: '', ...env } });
	return { code: r.status, out: r.stdout + r.stderr };
};
const note = (name, description, type = 'project', extra = '', body = 'A fact.') => `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n${extra}---\n\n${body}\n`;
const write = (dir, files) => {
	for (const [f, body] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), body); }
};
const index = (...slugs) => `# Memory\n\n## Notes\n\n${slugs.map((s) => `- [${s}](${s}.md) — about ${s}`).join('\n')}\n`;

test('parseNote reads foreman\'s form and Claude Code\'s nested metadata.type, with quoted values', () => {
	const ours = parseNote('---\nname: deploy-gotcha\ndescription: "The deploy needs: a warm cache"\ntype: decision\nupdated: 2026-11-01\nsource: "PR #12"\n---\n\nBody [[other]].\n');
	assert.equal(ours.name, 'deploy-gotcha');
	assert.equal(ours.description, 'The deploy needs: a warm cache');
	assert.equal(ours.type, 'decision');
	assert.equal(ours.updated, '2026-11-01');
	assert.equal(ours.source, 'PR #12');
	assert.match(ours.body, /Body \[\[other\]\]/);

	const claude = parseNote('---\nname: user-role\ndescription: \'Who the user is, and what they\'\'re after\'\nmetadata:\n  node_type: memory\n  type: user\n  originSessionId: 934ad958\n---\nThe user leads it.\n');
	assert.equal(claude.type, 'user');
	assert.equal(claude.description, 'Who the user is, and what they\'re after');
	assert.equal(claude.data.metadata.originSessionId, '934ad958');
	assert.equal(claude.body, 'The user leads it.\n');

	assert.match(parseNote('no frontmatter').error, /frontmatter/);
	assert.match(parseNote('---\nname: x\n').error, /closing ---/);
	assert.match(parseNote('---\nname x\n---\n').error, /isn't "key: value"/);
	assert.deepEqual(parseNote('---\ntags:\n  - a\n  - b\n---\n').data.tags, ['a', 'b']);
	// A list item under a key that holds keys (or the other way round) is an error, not a silent replacement.
	assert.match(parseNote('---\nname: x\nmetadata:\n  type: user\n  - stray\n---\n').error, /"metadata" mixes keys and a list item/);
	assert.match(parseNote('---\ntags:\n  - a\n  type: user\n---\n').error, /"tags" mixes a list and keys/);
	// Folded (>) and literal (|) values, at the top level or nested.
	const folded = parseNote('---\nname: f\ndescription: >-\n  Deploys need a warm\n  cache, always.\ntype: project\nmetadata:\n  note: |\n    line one\n    line two\n---\nBody\n');
	assert.equal(folded.description, 'Deploys need a warm cache, always.');
	assert.equal(folded.type, 'project');
	assert.equal(folded.data.metadata.note, 'line one\nline two');
	assert.equal(folded.body, 'Body\n');
	assert.equal(parseNote('---\ndescription: >\n  one\n\n  two\n---\n').description, 'one\ntwo', 'a blank line in a folded value is a line break');
	// Nested to any depth: Claude Code's metadata with a tags list, mappings in lists, lists at the key's indent.
	const deep = parseNote('---\nname: d\ndescription: Deep\nmetadata:\n  type: user\n  tags:\n    - deploy\n    - cache\n  origin:\n    tool:\n      name: claude\n  people:\n    - name: A\n      role: lead\n    - B\naliases:\n- one\n- two\nupdated: 2026-11-01\n---\nBody\n');
	assert.equal(deep.type, 'user');
	assert.deepEqual(deep.data.metadata.tags, ['deploy', 'cache']);
	assert.equal(deep.data.metadata.origin.tool.name, 'claude');
	assert.deepEqual(deep.data.metadata.people, [{ name: 'A', role: 'lead' }, 'B']);
	assert.deepEqual(deep.data.aliases, ['one', 'two']);
	assert.equal(deep.updated, '2026-11-01');

	// What foreman writes reads back the same, including values plain YAML would cut short.
	const text = formatNote({ name: 'n', description: 'Ports: from 56000 # not a comment', type: 'reference', updated: '2026-11-24', source: 'PR #3' }, 'Body.');
	const back = parseNote(text);
	assert.equal(back.description, 'Ports: from 56000 # not a comment');
	assert.equal(back.source, 'PR #3');
	assert.match(text, /^description: "Ports/m);
	// Values YAML would read as another type, or trim, are quoted too, and read back as written.
	for (const v of ['true', 'No', 'null', '~', '42', '-1.5', '1e3', '0x1f', '.inf', '2026-11-24', ' padded ', '']) {
		const t = formatNote({ name: 'n', description: v, type: 'project' }, 'b');
		assert.ok(t.split('\n').includes(`description: ${JSON.stringify(v)}`), `${JSON.stringify(v)} is quoted:\n${t}`);
		assert.equal(parseNote(t).description, v, 'and reads back as written');
	}
	assert.match(formatNote({ name: 'n', description: 'Plain words, v1.2', type: 'project' }, 'b'), /^description: Plain words, v1\.2$/m);

	assert.deepEqual(parseIndex('# M\n\n- [A](a.md) — hook a\n* [B](./b.md): hook b\n- not a link\n- [Guide](../AGENTS.md) — not a note\n').map((e) => [e.file, e.hook]), [['a.md', 'hook a'], ['b.md', 'hook b']]);
});

test('memory check: errors for notes an agent would trip over, exit 1', () => {
	const dir = repo();
	write(dir, {
		'memory/MEMORY.md': index('good', 'twice', 'twice', 'gone', 'no-desc', 'bad-type', 'misnamed', 'broken'),
		'memory/good.md': note('good', 'A good note'),
		'memory/twice.md': note('twice', 'Listed twice'),
		'memory/no-desc.md': '---\nname: no-desc\ntype: project\n---\n',
		'memory/bad-type.md': note('bad-type', 'Wrong type', 'gotcha'),
		'memory/misnamed.md': note('something-else', 'Its name differs'),
		'memory/broken.md': 'no frontmatter here',
		'memory/unlisted.md': note('unlisted', 'Not in the index'),
	});
	const r = cli(dir, ['memory', 'check']);
	assert.equal(r.code, 1, r.out);
	for (const re of [
		/FAIL {2}memory\/MEMORY\.md lists twice\.md 2 times/,
		/FAIL {2}memory\/MEMORY\.md lists gone\.md, which doesn't exist/,
		/FAIL {2}memory\/no-desc\.md has no description/,
		/FAIL {2}memory\/bad-type\.md has type "gotcha": use one of project, decision, reference, feedback, user/,
		/FAIL {2}memory\/misnamed\.md is named "something-else"/,
		/FAIL {2}memory\/broken\.md doesn't start with a frontmatter block/,
		/FAIL {2}memory\/unlisted\.md isn't listed in memory\/MEMORY\.md: add "- \[Unlisted\]\(unlisted\.md\) — Not in the index"/,
		/memory check: 7 notes in memory\/, 7 problems\./,
	]) assert.match(r.out, re);
	assert.doesNotMatch(r.out, /good\.md/);

	rmSync(join(dir, 'memory/MEMORY.md'));
	assert.match(cli(dir, ['memory', 'check']).out, /memory\/MEMORY\.md doesn't exist/);
	rmSync(join(dir, 'memory'), { recursive: true });
	const none = cli(dir, ['memory', 'check']);
	assert.equal(none.code, 1);
	assert.match(none.out, /memory\/ doesn't exist: npx --no-install foreman init creates it/);
});

test('memory check: warnings for what may be stale, exit 0', () => {
	const dir = repo();
	write(dir, {
		'lib/real.mjs': '',
		'memory/MEMORY.md': index('links', 'dup-a', 'dup-b', 'near-a', 'near-b', 'old', 'paths'),
		'memory/links.md': note('links', 'Links to others', 'project', '', 'See [[dup-a]], [[missing-note]] and [[old|the old one]].'),
		'memory/dup-a.md': note('dup-a', 'The deploy needs a warm cache'),
		'memory/dup-b.md': note('dup-b', 'the deploy needs a warm cache.'),
		'memory/near-a.md': note('near-a', 'Staging runs on the small server in Chicago with nightly exports'),
		'memory/near-b.md': note('near-b', 'Staging runs on the small server in Chicago with nightly exports to S3'),
		'memory/old.md': note('old', 'Something from long ago', 'reference', 'updated: 2020-01-02\n'),
		'memory/paths.md': note('paths', 'Where things live', 'reference', 'updated: 2026-11-20\n',
			'The code is in `lib/real.mjs` and `lib/gone.mjs:12`; `memory/` too. Not paths: `foreman/memory-`, `owner/repo`, `npm run x`, `~/.claude/x`, `/etc/hosts`.\n\n```sh\ncat `lib/in-a-block.mjs`\n```'),
	});
	const r = cli(dir, ['memory', 'check']);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /warn {2}memory\/links\.md links to \[\[missing-note\]\], which isn't a note/);
	assert.doesNotMatch(r.out, /\[\[dup-a\]\]|\[\[old\]\]/, 'links to notes that exist, with or without an alias, are fine');
	assert.match(r.out, /warn {2}memory\/dup-a\.md and memory\/dup-b\.md have the same description/);
	assert.match(r.out, /warn {2}memory\/near-a\.md and memory\/near-b\.md have nearly the same description/);
	assert.match(r.out, /warn {2}memory\/old\.md was last updated 2020-01-02, over 180 days ago/);
	assert.match(r.out, /warn {2}memory\/paths\.md mentions `lib\/gone\.mjs`, which isn't in the repo/);
	const paths = r.out.split('\n').filter((l) => l.includes('paths.md mentions'));
	assert.equal(paths.length, 1, `only lib/gone.mjs is a missing repo path:\n${paths.join('\n')}`);
	assert.match(r.out, /memory check: 7 notes in memory\/, no problems, 5 warnings\./);
	assert.deepEqual(checkMemory(loadConfig(dir), { warnings: false }).warnings, [], 'errors only, for foreman status');
});

test('memory add writes a note and its index line, refuses an existing slug, and passes the check', () => {
	const dir = repo();
	assert.equal(cli(dir, ['init']).code, 0);
	const r = cli(dir, ['memory', 'add', 'deploy-cache', '--description', 'Deploys need a warm cache: #1 cause of slow first loads', '--type', 'decision']);
	assert.equal(r.code, 0, r.out);
	const n = parseNote(readFileSync(join(dir, 'memory/deploy-cache.md'), 'utf8'));
	assert.equal(n.name, 'deploy-cache');
	assert.equal(n.type, 'decision');
	assert.equal(n.description, 'Deploys need a warm cache: #1 cause of slow first loads');
	assert.match(n.updated, /^\d{4}-\d{2}-\d{2}$/);
	const idx = readFileSync(join(dir, 'memory/MEMORY.md'), 'utf8');
	assert.match(idx, /^- \[Deploy cache\]\(deploy-cache\.md\) — Deploys need a warm cache/m);
	assert.match(idx, /Only the Coordinator edits this folder/, 'the header is kept');
	assert.equal(cli(dir, ['memory', 'check']).code, 0);

	const again = cli(dir, ['memory', 'add', 'deploy-cache', '--description', 'x']);
	assert.equal(again.code, 1);
	assert.match(again.out, /already exists/);
	assert.match(cli(dir, ['memory', 'add', 'x', '--description', 'y', '--type', 'gotcha']).out, /--type must be one of/);
	assert.match(cli(dir, ['memory', 'add', 'x']).out, /--description/);
	assert.match(cli(dir, ['memory', 'list']).out, /^deploy-cache {2}decision {3}Deploys need a warm cache/m);
});

test('memory import copies a Claude Code memory folder: converts metadata.type, skips what exists, leaves the source alone', () => {
	const dir = repo();
	cli(dir, ['init']);
	cli(dir, ['memory', 'add', 'already-here', '--description', 'Ours already']);
	const source = temp('claude-memory-');
	write(source, {
		'MEMORY.md': '- [User role and goals](user-role.md): who the user is\n- [Already](already-here.md) — theirs\n',
		'user-role.md': '---\nname: user-role\ndescription: "Who the user is: a lead"\nmetadata:\n  node_type: memory\n  type: user\n  originSessionId: 934ad958\n  modified: 2026-10-26T20:34:40.267Z\n---\nThe user leads it. See [[deploy-notes]].\n',
		'deploy-notes.md': '---\nname: deploy-notes\ndescription: How deploys work\nmetadata:\n  type: project\n---\n\nThrough CI.\n',
		'already-here.md': '---\nname: already-here\ndescription: Theirs\nmetadata:\n  type: project\n---\nTheirs.\n',
		'no-type.md': '---\nname: no-type\ndescription: Missing its type\n---\n',
	});
	const before = Object.fromEntries(readdirSync(source).map((f) => [f, [readFileSync(join(source, f), 'utf8'), statSync(join(source, f)).mtimeMs]]));

	const only = cli(dir, ['memory', 'import', source, '--only', 'deploy-notes,nope']);
	assert.equal(only.code, 0, only.out);
	assert.match(only.out, /skipped nope: no nope\.md/);
	assert.ok(existsSync(join(dir, 'memory/deploy-notes.md')));
	assert.ok(!existsSync(join(dir, 'memory/user-role.md')), '--only imports only those');

	const r = cli(dir, ['memory', 'import', source]);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /skipped already-here: memory\/already-here\.md already exists/);
	assert.match(r.out, /skipped deploy-notes: memory\/deploy-notes\.md already exists/);
	assert.match(r.out, /skipped no-type: it has no type/);
	assert.match(r.out, /imported user-role \(user\)/);
	assert.match(r.out, /remove anything private/);
	const text = readFileSync(join(dir, 'memory/user-role.md'), 'utf8');
	assert.match(text, /^type: user$/m, 'metadata.type becomes type');
	assert.match(text, /^updated: 2026-10-26$/m, 'Claude Code\'s modified time becomes updated');
	assert.doesNotMatch(text, /originSessionId|metadata|node_type/, 'Claude Code\'s other metadata is dropped');
	assert.match(text, /The user leads it\. See \[\[deploy-notes\]\]\./);
	assert.match(readFileSync(join(dir, 'memory/already-here.md'), 'utf8'), /Ours already/);
	const idx = readFileSync(join(dir, 'memory/MEMORY.md'), 'utf8');
	assert.match(idx, /^- \[User role and goals\]\(user-role\.md\) — who the user is$/m, 'the source index\'s title and hook are kept');
	assert.equal(idx.match(/already-here\.md/g).length, 1);
	assert.equal(cli(dir, ['memory', 'check']).code, 0, cli(dir, ['memory', 'check']).out);

	const now = Object.fromEntries(readdirSync(source).map((f) => [f, [readFileSync(join(source, f), 'utf8'), statSync(join(source, f)).mtimeMs]]));
	assert.deepEqual(now, before, 'the source folder is untouched');
});

test('memorySection: the "Memory updates" section of a PR body, in each way it is written, bold items and all', () => {
	assert.equal(memorySection('Fixes it.\n\n## Memory updates\n- **new** deploys need a warm cache\n- **correct `ports`**: from 56000\n\n## Plan updates\n- done\n'),
		'- **new** deploys need a warm cache\n- **correct `ports`**: from 56000');
	// A whole-line bold heading: the items' own bold doesn't end it; the next bold heading does.
	assert.equal(memorySection('**Memory updates**\n\n- **new** the cache must be warm\n- **delete `old`** it no longer holds\n\n**Plan updates**\n- done\n'),
		'- **new** the cache must be warm\n- **delete `old`** it no longer holds');
	assert.equal(memorySection('**Memory updates:**\n**new** one fact on its own line, bold first\n\n🤖 Generated with Claude Code\n'), '**new** one fact on its own line, bold first');
	// A list item among the PR's other bulleted sections: its own items' markers don't end it, the next section does.
	assert.equal(memorySection('- What changed\n- **Plan updates**: done\n- **Memory updates**: delete `old-note`, it no longer holds\n- **Hotspots**: none\n'), 'delete `old-note`, it no longer holds');
	assert.equal(memorySection('- **Memory updates**:\n  - **new** indented, bold\n- **new** unindented, bold\n- **correct `a`**: also an update\n- **Hotspots**: none\n'),
		'  - **new** indented, bold\n- **new** unindented, bold\n- **correct `a`**: also an update');
	assert.equal(memorySection('**Memory updates**\n\n- new: one\n- new: two\n\n🤖 Generated with Claude Code\n'), '- new: one\n- new: two');
	// Bold titles with _ or * in them end a section like any other.
	assert.equal(memorySection('- **Memory updates**: new: the cache\n- **Plan updates for my_db**: done\n'), 'new: the cache');
	assert.equal(memorySection('**Memory updates**\n- new: the cache\n\n**Plan updates for my_db**\n- done\n'), '- new: the cache');
	assert.equal(memorySection('### Memory Updates:\nnew: the cache\n---\nfooter'), 'new: the cache');
	for (const none of ['## Memory updates\nnone\n', '- **Memory updates**: None.\n', '## Memory updates\n\n_n/a_\n', '## Memory updates\n\n## Plan updates\nx', 'No section here.', 'Memory updates go in the PR description.', '']) assert.equal(memorySection(none), '', JSON.stringify(none));
	assert.deepEqual([...appliedIn('Memory PR.\n\nApplies memory updates from #12, #40 and #7.\n- **Applies memory updates from**: #3\n')], [12, 40, 7, 3]);
});

test('memory updates: merged PRs\' sections no memory PR has applied yet, oldest first, since the index was added', () => {
	const dir = repo();
	const git = (args, date) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
	const commit = (files, date) => { write(dir, files); git(['add', '-A'], date); git(['commit', '-q', '-m', date], date); };
	commit({ 'README.md': 'x\n' }, '2026-01-01T00:00:00Z');
	commit({ 'memory/MEMORY.md': index('a'), 'memory/a.md': note('a', 'A') }, '2026-03-01T12:00:00Z'); // The index is added.
	// A later memory PR (not where counting starts), with a note whose source is PR #6: applied.
	// (A source naming an issue, "issue #2", isn't a PR: PR #2 still shows.)
	commit({ 'memory/a.md': note('a', 'A, again'), 'memory/c.md': note('c', 'C', 'project', 'source: "PR #6"\n'), 'memory/d.md': note('d', 'D', 'project', 'source: "issue #2"\n') }, '2026-03-10T00:00:00Z');
	// A note naming PR #7 on the Coordinator's branch, not merged yet: doesn't count until it's on the base.
	write(dir, { 'memory/b.md': note('b', 'B', 'project', 'source: "PR #7"\n') });

	const stateFile = join(dir, '.git/gh-state.json');
	const pr = (number, mergedAt, body) => ({ number, title: `PR ${number}`, body, mergedAt });
	writeFileSync(stateFile, JSON.stringify({ repo: 'o/r', pr: {}, mergedPrs: [
		pr(5, '2026-03-05T00:00:00Z', '- **Memory updates**: correct `a`: it is B now\n- **Plan updates**: z'),
		pr(1, '2026-03-01T11:00:00Z', '## Memory updates\n- new: before the memory existed'),
		pr(2, '2026-03-02T00:00:00Z', '## Memory updates\n- new: the cache must be warm'),
		pr(3, '2026-03-03T00:00:00Z', '- **Memory updates**: none'),
		pr(4, '2026-03-04T00:00:00Z', '## Memory updates\n- new: applied already'),
		pr(9, '2026-03-04T06:00:00Z', 'Memory PR.\n\nApplies memory updates from #4\n\n## Memory updates\n- not a proposal'),
		pr(6, '2026-03-12T00:00:00Z', '## Memory updates\n- new: B, applied on the branch'),
		pr(7, '2026-03-09T00:00:00Z', '## Memory updates\n- new: merged while the last memory PR was open'),
	] }));
	const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: stateFile };
	const r = cli(dir, ['memory', 'updates'], env);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /since memory\/MEMORY\.md was added \([0-9a-f]{7}, 2026-03-01 12:00 UTC\) \(2 PRs already applied\)/);
	assert.ok(r.out.indexOf('PR #2 ') < r.out.indexOf('PR #5 ') && r.out.indexOf('PR #5 ') < r.out.indexOf('PR #7 '), 'oldest first');
	assert.match(r.out, /PR #2 PR 2 \(merged 2026-03-02 00:00 UTC\)\n {2}- new: the cache must be warm/);
	assert.match(r.out, /PR #5 PR 5 .*\n {2}correct `a`: it is B now\n/);
	assert.match(r.out, /PR #7 .*\n {2}- new: merged while the last memory PR was open/, 'merged before the latest memory change, but nothing applied it');
	assert.doesNotMatch(r.out, /PR #[13469] |before the memory existed|applied already|not a proposal|applied on the branch/);
	assert.match(r.out, /3 PRs to apply\. On a memory branch \(e\.g\. foreman\/memory-\d{4}-\d{2}-\d{2}\)/);
	assert.match(r.out, /Applies memory updates from #2, #5, #7/);
	assert.match(r.out, /foreman approve <PR> <sha> --memory/);
	assert.doesNotMatch(r.out, /warn/);
	assert.match(JSON.parse(readFileSync(stateFile, 'utf8')).calls.at(-1), /--state merged --base main --limit 200 .*--search merged:>=2026-02-28/);

	const since = cli(dir, ['memory', 'updates', '--since', '2026-03-04T12:00:00Z'], env);
	assert.match(since.out, /PR #5 /);
	assert.doesNotMatch(since.out, /PR #2 /);
	assert.match(cli(dir, ['memory', 'updates', '--since', 'nonsense'], env).out, /isn't a date \(YYYY-MM-DD\) or a commit/);
	const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	assert.match(cli(dir, ['memory', 'updates', '--since', head], env).out, /No memory updates to apply: 1 PR merged into main since [0-9a-f]+ \(2026-03-10 00:00 UTC\), none with "Memory updates" still to apply \(1 PR already applied\)\./);

	// GitHub gave as many as foreman asks for: say older ones weren't looked at.
	writeFileSync(stateFile, JSON.stringify({ repo: 'o/r', pr: {}, mergedPrs: Array.from({ length: 200 }, (_, k) => pr(100 + k, '2026-03-20T00:00:00Z', 'no section')) }));
	assert.match(cli(dir, ['memory', 'updates'], env).out, /warn {2}GitHub returned 200 merged PRs, the most foreman asks for/);

	// No index on the base yet: every merged PR counts, and the output says so.
	const fresh = repo();
	execFileSync('git', ['-C', fresh, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'start']);
	writeFileSync(stateFile, JSON.stringify({ repo: 'o/r', pr: {}, mergedPrs: [pr(1, '2026-03-01T11:00:00Z', '## Memory updates\n- new: x')] }));
	const none = cli(fresh, ['memory', 'updates'], env);
	assert.match(none.out, /since the start \(main has no memory\/MEMORY\.md yet\)/);
	assert.doesNotMatch(JSON.parse(readFileSync(stateFile, 'utf8')).calls.at(-1), /--search/);
});

test('memory updates: the window is decided by ancestry, not by clocks', () => {
	const dir = repo();
	const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
	const commit = (files) => { write(dir, files); git('add', '-A'); git('commit', '-q', '-m', 'c'); return git('rev-parse', 'HEAD'); };
	commit({ 'README.md': 'x\n' });
	const before = commit({ 'app.txt': '1\n' }); // PR #20's merge, before the memory existed...
	commit({ 'memory/MEMORY.md': index() });
	const after = commit({ 'app.txt': '2\n' }); // ...and PR #21's, after.
	const stateFile = join(dir, '.git/gh-state.json');
	const pr = (number, mergedAt, oid) => ({ number, title: `PR ${number}`, body: `## Memory updates\n- new: from ${number}`, mergedAt, mergeCommit: { oid } });
	// Clocks that lie: #20 says it merged later than #21.
	writeFileSync(stateFile, JSON.stringify({ repo: 'o/r', pr: {}, mergedPrs: [pr(20, '2099-01-01T00:00:00Z', before), pr(21, '2000-01-01T00:00:00Z', after)] }));
	const out = cli(dir, ['memory', 'updates'], { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: stateFile }).out;
	assert.match(out, /PR #21 /);
	assert.doesNotMatch(out, /PR #20 /);
});

test('ruleFor: falls back to the config\'s own folder, and refreshes when the base moves', async () => {
	const { ruleFor } = await import('../lib/memory-rule.mjs');
	const dir = repo();
	rmSync(join(dir, 'foreman.config.json'));
	write(dir, { 'packages/app/foreman.config.json': '{}' });
	const config = loadConfig(join(dir, 'packages/app'));
	assert.deepEqual(ruleFor(config), { path: 'packages/app/memory', onBase: false, several: [] }, 'no base yet: the config\'s folder');
	write(dir, { 'packages/app/memory/MEMORY.md': '# Memory\n' });
	execFileSync('git', ['-C', dir, 'add', '-A']);
	execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'memory']);
	assert.deepEqual(ruleFor(config), { path: 'packages/app/memory', onBase: true, several: [] }, 'the base moved: worked out again');
});

test('config: memory is on by default and validated; its folder is risky once the base has the index; dir "" switches it off', () => {
	const dir = repo();
	const c = loadConfig(dir);
	assert.deepEqual(c.memory, { dir: 'memory' });
	assert.ok(!c.riskyPaths.includes('memory/'), 'no index on the base: a folder of that name may be anything');
	write(dir, { 'memory/MEMORY.md': '# Memory\n' });
	assert.ok(!loadConfig(dir).riskyPaths.includes('memory/'), 'an uncommitted index doesn\'t count');
	execFileSync('git', ['-C', dir, 'add', '-A']);
	execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'memory']);
	assert.ok(loadConfig(dir).riskyPaths.includes('memory/'), 'committed on the base: risky');
	rmSync(join(dir, 'memory'), { recursive: true });
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ memory: { dir: './docs/memory/' } }));
	assert.equal(loadConfig(dir).memory.dir, 'docs/memory');
	assert.ok(!loadConfig(dir).riskyPaths.includes('docs/memory/'));
	for (const bad of [{ dir: '../elsewhere' }, { dir: '/abs' }, { dir: 'a b' }, { dir: 3 }]) {
		writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ memory: bad }));
		assert.throws(() => loadConfig(dir), /memory\.dir/, JSON.stringify(bad));
	}
	writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ memory: { dir: '' } }));
	assert.ok(!loadConfig(dir).riskyPaths.includes('memory/'));
	const off = cli(dir, ['memory', 'check']);
	assert.equal(off.code, 0);
	assert.match(off.out, /Shared memory is off/);
	cli(dir, ['init']);
	assert.ok(!existsSync(join(dir, 'memory')), 'init writes no memory when it is off');
});

test('init creates the memory index once, never replaces it, and leaves a folder of that name holding code alone', () => {
	const dir = repo();
	const r = cli(dir, ['init']);
	assert.match(r.out, /memory\/MEMORY\.md \(shared memory: only the Coordinator changes this folder\)/);
	assert.match(r.out, /Read memory\/MEMORY\.md before starting/);
	const idx = readFileSync(join(dir, 'memory/MEMORY.md'), 'utf8');
	assert.match(idx, /One fact per note/);
	assert.match(idx, /Only the Coordinator edits this folder,\*\* in its own memory PRs, which it approves with `foreman approve --memory`/);
	assert.match(idx, /"Memory updates" section/);
	assert.deepEqual(checkMemory(loadConfig(dir)), { notes: [], errors: [], warnings: [] });
	writeFileSync(join(dir, 'memory/MEMORY.md'), `${idx}- [Kept](kept.md) — ours\n`);
	cli(dir, ['init', '--force']);
	assert.match(readFileSync(join(dir, 'memory/MEMORY.md'), 'utf8'), /\[Kept\]/, '--force never replaces the memory');

	for (const files of [{ 'memory/allocator.c': 'int main;\n' }, { 'memory/guide.md': '# A guide\n\nOrdinary docs.\n', 'memory/n.md': note('n', 'A note') }]) {
		const clash = repo();
		write(clash, files);
		const out = cli(clash, ['init']).out;
		assert.ok(!existsSync(join(clash, 'memory/MEMORY.md')), Object.keys(files).join());
		assert.match(out, /memory\/ already holds files that aren't memory notes .* so it was left alone/);
		assert.doesNotMatch(out, /Read memory\/MEMORY\.md before starting/);
	}

	// A file called memory, or a folder called x.md inside it: not a memory folder, and no crash.
	const file = repo();
	write(file, { memory: 'just a file\n' });
	assert.match(cli(file, ['init']).out, /memory\/ already holds files that aren't memory notes/);
	const odd = repo();
	mkdirSync(join(odd, 'memory/x.md'), { recursive: true });
	const oddOut = cli(odd, ['init']);
	assert.equal(oddOut.code, 0, oddOut.out);
	assert.ok(!existsSync(join(odd, 'memory/MEMORY.md')));
	assert.match(cli(file, ['memory', 'check']).out, /memory isn't a folder/);

	// A folder of notes alone (copied from a Claude Code memory, say) is adopted, and its notes listed.
	const notes = repo();
	write(notes, { 'memory/n.md': note('n', 'A note'), 'memory/m.md': '---\nname: m\ndescription: Claude Code\'s form\nmetadata:\n  type: user\n---\nx\n', 'memory/.DS_Store': '' });
	assert.match(cli(notes, ['init']).out, /lists the 2 notes already there/);
	assert.equal(cli(notes, ['memory', 'check']).code, 0);
});
