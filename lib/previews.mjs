/**
 * Preview deployments of each PR's head commit: anything that reports to GitHub's Deployments API (Vercel,
 * Netlify, Cloudflare Pages, Render...), read in one GraphQL query. Production deployments don't count. A
 * Coordinator reviewing visual work can open the preview instead of starting the Builder's environment.
 */
import { gh } from './sh.mjs';

/** { <PR number>: [{ environment, url }] } for PRs ([{ number, headRefOid }]) whose head has a live preview. */
export function previews(repo, prs) {
	if (!prs.length) return {};
	const one = (p) => `p${p.number}:object(oid:"${p.headRefOid}"){...on Commit{deployments(first:20,orderBy:{field:CREATED_AT,direction:DESC}){nodes{environment latestStatus{state environmentUrl}}}}}`;
	const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${prs.map(one).join(' ')}}}`;
	const data = gh('api', 'graphql', '-f', `query=${query}`, '-f', `owner=${repo.owner.login}`, '-f', `name=${repo.name}`).data.repository;
	return Object.fromEntries(prs.map((p) => [p.number, live(data[`p${p.number}`]?.deployments?.nodes ?? [])]).filter(([, list]) => list.length));
}

/** The newest deployment per environment, if it succeeded and has a URL. Newest first in `nodes`. */
export function live(nodes) {
	const seen = new Set(), out = [];
	for (const d of nodes) {
		if (!d.environment || seen.has(d.environment) || /production/i.test(d.environment)) continue;
		seen.add(d.environment);
		if (d.latestStatus?.state === 'SUCCESS' && d.latestStatus.environmentUrl) out.push({ environment: d.environment, url: d.latestStatus.environmentUrl });
	}
	return out;
}
