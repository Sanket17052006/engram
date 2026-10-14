import { NextResponse } from 'next/server';
import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
import { githubApi, installationToken } from '@/lib/github-app';
import { privateGraphName, readSession, setSession } from '@/lib/github-session';

export const runtime = 'nodejs';
const ITEM_WINDOW = 200;
const DETAIL_WINDOW = 50;
const BODY_LIMIT = 8_000;

type User = { id: number; login: string; html_url: string; avatar_url: string; type?: string };
type Pull = { id: number; number: number; title: string; body: string | null; state: string; user: User; html_url: string; created_at: string; updated_at: string; closed_at: string | null; merged_at: string | null; additions: number; deletions: number; changed_files: number; base: { ref: string }; head: { ref: string }; comments: number; review_comments: number };
type Issue = { id: number; number: number; title: string; body: string | null; state: string; user: User; html_url: string; created_at: string; updated_at: string; closed_at: string | null; pull_request?: unknown; comments: number; labels: { name: string }[] };
type Commit = { sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } | null }; author: User | null };
type ChangedFile = { filename: string; status: string; additions: number; deletions: number; changes: number; blob_url: string | null };
type Review = { id: number; user: User | null; state: string; body: string | null; html_url: string; submitted_at: string | null };
type Comment = { id: number; user: User | null; body: string | null; html_url: string; created_at: string; updated_at?: string };
type Repo = { full_name: string; name: string; html_url: string; description: string | null; default_branch: string; private: boolean };

