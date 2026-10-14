import { NextResponse } from 'next/server';
import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
export const runtime = 'nodejs';
const repo = 'internetarchive/openlibrary';
export async function POST() {
  try {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
    const [pullResponse, issueResponse] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=20`, { headers, next: { revalidate: 0 } }),
      fetch(`https://api.github.com/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=20`, { headers, next: { revalidate: 0 } }),
    ]);
    if (!pullResponse.ok || !issueResponse.ok) throw new Error(`GitHub API returned ${pullResponse.status}/${issueResponse.status}. Add GITHUB_TOKEN if the public API limit was reached.`);
    const [pulls, issueRows] = await Promise.all([pullResponse.json(), issueResponse.json()]);
    const issues = issueRows.filter((item: { pull_request?: unknown }) => !item.pull_request);
    const details = await Promise.all(pulls.slice(0, 10).map(async (pr: any) => {
      const [reviewResponse, fileResponse] = await Promise.all([
        fetch(`https://api.github.com/repos/${repo}/pulls/${pr.number}/reviews?per_page=50`, { headers }),
        fetch(`https://api.github.com/repos/${repo}/pulls/${pr.number}/files?per_page=50`, { headers }),
      ]);
      return { number: pr.number, reviews: reviewResponse.ok ? await reviewResponse.json() : [], files: fileResponse.ok ? await fileResponse.json() : [] };
    }));
    const reviews = details.flatMap((d: any) => d.reviews.map((r: any) => ({ id: String(r.id), state: r.state, url: r.html_url, submittedAt: r.submitted_at ?? '', login: r.user?.login ?? '', number: d.number })).filter((r: any) => r.login));
    const files = details.flatMap((d: any) => d.files.map((f: any) => ({ path: f.filename, url: f.blob_url ?? '', number: d.number })));
    if (isFalkorConfigured()) {
      const graph = await getGraph('engram_openlibrary');
      await graph.query('MERGE (r:Repository {fullName:$repo}) SET r.url=$url,r.importedAt=$importedAt RETURN r', { params: { repo, url: `https://github.com/${repo}`, importedAt: new Date().toISOString() } });
      const rows = [...pulls.map((p: any) => ({ kind:'PR', id:String(p.id), number:p.number, title:p.title, state:p.state, url:p.html_url, author:p.user?.login ?? 'unknown', updatedAt:p.updated_at, comments:p.comments ?? 0, body:(p.body ?? '').slice(0,1200) })), ...issues.map((p: any) => ({ kind:'Issue', id:String(p.id), number:p.number, title:p.title, state:p.state, url:p.html_url, author:p.user?.login ?? 'unknown', updatedAt:p.updated_at, comments:p.comments ?? 0, body:(p.body ?? '').slice(0,1200) }))];
      await graph.query('UNWIND $rows AS row MATCH (r:Repository {fullName:$repo}) MERGE (x:WorkItem {id:row.id}) SET x += row WITH r,x,row MERGE (r)-[:HAS_ITEM]->(x) MERGE (u:Contributor {login:row.author}) MERGE (u)-[:OPENED]->(x)', { params: { repo, rows } });
      if (reviews.length) await graph.query('UNWIND $rows AS row MATCH (p:WorkItem {number:row.number,kind:"PR"}) MERGE (v:Review {id:row.id}) SET v.state=row.state,v.url=row.url,v.submittedAt=row.submittedAt WITH p,v,row MERGE (u:Contributor {login:row.login}) MERGE (u)-[:SUBMITTED]->(v)-[:ON_PR]->(p)', { params: { rows: reviews } });
      if (files.length) await graph.query('UNWIND $rows AS row MATCH (p:WorkItem {number:row.number,kind:"PR"}) MERGE (f:File {path:row.path,repository:$repo}) SET f.url=row.url MERGE (p)-[:MODIFIES]->(f)', { params: { repo, rows: files } });
    }
    const compact = (x: any) => ({ number:x.number, title:x.title, state:x.state, url:x.html_url, author:x.user?.login ?? 'unknown', updated_at:x.updated_at, comments:x.comments ?? 0 });
    return NextResponse.json({ repository: repo, pulls: pulls.map(compact), issues: issues.map(compact), graph: isFalkorConfigured() ? 'falkordb' : 'preview', counts: { pullRequests: pulls.length, issues: issues.length, reviews: reviews.length, files: files.length } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load Open Library activity.' }, { status: 502 }); }
}
