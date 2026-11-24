/**
 * Shared memory: durable facts every agent on the repo reads (gotchas, decisions and their reasons, where
 * things live, what the team prefers), kept in the repo so every tool and every machine sees the same ones.
 * Only the Coordinator writes them: `foreman merge` refuses a PR that changes the folder unless the
 * Coordinator approved it with `foreman approve --memory` (scripts/merge.sh). Builders propose changes in
 * their PR's "Memory updates" section instead, and the Coordinator applies them in a memory PR whose
 * description says which PRs it applied ("Applies memory updates from #12, #40").
 *
 * The format is Claude Code's own memory format, so notes move between the two:
 *   <dir>/<slug>.md   frontmatter (name = slug, description, type, optional updated and source), then the
 *                     fact itself. Links to other notes: [[other-slug]].
 *   <dir>/MEMORY.md   a short header, then one "- [Title](slug.md) — hook" line per note.
 * Claude Code nests the type ("metadata:\n  type: project"); both forms are read.
 *
 *   foreman memory check                      the folder is consistent (exit 1 on errors), and what looks stale
 *   foreman memory list                       one line per note
 *   foreman memory add <slug> --description   a new note and its index line
 *   foreman memory import <folder> [--only]   copy notes from a folder in the same format (a Claude Code memory)
 *   foreman memory updates [--since]          the "Memory updates" sections of merged PRs that no memory PR
 *                                             has applied yet, for the Coordinator to apply
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gh, git, why } from './sh.mjs';

export const TYPES = ['project', 'decision', 'reference', 'feedback', 'user'];
export const INDEX = 'MEMORY.md';
const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const STALE_DAYS = 180;

const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD, local time.
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const off = (config) => !config.memory?.dir;

/**
 * Frontmatter between --- lines: `key: value` lines, one level of nesting (`metadata:` then indented
 * `type: project`), indented `- item` lists, and folded (`>`) or literal (`|`) block values. Not a YAML
 * parser: enough for the notes foreman and Claude Code write. A plain value is taken as written (no `#`
 * comments); quoted values are unquoted. Returns { data, body } or { error }.
 */
export function parseFrontmatter(text) {
	const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
	if (lines[0].trim() !== '---') return { error: 'doesn\'t start with a frontmatter block (a --- line)' };
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
	if (end < 0) return { error: 'its frontmatter block has no closing --- line' };
	const data = {};
	let parent = null; // A top-level key with nothing after its colon: a mapping or a list follows.
	const isMapping = (v) => v && typeof v === 'object' && !Array.isArray(v);
	for (let i = 1; i < end; i++) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith('#')) continue;
		const item = line.match(/^(\s*)-\s+(.*)$/);
		if (item && parent) {
			if (isMapping(data[parent]) && Object.keys(data[parent]).length) return { error: `frontmatter line ${i + 1}: "${parent}" mixes keys and a list item (- ${item[2].trim()})` };
			if (!Array.isArray(data[parent])) data[parent] = [];
			data[parent].push(unquote(item[2]));
			continue;
		}
		const m = line.match(/^(\s*)([\w.-]+):(?:\s+(.*))?$/);
		if (!m) return { error: `frontmatter line ${i + 1} isn't "key: value": ${line.trim()}` };
		const [, indent, key, raw = ''] = m;
		let value;
		const block = raw.trim().match(/^([|>])([+-]?)\d?([+-]?)$/);
		if (block) {
			// The value is the lines indented deeper than the key, up to the next line that isn't.
			const body = [];
			let j = i + 1;
			for (; j < end && (!lines[j].trim() || lines[j].match(/^\s*/)[0].length > indent.length); j++) body.push(lines[j]);
			i = j - 1;
			value = blockScalar(body, block[1], block[2] || block[3]);
		} else value = raw.trim() ? unquote(raw) : null;
		if (!indent) {
			parent = value === null ? key : null;
			data[key] = value ?? {};
		} else if (parent && isMapping(data[parent])) data[parent][key] = value ?? '';
		else if (parent) return { error: `frontmatter line ${i + 1}: "${parent}" mixes a list and keys (${key})` };
		else return { error: `frontmatter line ${i + 1} is indented but belongs to no key: ${line.trim()}` };
	}
	return { data, body: lines.slice(end + 1).join('\n') };
}

