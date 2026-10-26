/** Small Docker helpers shared by the adapters and `foreman observe`. */
import { execFileSync } from 'node:child_process';

export const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export function dockerUp() {
	try { docker('info'); return true; } catch { return false; }
}

/** Running containers (all of them, stopped too, with `all`): [{ name, ports, labels }]. */
export function containers(filters = [], { all = false } = {}) {
	const out = docker('ps', ...(all ? ['-a'] : []), ...filters.flatMap((f) => ['--filter', f]), '--format', '{{json .}}');
	return out.split('\n').filter(Boolean).map((line) => {
		const c = JSON.parse(line);
		const labels = Object.fromEntries((c.Labels || '').split(',').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
		return { name: c.Names, ports: c.Ports || '', labels };
	});
}

/** The host port mapped to `containerPort`, or ''. */
export const hostPort = (ports, containerPort) => ports.match(new RegExp(`:(\\d+)->${containerPort}/`))?.[1] ?? '';

/** Memory used by all running containers and the Docker VM's total, in MiB. */
export function memory() {
	const used = docker('stats', '--no-stream', '--format', '{{.MemUsage}}').split('\n').reduce((sum, line) => {
		const m = line.trim().match(/^([\d.]+)\s*([KMG]i?B)/);
		if (!m) return sum;
		const factor = { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[m[2]] ?? 0;
		return sum + Number(m[1]) * factor;
	}, 0);
	const total = Number(docker('info', '--format', '{{.MemTotal}}').trim()) / 1048576;
	return { used: Math.round(used), total: Math.round(total) };
}

export const PROJECT = 'com.docker.compose.project';

/** Compose projects with a container (running or stopped) set to publish `port` on the host. */
export function projectsOnPort(port) {
	if (!port) return [];
	const ids = docker('ps', '-aq').split('\n').filter(Boolean);
	const found = [];
	for (const id of ids) {
		let line;
		// One at a time: a container removed meanwhile (another checkout stopping its site) is just skipped.
		try { line = docker('inspect', '-f', `{{index .Config.Labels "${PROJECT}"}} {{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}`, id); } catch { continue; }
		const [project, ...ports] = line.trim().split(/\s+/);
		if (project && project !== '<no value>' && ports.includes(String(port))) found.push(project);
	}
	return found;
}

/**
 * Remove compose projects: their containers (running or stopped), volumes and networks. Images stay. Best
 * effort: a step that fails (something removed meanwhile, a network still in use) is reported in `failed`
 * and the rest still happens, so a clean-up step never fails the job it tidies up after.
 */
export function removeProjects(projects) {
	const removed = [], failed = [];
	for (const project of [...new Set(projects.filter(Boolean))]) {
		const label = `label=${PROJECT}=${project}`;
		const ids = (...args) => { try { return docker(...args, '--filter', label).split('\n').filter(Boolean); } catch { return []; } };
		const [c, v, n] = [ids('ps', '-aq'), ids('volume', 'ls', '-q'), ids('network', 'ls', '-q')];
		if (!c.length && !v.length && !n.length) continue;
		const steps = [c.length && ['rm', '--force', '--volumes', ...c], v.length && ['volume', 'rm', ...v], n.length && ['network', 'rm', ...n]].filter(Boolean);
		let ok = true;
		for (const step of steps) { try { docker(...step); } catch { ok = false; } }
		(ok ? removed : failed).push(project);
	}
	removed.failed = failed;
	return removed;
}