async function pages<T>(path: string, token: string, max = ITEM_WINDOW): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; rows.length < max; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = await githubApi<T[]>(`${path}${separator}per_page=100&page=${page}`, token);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows.slice(0, max);
}
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let index = 0; index < items.length; index += size) output.push(...await Promise.all(items.slice(index, index + size).map(fn)));
  return output;
}
const compact = (item: { number: number; title: string; state: string; html_url: string; user: User; updated_at: string; comments: number }) => ({
  number: item.number, title: item.title, state: item.state, url: item.html_url, author: item.user?.login ?? 'unknown', updated_at: item.updated_at, comments: item.comments ?? 0,
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const fullName = typeof body.repository === 'string' ? body.repository.trim() : '';
  const [owner, repoName] = fullName.split('/');
  if (!owner || !repoName || fullName.split('/').length !== 2 || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repoName)) {
    return NextResponse.json({ error: 'Choose a repository in owner/name format.' }, { status: 400 });
  }
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'Sign in with GitHub before importing a repository.' }, { status: 401 });
  if (!session.installationId) return NextResponse.json({ error: 'Install Engram and grant access to a repository before importing it.' }, { status: 409 });
  if (!isFalkorConfigured()) return NextResponse.json({ error: 'Add FALKORDB_URL before importing repository data.' }, { status: 503 });

  try {
    const token = await installationToken(session.installationId);
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
    const repository = await githubApi<Repo>(prefix, token);
    const [pulls, issueRows, commitResult, contributors] = await Promise.all([
      pages<Pull>(`${prefix}/pulls?state=all&sort=updated&direction=desc`, token, ITEM_WINDOW),
      pages<Issue>(`${prefix}/issues?state=all&sort=updated&direction=desc`, token, ITEM_WINDOW),
      // Contents:read is needed for this endpoint; if the app has not been granted it, keep syncing the rest.
      pages<Commit>(`${prefix}/commits`, token, ITEM_WINDOW).then(rows=>({available:true,rows})).catch(() => ({available:false,rows:[] as Commit[]})),
      pages<User>(`${prefix}/contributors`, token, 100).catch(() => [] as User[]),
    ]);
    const commits=commitResult.rows;
    const issues = issueRows.filter((item) => !item.pull_request);
    const pullDetails = await inBatches(pulls.slice(0, DETAIL_WINDOW), 5, async (pr) => {
      const [reviews, reviewComments, issueComments, files] = await Promise.all([
        pages<Review>(`${prefix}/pulls/${pr.number}/reviews`, token, 200),
        pages<Comment>(`${prefix}/pulls/${pr.number}/comments`, token, 200),
        pages<Comment>(`${prefix}/issues/${pr.number}/comments`, token, 200),
        pages<ChangedFile>(`${prefix}/pulls/${pr.number}/files`, token, 300),
      ]);
      return { number: pr.number, reviews, comments: [...reviewComments, ...issueComments], files };
    });
    const issueDetails = await inBatches(issues.slice(0, DETAIL_WINDOW), 5, async (issue) => ({
      number: issue.number, comments: await pages<Comment>(`${prefix}/issues/${issue.number}/comments`, token, 200),
    }));

    const peopleByLogin = new Map<string, User>();
    const knownPeople = [
      ...contributors, ...pulls.map((pr) => pr.user), ...issues.map((issue) => issue.user),
      ...commits.map((commit) => commit.author).filter((user): user is User => Boolean(user)),
      ...pullDetails.flatMap((detail) => [...detail.reviews.map((review) => review.user), ...detail.comments.map((comment) => comment.user)]).filter((user): user is User => Boolean(user)),
      ...issueDetails.flatMap((detail) => detail.comments.map((comment) => comment.user)).filter((user): user is User => Boolean(user)),
    ];
    for (const person of knownPeople) if (person?.login) peopleByLogin.set(person.login, person);
    const activity = new Map<string, { pullRequestsOpened:number; issuesOpened:number; reviewsSubmitted:number; commentsWritten:number; commitsAuthored:number; lastActivityAt:string }>();
    const recordActivity = (login:string|undefined, key:'pullRequestsOpened'|'issuesOpened'|'reviewsSubmitted'|'commentsWritten'|'commitsAuthored', date:string) => {
      if(!login)return;
      const stats=activity.get(login)??{pullRequestsOpened:0,issuesOpened:0,reviewsSubmitted:0,commentsWritten:0,commitsAuthored:0,lastActivityAt:''};
      stats[key]+=1;if(date>stats.lastActivityAt)stats.lastActivityAt=date;activity.set(login,stats);
    };
    for(const item of pulls)recordActivity(item.user?.login,'pullRequestsOpened',item.updated_at);
    for(const item of issues)recordActivity(item.user?.login,'issuesOpened',item.updated_at);
    for(const detail of pullDetails){for(const review of detail.reviews)recordActivity(review.user?.login,'reviewsSubmitted',review.submitted_at??'');for(const comment of detail.comments)recordActivity(comment.user?.login,'commentsWritten',comment.updated_at??comment.created_at);}
    for(const detail of issueDetails)for(const comment of detail.comments)recordActivity(comment.user?.login,'commentsWritten',comment.updated_at??comment.created_at);
    for(const commit of commits)recordActivity(commit.author?.login,'commitsAuthored',commit.commit.author?.date??'');
    const latestActivityAt = [...pulls.map((item) => item.updated_at), ...issues.map((item) => item.updated_at)].sort().at(-1) ?? null;

    const graph = await getGraph(privateGraphName(session.id, repository.full_name));
    const importedAt = new Date().toISOString();
    await graph.query('MERGE (r:Repository {fullName:$fullName}) SET r += $properties', { params: {
      fullName: repository.full_name,
      properties: { fullName: repository.full_name, name: repository.name, url: repository.html_url, description: repository.description ?? '', defaultBranch: repository.default_branch, private: repository.private, importedAt, latestActivityAt, indexedPullRequests:pulls.length, indexedIssues:issues.length, indexedCommits:commits.length },
    } });

    const people = Array.from(peopleByLogin.values()).map((user) => ({ login: user.login, url: user.html_url, avatar: user.avatar_url, type: user.type ?? 'User', ...(activity.get(user.login)??{pullRequestsOpened:0,issuesOpened:0,reviewsSubmitted:0,commentsWritten:0,commitsAuthored:0,lastActivityAt:''}) }));
    if (people.length) await graph.query('UNWIND $rows AS row MERGE (u:Contributor {login:row.login}) SET u += row', { params: { rows: people } });

    const workItems = [
      ...pulls.map((item) => ({ id: String(item.id), kind: 'PR', number: item.number, title: item.title, body: (item.body ?? '').slice(0, BODY_LIMIT), state: item.state, url: item.html_url, author: item.user?.login ?? 'unknown', createdAt: item.created_at, updatedAt: item.updated_at, closedAt: item.closed_at ?? '', mergedAt: item.merged_at ?? '', comments: item.comments + item.review_comments, base: item.base.ref, head: item.head.ref, additions: item.additions, deletions: item.deletions, changedFiles: item.changed_files, labels: [] as string[] })),
      ...issues.map((item) => ({ id: String(item.id), kind: 'Issue', number: item.number, title: item.title, body: (item.body ?? '').slice(0, BODY_LIMIT), state: item.state, url: item.html_url, author: item.user?.login ?? 'unknown', createdAt: item.created_at, updatedAt: item.updated_at, closedAt: item.closed_at ?? '', mergedAt: '', comments: item.comments, base: '', head: '', additions: 0, deletions: 0, changedFiles: 0, labels: item.labels.map((label) => label.name) })),
    ];
    if (workItems.length) await graph.query(`UNWIND $rows AS row
      MATCH (r:Repository {fullName:$fullName}) MERGE (item:WorkItem {id:row.id}) SET item += row
      MERGE (r)-[membership:HAS_ITEM]->(item) SET membership.lastSyncedAt=$importedAt
      WITH item,row MERGE (person:Contributor {login:row.author})
      MERGE (person)-[opened:OPENED]->(item) SET opened.createdAt=row.createdAt,opened.kind=row.kind`, { params: { fullName: repository.full_name, importedAt, rows: workItems } });

    const commitsToWrite = commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message.slice(0, BODY_LIMIT), url: commit.html_url, authorLogin: commit.author?.login ?? '', authorName: commit.commit.author?.name ?? '', date: commit.commit.author?.date ?? '' }));
    if (commitsToWrite.length) await graph.query(`UNWIND $rows AS row MATCH (r:Repository {fullName:$fullName})
      MERGE (commit:Commit {sha:row.sha}) SET commit += row MERGE (r)-[included:HAS_COMMIT]->(commit) SET included.authoredAt=row.date
      WITH commit,row WHERE row.authorLogin <> '' MATCH (person:Contributor {login:row.authorLogin})
      MERGE (person)-[authorship:AUTHORED]->(commit) SET authorship.authoredAt=row.date`, { params: { fullName: repository.full_name, rows: commitsToWrite } });

    const reviews = pullDetails.flatMap((detail) => detail.reviews.map((review) => ({ review, number: detail.number }))).filter((entry) => entry.review.user);
    if (reviews.length) await graph.query(`UNWIND $rows AS row
      MATCH (item:WorkItem {number:row.number,kind:'PR'}) MERGE (review:Review {id:row.id})
      SET review.state=row.state,review.body=row.body,review.url=row.url,review.submittedAt=row.submittedAt
      WITH item,review,row MATCH (person:Contributor {login:row.login})
      MERGE (person)-[submission:SUBMITTED]->(review) SET submission.state=row.state,submission.submittedAt=row.submittedAt
      MERGE (review)-[reviewLink:ON_PR]->(item) SET reviewLink.reviewUrl=row.url,reviewLink.submittedAt=row.submittedAt`, { params: { rows: reviews.map(({ review, number }) => ({ id: String(review.id), state: review.state, body: (review.body ?? '').slice(0, 3000), url: review.html_url, submittedAt: review.submitted_at ?? '', number, login: review.user!.login })) } });

    const changedFiles = pullDetails.flatMap((detail) => detail.files.map((file) => ({ file, number: detail.number })));
    if (changedFiles.length) await graph.query(`UNWIND $rows AS row
      MATCH (item:WorkItem {number:row.number,kind:'PR'}) MERGE (file:File {path:row.path,repository:$fullName})
      SET file.status=row.status,file.additions=row.additions,file.deletions=row.deletions,file.changes=row.changes,file.url=row.url
      MERGE (item)-[change:MODIFIES]->(file) SET change.status=row.status,change.additions=row.additions,change.deletions=row.deletions,change.changes=row.changes`, { params: { fullName: repository.full_name, rows: changedFiles.map(({ file, number }) => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes, url: file.blob_url ?? '', number })) } });

    const comments = [
      ...pullDetails.flatMap((detail) => detail.comments.map((comment) => ({ comment, number: detail.number, kind: 'PR' }))),
      ...issueDetails.flatMap((detail) => detail.comments.map((comment) => ({ comment, number: detail.number, kind: 'Issue' }))),
    ].filter((entry) => entry.comment.user);
    if (comments.length) await graph.query(`UNWIND $rows AS row
      MATCH (item:WorkItem {number:row.number,kind:row.kind}) MERGE (comment:Comment {id:row.id})
      SET comment.body=row.body,comment.url=row.url,comment.createdAt=row.createdAt,comment.updatedAt=row.updatedAt
      WITH item,comment,row MATCH (person:Contributor {login:row.login})
      MERGE (person)-[authored:WROTE]->(comment) SET authored.createdAt=row.createdAt
      MERGE (comment)-[context:ON_ITEM]->(item) SET context.kind=row.kind,context.createdAt=row.createdAt`, { params: { rows: comments.map(({ comment, number, kind }) => ({ id: String(comment.id), body: (comment.body ?? '').slice(0, 3000), url: comment.html_url, createdAt: comment.created_at, updatedAt: comment.updated_at ?? comment.created_at, number, kind, login: comment.user!.login })) } });

    // The index is intentionally bounded. Remove items that have fallen outside the newest-updated window.
    const workItemIds = workItems.map((item) => item.id);
    await graph.query(`MATCH (r:Repository {fullName:$fullName})-[:HAS_ITEM]->(item:WorkItem)
      WHERE NOT item.id IN $ids DETACH DELETE item`, { params: { fullName: repository.full_name, ids: workItemIds } });
    const commitShas = commitsToWrite.map((commit) => commit.sha);
    if(commitResult.available)await graph.query(`MATCH (r:Repository {fullName:$fullName})-[:HAS_COMMIT]->(commit:Commit)
      WHERE NOT commit.sha IN $shas DETACH DELETE commit`, { params: { fullName: repository.full_name, shas: commitShas } });
    await graph.query(`MATCH (file:File {repository:$fullName}) WHERE NOT (file)<-[:MODIFIES]-() DETACH DELETE file`, { params: { fullName: repository.full_name } });
    await graph.query('MATCH (review:Review) WHERE NOT (review)-[:ON_PR]->() DETACH DELETE review');
    await graph.query('MATCH (comment:Comment) WHERE NOT (comment)-[:ON_ITEM]->() DETACH DELETE comment');
    await graph.query('MATCH (person:Contributor) WHERE NOT (person)--() DETACH DELETE person');

    const response = NextResponse.json({ status: 'complete', repository: repository.full_name, syncedAt: importedAt, latestActivityAt,
      indexWindow: { pullRequests: ITEM_WINDOW, issues: ITEM_WINDOW, detailedPullRequests: DETAIL_WINDOW, detailedIssues: DETAIL_WINDOW },
      warnings: commitResult.available ? [] : ['Commit history was unavailable. Grant Contents: read to include commit activity.'],
      pulls: pulls.map(compact), issues: issues.map(compact), graph: privateGraphName(session.id, repository.full_name),
      imported: { people: people.length, pullRequests: pulls.length, issues: issues.length, commits: commits.length, reviews: reviews.length, comments: comments.length, files: changedFiles.length },
    });
    await setSession(response, { ...session, selectedRepo: repository.full_name }, new URL(request.url).protocol === 'https:');
    response.cookies.set('engram_onboarding_done', '1', { httpOnly: true, sameSite: 'lax', secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: 60 * 60 * 24 * 365 });
    return response;
  } catch (error) {
    console.error('GitHub repository sync failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Repository import failed.' }, { status: 503 });
  }
}