/** A `|` (literal: lines kept) or `>` (folded: lines joined by spaces, blank lines kept as breaks) value. */
function blockScalar(lines, style, chomp) {
	const deepest = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
	const body = lines.map((l) => (l.trim() ? l.slice(deepest) : ''));
	while (body.length && !body.at(-1)) body.pop();
	let text = style === '|' ? body.join('\n') : body.reduce((out, l, k) => (k === 0 ? l : !l ? `${out}\n` : out.endsWith('\n') || !body[k - 1] ? `${out}${l}` : `${out} ${l}`), '');
	if (chomp === '+') text += '\n';
	return text; // Clip and strip both drop the last line break: a description is one line.
}

function unquote(value) {
	const v = value.trim();
	if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) {
		try { return JSON.parse(v); } catch { return v.slice(1, -1); }
	}
	if (v.length > 1 && v.startsWith('\'') && v.endsWith('\'')) return v.slice(1, -1).replaceAll('\'\'', '\'');
	return v;
}

/** A note's fields, whichever form its type is in. */
export function parseNote(text) {
	const parsed = parseFrontmatter(text);
	if (parsed.error) return parsed;
	const { data, body } = parsed;
	const field = (v) => (typeof v === 'string' ? v : '');
	return {
		name: field(data.name),
		description: field(data.description),
		type: field(data.type) || field(data.metadata?.type),
		updated: field(data.updated) || field(data.metadata?.updated),
		source: field(data.source),
		data,
		body,
	};
}

// Quoted when plain YAML would read it differently ("PR #12" would lose "#12" to a comment).
const yaml = (v) => (/^[\s\-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|:$|\s$/.test(v) ? JSON.stringify(v) : v);

/** A note in foreman's form. */
export function formatNote({ name, description, type, updated = '', source = '' }, body) {
	const head = [`name: ${name}`, `description: ${yaml(description)}`, `type: ${type}`];
	if (updated) head.push(`updated: ${updated}`);
	if (source) head.push(`source: ${yaml(source)}`);
	return `---\n${head.join('\n')}\n---\n${body.startsWith('\n') ? '' : '\n'}${body.replace(/\s*$/, '')}\n`;
}

/** The index's header, written by `foreman init` (and by `add` or `import` when there is none). */
export function indexHeader(config) {
	const { dir } = config.memory;
	return `# Memory

Durable facts every agent working on this repo should know: gotchas, decisions and their reasons, where things live, what the team prefers. Read this list before starting, then the notes that touch your work.

- **One fact per note:** \`${dir}/<slug>.md\`, starting with its \`name\` (the slug), a one-line \`description\` and a \`type\` (project, decision, reference, feedback or user). Link related notes with \`[[other-slug]]\`.
- **Only the Coordinator edits this folder,** in its own memory PRs, which it approves with \`foreman approve --memory\`. \`foreman merge\` refuses any other PR that changes it.
- **Builders propose changes** in their PR's "Memory updates" section: new facts, corrections to a note (by its name), notes to delete. The Coordinator applies them.
- **Nothing private:** no secrets, no where-the-keys-live, no one person's preferences. Everyone with the repo reads this.

## Notes

`;
}

/**
 * The index's entries: `- [Title](slug.md) — hook` lines, in order. Links elsewhere (`../AGENTS.md`, a URL)
 * aren't entries: notes sit in the folder itself.
 */
export function parseIndex(text) {
	const entries = [];
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\s*[-*+]\s+\[([^\]]*)\]\(([^)\s]+\.md)\)\s*(?:[—–:-]+\s*)?(.*)$/);
		const file = m?.[2].replace(/^\.\//, '');
		if (m && !file.includes('/')) entries.push({ title: m[1], file, hook: m[3].trim() });
	}
	return entries;
}

const indexLine = (title, slug, hook) => `- [${title}](${slug}.md)${hook ? ` — ${hook}` : ''}`;
const titleOf = (slug) => { const words = slug.replace(/[-_.]+/g, ' ').trim(); return words.charAt(0).toUpperCase() + words.slice(1); };

