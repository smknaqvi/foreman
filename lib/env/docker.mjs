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
	if (!ids.length) return [];
	const out = docker('inspect', '-f', `{{index .Config.Labels "${PROJECT}"}} {{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}`, ...ids);
	return out.split('\n').map((l) => l.trim().split(/\s+/)).filter(([project, ...ports]) => project && project !== '<no value>' && ports.includes(String(port))).map(([project]) => project);
}

/** Remove compose projects: their containers (running or stopped), volumes and networks. Images stay. */
export function removeProjects(projects) {
	const removed = [];
	for (const project of [...new Set(projects.filter(Boolean))]) {
		const label = `label=${PROJECT}=${project}`;
		const ids = (...args) => docker(...args, '--filter', label).split('\n').filter(Boolean);
		const [c, v, n] = [ids('ps', '-aq'), ids('volume', 'ls', '-q'), ids('network', 'ls', '-q')];
		if (!c.length && !v.length && !n.length) continue;
		if (c.length) docker('rm', '--force', '--volumes', ...c);
		if (v.length) docker('volume', 'rm', ...v);
		if (n.length) docker('network', 'rm', ...n);
		removed.push(project);
	}
	return removed;
}
