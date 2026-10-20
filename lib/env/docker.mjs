/** Small Docker helpers shared by the adapters and `foreman observe`. */
import { execFileSync } from 'node:child_process';

export const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export function dockerUp() {
	try { docker('info'); return true; } catch { return false; }
}

/** Running containers: [{ name, ports, labels }]. */
export function containers(filters = []) {
	const out = docker('ps', ...filters.flatMap((f) => ['--filter', f]), '--format', '{{json .}}');
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