/** The notes in `folder` (every .md but the index), by slug. */
function readNotes(folder) {
	if (!existsSync(folder)) return [];
	return readdirSync(folder, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== INDEX)
		.map((e) => e.name)
		.sort()
		.map((file) => ({ file, slug: file.slice(0, -3), ...parseNote(readFileSync(join(folder, file), 'utf8')) }));
}

/** Add lines to the index, creating it with its header if needed. */
function appendIndex(config, lines) {
	const file = join(config.root, config.memory.dir, INDEX);
	const now = existsSync(file) ? readFileSync(file, 'utf8') : indexHeader(config);
	writeFileSync(file, `${now.replace(/\s*$/, '\n')}${now.trim().endsWith('## Notes') ? '\n' : ''}${lines.join('\n')}\n`);
}

/**
 * The whole folder checked. Errors: something an agent reading it would trip over (a note that doesn't
 * parse, lacks its name, description or type, or isn't listed exactly once; an index line to nothing).
 * Warnings: what may have gone stale (links to missing notes, near-duplicate descriptions, repo paths that
 * no longer exist, notes not updated in STALE_DAYS days).
 */
export function checkMemory(config) {
	const { dir } = config.memory;
	const folder = join(config.root, dir);
	const errors = [], warnings = [];
	if (!existsSync(folder)) return { notes: [], errors: [`${dir}/ doesn't exist: npx --no-install foreman init creates it`], warnings };
	const notes = readNotes(folder);
	const slugs = new Set(notes.map((n) => n.slug));
	const at = (n) => `${dir}/${n.file}`;

	for (const n of notes) {
		if (n.error) { errors.push(`${at(n)} ${n.error}`); continue; }
		if (!SLUG.test(n.slug)) errors.push(`${at(n)}: the file name should be a plain slug (letters, digits, - . _)`);
		if (!n.name) errors.push(`${at(n)} has no name (it should be "${n.slug}")`);
		else if (n.name !== n.slug) errors.push(`${at(n)} is named "${n.name}": the name and the file name must match ("${n.slug}")`);
		if (!n.description) errors.push(`${at(n)} has no description`);
		else if (n.description.includes('\n')) errors.push(`${at(n)}: its description should be one line`);
		if (!n.type) errors.push(`${at(n)} has no type (one of ${TYPES.join(', ')})`);
		else if (!TYPES.includes(n.type)) errors.push(`${at(n)} has type "${n.type}": use one of ${TYPES.join(', ')}`);
	}

	const indexFile = join(folder, INDEX);
	if (!existsSync(indexFile)) errors.push(`${dir}/${INDEX} doesn't exist: it lists every note (npx --no-install foreman init creates it)`);
	else {
		const entries = parseIndex(readFileSync(indexFile, 'utf8'));
		const seen = new Map();
		for (const e of entries) seen.set(e.file, (seen.get(e.file) ?? 0) + 1);
		for (const [file, count] of seen) {
			if (!notes.some((n) => n.file === file)) errors.push(`${dir}/${INDEX} lists ${file}, which doesn't exist`);
			else if (count > 1) errors.push(`${dir}/${INDEX} lists ${file} ${count} times: once is enough`);
		}
		for (const n of notes) if (!seen.has(n.file)) errors.push(`${at(n)} isn't listed in ${dir}/${INDEX}: add "${indexLine(titleOf(n.slug), n.slug, n.description || '…')}"`);
	}

	const good = notes.filter((n) => !n.error);
	for (const n of good) {
		for (const [, target] of n.body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
			if (!slugs.has(target.trim())) warnings.push(`${at(n)} links to [[${target.trim()}]], which isn't a note`);
		}
		for (const p of stalePaths(config.root, n.body)) warnings.push(`${at(n)} mentions \`${p}\`, which isn't in the repo (moved or removed? update the note)`);
		if (n.updated) {
			const day = n.updated.slice(0, 10);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) warnings.push(`${at(n)}: updated "${n.updated}" isn't a date (YYYY-MM-DD)`);
			else if (Date.now() - Date.parse(day) > STALE_DAYS * 86400e3) warnings.push(`${at(n)} was last updated ${day}, over ${STALE_DAYS} days ago: is it still true?`);
		}
	}
	for (let i = 0; i < good.length; i++) {
		for (let j = i + 1; j < good.length; j++) {
			const a = good[i], b = good[j];
			const same = similarity(a.description, b.description);
			if (same === 1) warnings.push(`${at(a)} and ${at(b)} have the same description: merge them, or say how they differ`);
			else if (same >= 0.8) warnings.push(`${at(a)} and ${at(b)} have nearly the same description: duplicates?`);
		}
	}
	return { notes, errors, warnings };
}

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'and', 'or', 'is', 'are', 'for', 'with', 'it', 'its', 'be', 'by', 'at', 'as']);
/** 1 for the same words, down to 0 for none in common (Jaccard over the words that carry meaning). */
function similarity(a, b) {
	const words = (s) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w)));
	const x = words(a), y = words(b);
	if (!x.size || !y.size) return 0;
	const common = [...x].filter((w) => y.has(w)).length;
	const score = common / (x.size + y.size - common);
	return score === 1 || Math.min(x.size, y.size) >= 3 ? score : 0; // Two short descriptions sharing a word aren't duplicates.
}

