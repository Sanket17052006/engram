import { NextResponse } from 'next/server';
import { getGraph, isFalkorConfigured } from '@/lib/falkordb';

export const runtime = 'nodejs';
const repo = 'internetarchive/openlibrary';
const windowSize = 20;
const detailSize = 10;
const ghHeaders = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
type Person = { login: string; html_url: string; avatar_url: string; type?: string };
type Activity = { id: number; number: number; title: string; state: string; body: string | null; html_url: string; updated_at: string; created_at: string; closed_at: string | null; comments: number; user: Person; pull_request?: unknown; labels?: { name: string }[] };
type Review = { id: number; state: string; body: string | null; html_url: string; submitted_at: string | null; user: Person | null };
type Comment = { id: number; body: string | null; html_url: string; created_at: string; updated_at?: string; user: Person | null };
type ChangedFile = { filename: string; status: string; additions: number; deletions: number; changes: number; blob_url: string | null };
async function get<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, { headers: ghHeaders, cache: 'no-store' });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}. Add GITHUB_TOKEN if the public API limit was reached.`);
  return response.json() as Promise<T>;
}
const compact = (item: Activity) => ({ number: item.number, title: item.title, state: item.state, url: item.html_url, author: item.user?.login ?? 'unknown', updated_at: item.updated_at, comments: item.comments ?? 0 });

export async function POST() {
  try {
    const [pulls, issueRows] = await Promise.all([
      get<Activity[]>(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${windowSize}`),
      get<Activity[]>(`/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=${windowSize}`),
    ]);
    const issues = issueRows.filter((item) => !item.pull_request);
    const details = await Promise.all(pulls.slice(0, detailSize).map(async (pr) => {
      const base = `/repos/${repo}`;
      const [reviews, reviewComments, issueComments, files] = await Promise.all([
        get<Review[]>(`${base}/pulls/${pr.number}/reviews?per_page=100`),
        get<Comment[]>(`${base}/pulls/${pr.number}/comments?per_page=100`),
        get<Comment[]>(`${base}/issues/${pr.number}/comments?per_page=100`),
        get<ChangedFile[]>(`${base}/pulls/${pr.number}/files?per_page=100`),
      ]);
      return { number: pr.number, reviews, comments: [...reviewComments, ...issueComments], files };
    }));
    const issueDetails = await Promise.all(issues.slice(0, detailSize).map(async (issue) => ({ number: issue.number, comments: await get<Comment[]>(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`) })));
    const reviews = details.flatMap((detail) => detail.reviews.map((review) => ({ review, number: detail.number }))).filter((entry) => entry.review.user);
    const files = details.flatMap((detail) => detail.files.map((file) => ({ file, number: detail.number })));
    const comments = [
      ...details.flatMap((detail) => detail.comments.map((comment) => ({ comment, number: detail.number, kind: 'PR' }))),
      ...issueDetails.flatMap((detail) => detail.comments.map((comment) => ({ comment, number: detail.number, kind: 'Issue' }))),
    ].filter((entry) => entry.comment.user);
    const knownPeople = [
      ...pulls.map((item) => item.user), ...issues.map((item) => item.user),
      ...reviews.map((entry) => entry.review.user), ...comments.map((entry) => entry.comment.user),
    ].filter((person): person is Person => Boolean(person?.login));
    const activity = new Map<string, { pullRequestsOpened:number; issuesOpened:number; reviewsSubmitted:number; commentsWritten:number; lastActivityAt:string }>();
    const bump = (login:string|undefined,key:'pullRequestsOpened'|'issuesOpened'|'reviewsSubmitted'|'commentsWritten',date:string) => {if(!login)return;const stats=activity.get(login)??{pullRequestsOpened:0,issuesOpened:0,reviewsSubmitted:0,commentsWritten:0,lastActivityAt:''};stats[key]+=1;if(date>stats.lastActivityAt)stats.lastActivityAt=date;activity.set(login,stats)};
    for(const item of pulls)bump(item.user?.login,'pullRequestsOpened',item.updated_at);
    for(const item of issues)bump(item.user?.login,'issuesOpened',item.updated_at);
    for(const {review} of reviews)bump(review.user?.login,'reviewsSubmitted',review.submitted_at??'');
    for(const {comment} of comments)bump(comment.user?.login,'commentsWritten',comment.updated_at??comment.created_at);
    const people = Array.from(new Map(knownPeople.map((person) => [person.login, { login: person.login, url: person.html_url, avatar: person.avatar_url, type: person.type ?? 'User', ...(activity.get(person.login)??{pullRequestsOpened:0,issuesOpened:0,reviewsSubmitted:0,commentsWritten:0,lastActivityAt:''}) }])).values());
    const syncedAt = new Date().toISOString();
    const latestActivityAt = [...pulls.map((item) => item.updated_at), ...issues.map((item) => item.updated_at)].sort().at(-1) ?? null;
    const workItems = [
      ...pulls.map((item) => ({ id: String(item.id), kind: 'PR', number: item.number, title: item.title, body: (item.body ?? '').slice(0, 8000), state: item.state, url: item.html_url, author: item.user?.login ?? 'unknown', createdAt: item.created_at, updatedAt: item.updated_at, closedAt: item.closed_at ?? '', comments: item.comments ?? 0, labels: [] as string[] })),
      ...issues.map((item) => ({ id: String(item.id), kind: 'Issue', number: item.number, title: item.title, body: (item.body ?? '').slice(0, 8000), state: item.state, url: item.html_url, author: item.user?.login ?? 'unknown', createdAt: item.created_at, updatedAt: item.updated_at, closedAt: item.closed_at ?? '', comments: item.comments ?? 0, labels: item.labels?.map((label) => label.name) ?? [] })),
    ];
    if (isFalkorConfigured()) {
      const graph = await getGraph('engram_openlibrary');
      await graph.query('MERGE (r:Repository {fullName:$repo}) SET r += $properties', { params: { repo, properties: { fullName: repo, name: 'openlibrary', url: `https://github.com/${repo}`, importedAt: syncedAt, latestActivityAt, indexedPullRequests:pulls.length, indexedIssues:issues.length } } });
      if (people.length) await graph.query('UNWIND $rows AS row MERGE (person:Contributor {login:row.login}) SET person += row', { params: { rows: people } });
      await graph.query(`UNWIND $rows AS row MATCH (repo:Repository {fullName:$repo})
        MERGE (item:WorkItem {id:row.id}) SET item += row MERGE (repo)-[membership:HAS_ITEM]->(item)
        SET membership.lastSyncedAt=$syncedAt WITH item,row
        MERGE (person:Contributor {login:row.author}) MERGE (person)-[opened:OPENED]->(item)
        SET opened.createdAt=row.createdAt,opened.kind=row.kind`, { params: { repo, syncedAt, rows: workItems } });
      if (reviews.length) await graph.query(`UNWIND $rows AS row MATCH (item:WorkItem {number:row.number,kind:'PR'})
        MERGE (review:Review {id:row.id}) SET review.state=row.state,review.body=row.body,review.url=row.url,review.submittedAt=row.submittedAt
        WITH item,review,row MATCH (person:Contributor {login:row.login})
        MERGE (person)-[submission:SUBMITTED]->(review) SET submission.state=row.state,submission.submittedAt=row.submittedAt
        MERGE (review)-[reviewLink:ON_PR]->(item) SET reviewLink.reviewUrl=row.url,reviewLink.submittedAt=row.submittedAt`, { params: { rows: reviews.map(({ review, number }) => ({ id: String(review.id), number, state: review.state, body: (review.body ?? '').slice(0, 3000), url: review.html_url, submittedAt: review.submitted_at ?? '', login: review.user!.login })) } });
      if (files.length) await graph.query(`UNWIND $rows AS row MATCH (item:WorkItem {number:row.number,kind:'PR'})
        MERGE (file:File {path:row.path,repository:$repo}) SET file.status=row.status,file.additions=row.additions,file.deletions=row.deletions,file.changes=row.changes,file.url=row.url
        MERGE (item)-[change:MODIFIES]->(file) SET change.status=row.status,change.additions=row.additions,change.deletions=row.deletions,change.changes=row.changes`, { params: { repo, rows: files.map(({ file, number }) => ({ number, path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes, url: file.blob_url ?? '' })) } });
      if (comments.length) await graph.query(`UNWIND $rows AS row MATCH (item:WorkItem {number:row.number,kind:row.kind})
        MERGE (comment:Comment {id:row.id}) SET comment.body=row.body,comment.url=row.url,comment.createdAt=row.createdAt,comment.updatedAt=row.updatedAt
        WITH item,comment,row MATCH (person:Contributor {login:row.login})
        MERGE (person)-[authored:WROTE]->(comment) SET authored.createdAt=row.createdAt
        MERGE (comment)-[context:ON_ITEM]->(item) SET context.kind=row.kind,context.createdAt=row.createdAt`, { params: { rows: comments.map(({ comment, number, kind }) => ({ id: String(comment.id), number, kind, body: (comment.body ?? '').slice(0, 3000), url: comment.html_url, createdAt: comment.created_at, updatedAt: comment.updated_at ?? comment.created_at, login: comment.user!.login })) } });
      await graph.query('MATCH (repo:Repository {fullName:$repo})-[:HAS_ITEM]->(item:WorkItem) WHERE NOT item.id IN $ids DETACH DELETE item', { params: { repo, ids: workItems.map((item) => item.id) } });
      await graph.query('MATCH (file:File {repository:$repo}) WHERE NOT (file)<-[:MODIFIES]-() DETACH DELETE file', { params: { repo } });
      await graph.query('MATCH (review:Review) WHERE NOT (review)-[:ON_PR]->() DETACH DELETE review');
      await graph.query('MATCH (comment:Comment) WHERE NOT (comment)-[:ON_ITEM]->() DETACH DELETE comment');
      await graph.query('MATCH (person:Contributor) WHERE NOT (person)--() DETACH DELETE person');
    }
    return NextResponse.json({ repository: repo, pulls: pulls.map(compact), issues: issues.map(compact), graph: isFalkorConfigured() ? 'falkordb' : 'preview', syncedAt, latestActivityAt,
      indexWindow: { pullRequests: windowSize, issues: windowSize, detailedPullRequests: detailSize, detailedIssues: detailSize },
      counts: { pullRequests: pulls.length, issues: issues.length, reviews: reviews.length, files: files.length, comments: comments.length, contributors: people.length },
    });
  } catch (error) {
    console.error('Open Library import failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load Open Library activity.' }, { status: 502 });
  }
}