/**
 * Paths in backticks that look like they're in this repo (they contain a / and start with a folder or file
 * that exists at its root) but don't exist: a note about code that has moved or gone.
 */
function stalePaths(root, body) {
	const text = body.replace(/^(```|~~~)[\s\S]*?^\1/gm, ''); // Not inside code blocks.
	const out = new Set();
	for (const [, raw] of text.matchAll(/`([^`\n]+)`/g)) {
		let p = raw.trim().replace(/^\.\//, '');
		if (/\s|[*?{}<>$[\]|]|:\/\//.test(p) || /^[~/-]|^\.\.\//.test(p) || !p.includes('/')) continue;
		p = p.replace(/#.*$/, '').replace(/:\d+(:\d+)?$/, '').replace(/\/+$/, '');
		const first = p.split('/')[0];
		if (!first || !existsSync(join(root, first))) continue; // owner/repo, a branch name, a package: not a repo path.
		if (!existsSync(join(root, p))) out.add(p);
	}
	return [...out];
}

/** `foreman memory check`: print the result; exit 1 on errors. */
export function check(config, { log = console.log } = {}) {
	if (off(config)) { log('Shared memory is off (memory.dir is empty in foreman.config.json).'); return 0; }
	const { notes, errors, warnings } = checkMemory(config);
	for (const e of errors) log(`  FAIL  ${e}`);
	for (const w of warnings) log(`  warn  ${w}`);
	const counts = [errors.length ? plural(errors.length, 'problem') : 'no problems', warnings.length && plural(warnings.length, 'warning')].filter(Boolean).join(', ');
	log(`memory check: ${plural(notes.length, 'note')} in ${config.memory.dir}/, ${counts}.`);
	return errors.length ? 1 : 0;
}

/** `foreman memory list`: one line per note. */
export function list(config, { log = console.log } = {}) {
	if (off(config)) { log('Shared memory is off (memory.dir is empty in foreman.config.json).'); return 0; }
	const notes = readNotes(join(config.root, config.memory.dir));
	if (!notes.length) { log(`No notes in ${config.memory.dir}/ yet.`); return 0; }
	const width = Math.max(...notes.map((n) => n.slug.length));
	for (const n of notes) log(`${n.slug.padEnd(width)}  ${(n.error ? '?' : n.type || '?').padEnd(9)}  ${n.error ? `(${n.error})` : n.description}`);
	return 0;
}

/** `foreman memory add <slug> --description <text> [--type project] [--title <t>]`: a note to fill in. */
export function add(config, slug, { description = '', type = 'project', title = '', source = '' } = {}, { log = console.log } = {}) {
	if (off(config)) throw new Error('shared memory is off (memory.dir is empty in foreman.config.json)');
	if (!slug || !SLUG.test(slug) || slug.toUpperCase() === 'MEMORY') throw new Error('usage: foreman memory add <slug> --description "<one line>" [--type project]. The slug is the file name: letters, digits, - . _');
	if (!description.trim() || /\n/.test(description)) throw new Error('--description: one line saying what the note is about');
	if (!TYPES.includes(type)) throw new Error(`--type must be one of ${TYPES.join(', ')}`);
	const folder = join(config.root, config.memory.dir);
	const file = join(folder, `${slug}.md`);
	if (existsSync(file)) throw new Error(`${config.memory.dir}/${slug}.md already exists: edit it instead`);
	mkdirSync(folder, { recursive: true });
	writeFileSync(file, formatNote({ name: slug, description: description.trim(), type, updated: today(), source }, '<!-- One fact: what it is, why it holds, and how to apply it. Link related notes with [[other-slug]]. -->'));
	appendIndex(config, [indexLine(title || titleOf(slug), slug, description.trim())]);
	log(`Wrote ${config.memory.dir}/${slug}.md and its line in ${config.memory.dir}/${INDEX}. Write the fact in it, then: npx --no-install foreman memory check`);
	return 0;
}

/**
 * `foreman memory import <folder> [--only a,b]`: copy notes from a folder in the same format (a person's
 * Claude Code memory, ~/.claude/projects/<project>/memory) into the repo's. Only reads the source. Notes
 * whose slug is already here are skipped; Claude Code's metadata.type becomes type, and its other metadata
 * (session ids, timestamps) is dropped. Index lines keep the source index's title and hook when it has them.
 */
export function importNotes(config, source, { only = '' } = {}, { log = console.log } = {}) {
	if (off(config)) throw new Error('shared memory is off (memory.dir is empty in foreman.config.json)');
	if (!source) throw new Error('usage: foreman memory import <folder> [--only slug,slug]');
	if (!existsSync(source)) throw new Error(`${source} doesn't exist`);
	const folder = join(config.root, config.memory.dir);
	const wanted = only ? new Set(only.split(',').map((s) => s.trim().replace(/\.md$/, '')).filter(Boolean)) : null;
	const theirIndex = existsSync(join(source, INDEX)) ? parseIndex(readFileSync(join(source, INDEX), 'utf8')) : [];
	const notes = readNotes(source).filter((n) => !wanted || wanted.has(n.slug));
	for (const slug of wanted ?? []) if (!notes.some((n) => n.slug === slug)) log(`  skipped ${slug}: no ${slug}.md in ${source}`);

	const imported = [], lines = [];
	for (const n of notes) {
		const skip = (why) => log(`  skipped ${n.slug}: ${why}`);
		if (existsSync(join(folder, n.file))) { skip(`${config.memory.dir}/${n.file} already exists`); continue; }
		if (n.error) { skip(n.error); continue; }
		if (!SLUG.test(n.slug)) { skip('its file name isn\'t a plain slug'); continue; }
		if (!n.description) { skip('it has no description'); continue; }
		if (!TYPES.includes(n.type)) { skip(n.type ? `its type "${n.type}" isn't one of ${TYPES.join(', ')}` : 'it has no type'); continue; }
		const modified = typeof n.data.metadata?.modified === 'string' ? n.data.metadata.modified.slice(0, 10) : '';
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, n.file), formatNote({ name: n.slug, description: n.description, type: n.type, updated: n.updated.slice(0, 10) || modified, source: n.source }, n.body));
		const theirs = theirIndex.find((e) => e.file === n.file);
		lines.push(indexLine(theirs?.title || titleOf(n.slug), n.slug, theirs?.hook || n.description));
		imported.push(n.slug);
		log(`  imported ${n.slug} (${n.type})`);
	}
	if (lines.length) appendIndex(config, lines);
	log(`Imported ${plural(imported.length, 'note')} into ${config.memory.dir}/${imported.length ? ` and listed ${imported.length === 1 ? 'it' : 'them'} in ${config.memory.dir}/${INDEX}` : ''}. ${source} wasn't changed.`);
	if (imported.length) {
		log(`
Before committing, read every imported note and remove anything private: secrets and tokens, where keys
or passwords live, server addresses that shouldn't be public, and one person's own preferences or details.
Everyone with the repo will read these. Then: npx --no-install foreman memory check`);
	}
	return 0;
}

/**
 * A PR body's "Memory updates" section, '' when there is none or it says "none". Three ways to write one:
 *   ## Memory updates            up to the next heading
 *   **Memory updates**           (or "Memory updates:") up to the next heading or whole-line bold heading;
 *   - **new** …                  bold markers inside its items don't end it
 *   - **Memory updates**: …      a list item, with the rest of the PR's sections as list items: up to the
 *                                next heading, bold heading or list item with its own bold lead-in (an
 *                                update's own marker, **new**, **correct `slug`**, **delete `slug`**, doesn't count)
 */
export function memorySection(body = '') {
	const lines = String(body).split(/\r?\n/);
	// A lead-in, not prose that happens to start with the words: a heading, bold, or a colon after them.
	const lead = (l) => {
		const m = l.match(/^\s{0,3}(#{1,6}\s*|[-*+]\s+)?(\*\*|__)?memory updates\s*(:)?\s*\2\s*(:)?\s*/i);
		return m && (m[1]?.includes('#') || m[2] || m[3] || m[4] || m[0].length === l.length) ? m : null;
	};
	const start = lines.findIndex(lead);
	if (start < 0) return '';
	const m = lead(lines[start]);
	const form = m[1]?.includes('#') ? 'heading' : m[1] ? 'item' : 'bold';
	const heading = (l) => /^\s{0,3}#{1,6}\s/.test(l);
	const boldLine = (l) => /^\s{0,3}(\*\*|__)(?:(?!\1).)+\1\s*:?\s*$/.test(l); // The whole line bold: a heading.
	const MARKER = /^(?:new|correct|correction|delete|remove|update|fix|merge|rename)\b/i;
	const nextItem = (l) => { const b = l.match(/^[-*+]\s+(?:\*\*|__)([^*_]+)(?:\*\*|__)/); return b && !MARKER.test(b[1].replace(/`/g, '').trim()); };
	const first = lines[start].slice(m[0].length).trim();
	const out = first ? [first] : [];
	for (const line of lines.slice(start + 1)) {
		if (heading(line)) break; // The next section.
		if (form !== 'heading' && boldLine(line)) break;
		if (form === 'item' && nextItem(line)) break; // The PR's next bulleted section (- **Plan updates**: …).
		if (/^\s*(?:🤖|---\s*$)/u.test(line)) break; // The attribution line, or a rule before it.
		out.push(line);
	}
	const text = out.join('\n').replace(/^\s*\n|\s*$/g, '');
	const bare = text.replace(/[\s\-*+_.`>:()/!]/g, '').toLowerCase();
	return ['', 'none', 'nothing', 'na', 'nonethistime'].includes(bare) ? '' : text;
}

/** The PRs a memory PR says it applied: its "Applies memory updates from #12, #40" line(s). */
export function appliedIn(body = '') {
	const out = new Set();
	for (const [, list] of String(body).matchAll(/^[\s>*_-]*applies memory updates from\b(.*)$/gim)) {
		for (const [, n] of list.matchAll(/#(\d+)/g)) out.add(Number(n));
	}
	return out;
}

const LIMIT = 200; // PRs asked of GitHub at once.

/**
 * The PRs merged into the base whose "Memory updates" no memory PR has applied yet, oldest first. A memory
 * PR records what it applied with a line "Applies memory updates from #12, #40" (a note's `source: "PR #12"`
 * counts too). Looks at PRs merged since the memory's index was added to the base (before that there was no
 * memory to update), or since `since` (a date or a commit).
 */
export function memoryUpdates(config, { since = '' } = {}) {
	const { baseBranch: base, root } = config;
	const { dir } = config.memory;
	let at = 0, from;
	if (since && /^\d{4}-\d{2}-\d{2}/.test(since)) {
		at = Date.parse(since);
		if (Number.isNaN(at)) throw new Error(`--since ${since} isn't a date (YYYY-MM-DD) or a commit`);
		from = since;
	} else if (since) {
		let iso;
		try { iso = git('-C', root, 'log', '-1', '--format=%cI', since); } catch { throw new Error(`--since ${since} isn't a date (YYYY-MM-DD) or a commit here`); }
		at = Date.parse(iso);
		from = `${since.slice(0, 12)} (${stamp(iso)})`;
	} else {
		try { git('-C', root, 'fetch', '-q', 'origin', base); } catch {} // Offline: the last fetch will do.
		let ref = 'HEAD';
		try { git('-C', root, 'rev-parse', '--verify', '-q', `origin/${base}`); ref = `origin/${base}`; } catch {}
		const added = git('-C', root, 'log', '-1', '--diff-filter=A', '--format=%h %cI', ref, '--', `${dir}/${INDEX}`);
		if (added) {
			const [sha, iso] = added.split(' ');
			at = Date.parse(iso);
			from = `${dir}/${INDEX} was added (${sha}, ${stamp(iso)})`;
		} else from = `the start (${base} has no ${dir}/${INDEX} yet)`;
	}
	const args = ['pr', 'list', '--state', 'merged', '--base', base, '--limit', String(LIMIT), '--json', 'number,title,body,mergedAt'];
	if (at) args.push('--search', `merged:>=${new Date(at).toISOString().slice(0, 10)}`); // Whole days; filtered exactly below.
	let merged;
	try { merged = gh(...args); } catch (e) { throw new Error(`Couldn't list merged PRs (is gh logged in? try: gh auth status): ${why(e)}`); }
	const inWindow = merged.filter((p) => Date.parse(p.mergedAt) > at).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
	const memoryPrs = inWindow.filter((p) => appliedIn(p.body).size);
	const applied = new Set(memoryPrs.flatMap((p) => [...appliedIn(p.body)]));
	for (const n of readNotes(join(root, dir))) for (const [, num] of (n.source ?? '').matchAll(/#(\d+)/g)) applied.add(Number(num));
	const proposed = inWindow.filter((p) => !memoryPrs.includes(p)).map((p) => ({ number: p.number, title: p.title, mergedAt: p.mergedAt, section: memorySection(p.body) })).filter((p) => p.section);
	return {
		from,
		merged: inWindow.length,
		applied: proposed.filter((p) => applied.has(p.number)).length,
		prs: proposed.filter((p) => !applied.has(p.number)),
		limited: merged.length >= LIMIT,
	};
}

const stamp = (iso) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** `foreman memory updates [--since <date|sha>]`: print what to apply. */
export function updates(config, { since = '' } = {}, { log = console.log } = {}) {
	if (off(config)) { log('Shared memory is off (memory.dir is empty in foreman.config.json).'); return 0; }
	const { from, merged, applied, prs, limited } = memoryUpdates(config, { since });
	if (limited) log(`  warn  GitHub returned ${LIMIT} merged PRs, the most foreman asks for: older ones weren't looked at. Narrow it with --since <date>.\n`);
	const done = applied ? ` (${plural(applied, 'PR')} already applied)` : '';
	if (!prs.length) {
		log(`No memory updates to apply: ${merged ? `${plural(merged, 'PR')} merged into ${config.baseBranch} since ${from}, none with "Memory updates" still to apply${done}` : `no PR has merged into ${config.baseBranch} since ${from}`}.`);
		return 0;
	}
	log(`Memory updates not applied yet, from PRs merged into ${config.baseBranch} since ${from}${done}:\n`);
	for (const p of prs) log(`PR #${p.number} ${p.title} (merged ${stamp(p.mergedAt)})\n${p.section.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
	log(`${plural(prs.length, 'PR')} to apply. On a memory branch (e.g. foreman/memory-${today()}), apply them, run npx --no-install foreman memory check, and open a PR whose description says:
  Applies memory updates from ${prs.map((p) => `#${p.number}`).join(', ')}
(list every PR you handled, including any you decided not to apply, so they stop showing here). Review it and approve it with npx --no-install foreman approve <PR> <sha> --memory.`);
	return 0;
}

/** `foreman memory <subcommand>`. */
export function command(config, positionals, values) {
	const [sub, ...args] = positionals;
	switch (sub) {
		case 'check': return check(config);
		case 'list': case undefined: return list(config);
		case 'add': return add(config, args[0], values);
		case 'import': return importNotes(config, args[0], values);
		case 'updates': return updates(config, values);
		default: throw new Error(`unknown memory command "${sub}" (check, list, add, import, updates)`);
	}
}
