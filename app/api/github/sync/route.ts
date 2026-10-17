import { NextResponse } from 'next/server';
import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
import { GithubApiError, githubApi, installationToken } from '@/lib/github-app';
import { privateGraphName, readSession, setSession } from '@/lib/github-session';
import { readRepositoryCache } from '@/lib/repository-cache';

export const runtime = 'nodejs';
const ITEM_WINDOW = 200;
const DETAIL_WINDOW = 50;
const BODY_LIMIT = 8_000;
const privateJson = (body: unknown, init?: ResponseInit) => {
  const response = NextResponse.json(body, init);
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
};
function cleanGraphParams(value:unknown):unknown {
  if(typeof value==='string')return value.replace(/[\r\n\t]+/g,' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');
  if(typeof value==='number'&&!Number.isFinite(value))return null;
  if(Array.isArray(value))return value.map(cleanGraphParams);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,entry])=>entry!==undefined).map(([key,entry])=>[key,cleanGraphParams(entry)]));
  return value;
}

type User = { id: number; login: string; html_url: string; avatar_url: string; type?: string };
type Pull = { id: number; number: number; title: string; body: string | null; state: string; user: User; assignees?:User[]; requested_reviewers?:User[]; labels?:{name:string}[]; html_url: string; created_at: string; updated_at: string; closed_at: string | null; merged_at: string | null; additions: number; deletions: number; changed_files: number; base: { ref: string }; head: { ref: string }; comments: number; review_comments: number };
type Issue = { id: number; number: number; title: string; body: string | null; state: string; user: User; assignees?:User[]; html_url: string; created_at: string; updated_at: string; closed_at: string | null; pull_request?: unknown; comments: number; labels: { name: string }[] };
type Commit = { sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } | null; committer?:{name:string;date:string}|null }; author: User | null; branchNames?:string[] };
type Branch = { name:string; commit:{sha:string} };
type ChangedFile = { filename: string; status: string; additions: number; deletions: number; changes: number; blob_url: string | null };
type Review = { id: number; user: User | null; state: string; body: string | null; html_url: string; submitted_at: string | null };
type Comment = { id: number; user: User | null; body: string | null; html_url: string; created_at: string; updated_at?: string };
type Repo = { full_name: string; name: string; html_url: string; description: string | null; default_branch: string; private: boolean; fork?:boolean; parent?:{full_name:string;name:string;html_url:string;description:string|null;default_branch:string;private:boolean} };

async function pages<T>(path: string, token?: string, max = ITEM_WINDOW): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; rows.length < max; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = await githubApi<T[]>(`${path}${separator}per_page=100&page=${page}`, token);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows.slice(0, max);
}
async function pagesMatching<T>(path:string,token:string|undefined,accept:(row:T)=>boolean,max=ITEM_WINDOW,maxPages=20):Promise<T[]>{
  const rows:T[]=[];
  for(let page=1;rows.length<max&&page<=maxPages;page+=1){
    const separator=path.includes('?')?'&':'?';
    const batch=await githubApi<T[]>(`${path}${separator}per_page=100&page=${page}`,token);
    rows.push(...batch.filter(accept));
    if(batch.length<100)break;
  }
  return rows.slice(0,max);
}
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let index = 0; index < items.length; index += size) output.push(...await Promise.all(items.slice(index, index + size).map(fn)));
  return output;
}
const compact = (item: { number: number; title: string; state: string; html_url: string; user: User; updated_at: string; comments: number }) => ({
  number: item.number, title: item.title, state: item.state, url: item.html_url, author: item.user?.login ?? 'unknown', updated_at: item.updated_at, comments: item.comments ?? 0,
});

export async function GET(){
  const session=await readSession();
  if(!session)return privateJson({error:'Sign in with GitHub before reading a private repository snapshot.'},{status:401});
  if(!session.selectedRepo)return privateJson({error:'Choose a repository before reading its snapshot.'},{status:409});
  if(!isFalkorConfigured())return privateJson({error:'FalkorDB is not configured.'},{status:503});
  try{const name=privateGraphName(session.id,session.selectedRepo);const snapshot=await readRepositoryCache(await getGraph(name),name,session.selectedRepo);return snapshot?privateJson({...snapshot,source:'falkordb-cache'}):privateJson({error:'No successful repository import is cached yet.'},{status:404})}
  catch(error){return privateJson({error:error instanceof Error?error.message:'Could not read the cached repository graph.'},{status:503})}
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const fullName = typeof body.repository === 'string' ? body.repository.trim() : '';
  const [owner, repoName] = fullName.split('/');
  if (!owner || !repoName || fullName.split('/').length !== 2 || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repoName)) {
    return privateJson({ error: 'Choose a repository in owner/name format.' }, { status: 400 });
  }
  const session = await readSession();
  if (!session) return privateJson({ error: 'Sign in with GitHub before importing a repository.' }, { status: 401 });
  if (!session.installationId) return privateJson({ error: 'Install Engram and grant access to a repository before importing it.' }, { status: 409 });
  if (!isFalkorConfigured()) return privateJson({ error: 'Add FALKORDB_URL before importing repository data.' }, { status: 503 });

  try {
    const graphName=privateGraphName(session.id,fullName);
    const rawGraph=await getGraph(graphName);
    // GitHub omits optional fields inconsistently and text often contains line
    // breaks. FalkorDB's parameter encoder rejects undefined nested fields and
    // raw control characters, so normalize them at the graph-write boundary.
    const graph={query:async(statement:string,options?:{params?:Record<string,unknown>})=>{
      try{return await rawGraph.query(statement,options?.params?{...options,params:cleanGraphParams(options.params) as Record<string,unknown>}:options)}
      catch(error){console.error('FalkorDB sync query failed:',statement,error);throw error}
    }};
    const token = await installationToken(session.installationId);
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
    const repository = await githubApi<Repo>(prefix, token);
    const upstream=repository.fork&&repository.parent&&!repository.parent.private?repository.parent:null;
    const sourceRepository=upstream?.full_name??repository.full_name;
    const priorGraphState=await graph.query(`MATCH (r:Repository {fullName:$fullName})-[:HAS_ITEM]->(item:WorkItem)
      RETURN item.number AS number,item.kind AS kind,item.sourceRepository AS sourceRepository,item.detailUpdatedAt AS detailUpdatedAt`,{params:{fullName}}) as {data?:{number:number;kind:string;sourceRepository?:string;detailUpdatedAt?:string}[]};
    const detailCursor=new Map((priorGraphState.data??[]).map(item=>[`${item.sourceRepository??repository.full_name}:${item.kind}:${item.number}`,String(item.detailUpdatedAt??'')]));
    const [sourceOwner,sourceName]=sourceRepository.split('/');
    const sourcePrefix=`/repos/${encodeURIComponent(sourceOwner)}/${encodeURIComponent(sourceName)}`;
    let sourceToken:string|undefined=token;
    if(upstream){
      try{await githubApi<Repo>(sourcePrefix,token)}
      catch(error){
        // A user installation may grant access to the fork but not its public
        // parent. Fall back to GitHub's public read API; never fall back on rate limits.
        if(error instanceof GithubApiError&&!error.rateLimited&&(error.status===403||error.status===404))sourceToken=undefined;
        else throw error;
      }
    }
    const [pulls, issueRows, defaultCommits, contributors, branchRows] = await Promise.all([
      pages<Pull>(`${sourcePrefix}/pulls?state=all&sort=updated&direction=desc`, sourceToken, ITEM_WINDOW),
      // GitHub's issues endpoint also returns pull requests. Keep paging after
      // filtering so a PR-heavy repo still imports a useful window of real issues.
      pagesMatching<Issue>(`${sourcePrefix}/issues?state=all&sort=updated&direction=desc`, sourceToken, item=>!item.pull_request, ITEM_WINDOW),
      // Contents:read is needed for this endpoint; if the app has not been granted it, keep syncing the rest.
      pages<Commit>(`${prefix}/commits?sha=${encodeURIComponent(repository.default_branch)}`, token, ITEM_WINDOW).then(rows=>({available:true,rows})).catch(() => ({available:false,rows:[] as Commit[]})),
      pages<User>(`${sourcePrefix}/contributors`, sourceToken, 100).catch(() => [] as User[]),
      pages<Branch>(`${prefix}/branches`,token,100).catch(()=>[] as Branch[]),
    ]);
    // The default branch can be weeks behind active feature branches. Fetch head
    // metadata for every visible branch, then import a bounded recent slice from
    // the twelve branches with newest commits. This catches live contributor
    // activity without walking every branch's full history or exhausting API quota.
    const branchHeads=await inBatches(branchRows,8,async branch=>{
      try {
        const head=await githubApi<Commit>(`${prefix}/commits/${encodeURIComponent(branch.commit.sha)}`,token);
        const date=head.commit.committer?.date??head.commit.author?.date??'';
        return {name:branch.name,sha:branch.commit.sha,date};
      } catch { return null; }
    });
    const activeBranches=branchHeads.filter((branch):branch is {name:string;sha:string;date:string}=>Boolean(branch)).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date)).slice(0,12);
    const branchCommitSets=await inBatches(activeBranches,4,async branch=>{
      try {
        const rows=await githubApi<Commit[]>(`${prefix}/commits?sha=${encodeURIComponent(branch.name)}&per_page=100`,token);
        return rows.slice(0,30).map(commit=>({...commit,branchNames:[branch.name]}));
      } catch { return [] as Commit[]; }
    });
    const commitsBySha=new Map<string,Commit>();
    for(const commit of [...defaultCommits.rows,...branchCommitSets.flat()]){
      const previous=commitsBySha.get(commit.sha);
      commitsBySha.set(commit.sha,{...previous,...commit,branchNames:Array.from(new Set([...(previous?.branchNames??[]),...(commit.branchNames??[repository.default_branch])]))});
    }
    const commits=Array.from(commitsBySha.values()).sort((a,b)=>Date.parse(b.commit.committer?.date??b.commit.author?.date??'')-Date.parse(a.commit.committer?.date??a.commit.author?.date??'')).slice(0,ITEM_WINDOW);
    const issues = issueRows;
    // Work item lists are fresh on every sync. Re-read details for the newest
    // updated items too: reviews/comments can change independently of the
    // activity fields we retain, and an old detail cursor could otherwise hide it.
    const detailedPulls=pulls.slice(0,DETAIL_WINDOW);
    const detailedIssues=issues.slice(0,DETAIL_WINDOW);
    const pullDetails = await inBatches(detailedPulls, 5, async (pr) => {
      const [reviews, reviewComments, issueComments, files] = await Promise.all([
        pages<Review>(`${sourcePrefix}/pulls/${pr.number}/reviews`, sourceToken, 200),
        pages<Comment>(`${sourcePrefix}/pulls/${pr.number}/comments`, sourceToken, 200),
        pages<Comment>(`${sourcePrefix}/issues/${pr.number}/comments`, sourceToken, 200),
        pages<ChangedFile>(`${sourcePrefix}/pulls/${pr.number}/files`, sourceToken, 300),
      ]);
      return { sourceRepository, number: pr.number, reviews, comments: [...reviewComments, ...issueComments], files };
    });
    const issueDetails = await inBatches(detailedIssues, 5, async (issue) => ({
      sourceRepository, number: issue.number, comments: await pages<Comment>(`${sourcePrefix}/issues/${issue.number}/comments`, sourceToken, 200),
    }));
    for(const item of detailedPulls)detailCursor.set(`${sourceRepository}:PR:${item.number}`,item.updated_at);
    for(const item of detailedIssues)detailCursor.set(`${sourceRepository}:Issue:${item.number}`,item.updated_at);

    const peopleByLogin = new Map<string, User>();
    const knownPeople = [
      {id:session.id,login:session.login,html_url:`https://github.com/${session.login}`,avatar_url:session.avatar},
      ...contributors, ...pulls.map((pr) => pr.user), ...issues.map((issue) => issue.user),
      ...pulls.flatMap((pr) => [...(pr.assignees??[]),...(pr.requested_reviewers??[])]),
      ...issues.flatMap((issue) => issue.assignees??[]),
      ...commits.map((commit) => commit.author).filter((user): user is User => Boolean(user)),
      ...pullDetails.flatMap((detail) => [...detail.reviews.map((review) => review.user), ...detail.comments.map((comment) => comment.user)]).filter((user): user is User => Boolean(user)),
      ...issueDetails.flatMap((detail) => detail.comments.map((comment) => comment.user)).filter((user): user is User => Boolean(user)),
    ];
    for (const person of knownPeople) if (person?.login) peopleByLogin.set(person.login, person);
    const latestActivityAt = [
      ...pulls.map((item) => item.updated_at),
      ...issues.map((item) => item.updated_at),
      ...commits.map((item) => item.commit.committer?.date??item.commit.author?.date),
      ...pullDetails.flatMap((detail) => [
        ...detail.reviews.map((review) => review.submitted_at),
        ...detail.comments.flatMap((comment) => [comment.created_at, comment.updated_at]),
      ]),
      ...issueDetails.flatMap((detail) => detail.comments.flatMap((comment) => [comment.created_at, comment.updated_at])),
    ].filter((date): date is string => Boolean(date)).sort().at(-1) ?? null;

    if(repository.full_name.toLowerCase()!==fullName.toLowerCase())return privateJson({error:'The selected repository name did not match the GitHub repository.'},{status:409});
    const importedAt = new Date().toISOString();
    await graph.query('MERGE (r:Repository {fullName:$fullName}) RETURN r.fullName AS fullName',{params:{fullName:repository.full_name}});

    const people = Array.from(peopleByLogin.values()).map((user) => ({ login: user.login, url: user.html_url, avatar: user.avatar_url, type: user.type ?? 'User' }));
    if (people.length) await graph.query('UNWIND $rows AS row MERGE (u:Contributor {login:row.login}) SET u += row', { params: { rows: people } });

    const workItems = [
      ...pulls.map((item) => ({ id: String(item.id), sourceRepository, kind: 'PR', number: item.number, title: item.title, body: (item.body ?? '').slice(0, BODY_LIMIT), state: item.state, url: item.html_url, author: item.user?.login ?? 'unknown', assigneeLogins:(item.assignees??[]).map(user=>user.login),requestedReviewerLogins:(item.requested_reviewers??[]).map(user=>user.login), linkedIssueNumbers:Array.from((item.body??'').matchAll(/\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)\b/gi),match=>Number(match[1])), createdAt: item.created_at, updatedAt: item.updated_at, closedAt: item.closed_at ?? '', mergedAt: item.merged_at ?? '', comments: item.comments + item.review_comments, base: item.base.ref, head: item.head.ref, additions: item.additions, deletions: item.deletions, changedFiles: item.changed_files, labels: (item.labels??[]).map(label=>label.name), detailUpdatedAt:detailCursor.get(`${sourceRepository}:PR:${item.number}`)??'' })),
      ...issues.map((item) => ({ id: String(item.id), sourceRepository, kind: 'Issue', number: item.number, title: item.title, body: (item.body ?? '').slice(0, BODY_LIMIT), state: item.state, url: item.html_url, author: item.user?.login ?? 'unknown', assigneeLogins:(item.assignees??[]).map(user=>user.login),requestedReviewerLogins:[],linkedIssueNumbers:[] as number[], createdAt: item.created_at, updatedAt: item.updated_at, closedAt: item.closed_at ?? '', mergedAt: '', comments: item.comments, base: '', head: '', additions: 0, deletions: 0, changedFiles: 0, labels: item.labels.map((label) => label.name),detailUpdatedAt:detailCursor.get(`${sourceRepository}:Issue:${item.number}`)??'' })),
    ];
    // Keep relationship payloads out of WorkItem properties. They are written
    // as graph edges below; FalkorDB's map update expression expects scalar
    // properties here and rejects nested lists on some server versions.
    const workItemRecords=workItems.map(({assigneeLogins,requestedReviewerLogins,linkedIssueNumbers,labels,...record})=>record);
    if (workItemRecords.length) await graph.query(`UNWIND $rows AS row
      MATCH (r:Repository {fullName:$fullName}) MERGE (item:WorkItem {id:row.id}) SET item += row
      MERGE (r)-[membership:HAS_ITEM]->(item) SET membership.lastSyncedAt=$importedAt
      WITH item,row MERGE (person:Contributor {login:row.author})
      MERGE (person)-[opened:OPENED]->(item) SET opened.createdAt=row.createdAt,opened.kind=row.kind`, { params: { fullName: repository.full_name, importedAt, rows: workItemRecords } });

    if(workItems.length) {
      await graph.query(`UNWIND $rows AS row MATCH (item:WorkItem {id:row.id})
        OPTIONAL MATCH (item)<-[old:ASSIGNED|REVIEW_REQUESTED]-() DELETE old`,{params:{rows:workItems}});
      await graph.query(`UNWIND $rows AS row MATCH (item:WorkItem {id:row.id})
        OPTIONAL MATCH (item)-[old:HAS_LABEL|CLOSES]->() DELETE old`,{params:{rows:workItems}});
    }
    const assignees=workItems.flatMap(item=>item.assigneeLogins.map(login=>({id:item.id,login})));
    if(assignees.length)await graph.query(`UNWIND $rows AS row MATCH (item:WorkItem {id:row.id})
      MATCH (person:Contributor {login:row.login}) MERGE (person)-[relationship:ASSIGNED]->(item)
      SET relationship.kind=item.kind,relationship.state=item.state`,{params:{rows:assignees}});
    const requestedReviewers=workItems.flatMap(item=>item.requestedReviewerLogins.map(login=>({id:item.id,login})));
    if(requestedReviewers.length)await graph.query(`UNWIND $rows AS row MATCH (item:WorkItem {id:row.id,kind:'PR'})
      MATCH (person:Contributor {login:row.login}) MERGE (person)-[relationship:REVIEW_REQUESTED]->(item)
      SET relationship.requestedAt=item.updatedAt`,{params:{rows:requestedReviewers}});
    const sourceRepositories=Array.from(new Set(workItems.map(item=>item.sourceRepository)));
    const labels=workItems.flatMap(item=>item.labels.map(name=>({id:item.id,name,sourceRepository:item.sourceRepository})));
    if(labels.length)await graph.query(`UNWIND $rows AS row MATCH (item:WorkItem {id:row.id})
      MERGE (label:RepositoryLabel {name:row.name,repository:row.sourceRepository})
      MERGE (item)-[relationship:HAS_LABEL]->(label) SET relationship.kind=item.kind`,{params:{rows:labels}});
    const linkedIssues=workItems.flatMap(item=>item.kind==='PR'?item.linkedIssueNumbers.map(number=>({id:item.id,number,sourceRepository:item.sourceRepository})):[]);
    if(linkedIssues.length)await graph.query(`UNWIND $rows AS row MATCH (pr:WorkItem {id:row.id,kind:'PR'}),(issue:WorkItem {number:row.number,kind:'Issue',sourceRepository:row.sourceRepository})
      MERGE (pr)-[relationship:CLOSES]->(issue) SET relationship.source='GitHub closing reference'`,{params:{rows:linkedIssues}});
    await graph.query('MATCH (label:RepositoryLabel) WHERE label.repository IN $sourceRepositories AND NOT (label)<-[:HAS_LABEL]-() DETACH DELETE label',{params:{sourceRepositories}});

    const commitsToWrite = commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message.slice(0, BODY_LIMIT), url: commit.html_url, authorLogin: commit.author?.login ?? '', authorName: commit.commit.author?.name ?? '', date: commit.commit.committer?.date??commit.commit.author?.date??'', authorDate:commit.commit.author?.date??'',branchNames:commit.branchNames??[repository.default_branch] }));
    if (commitsToWrite.length) await graph.query(`UNWIND $rows AS row MATCH (r:Repository {fullName:$fullName})
      MERGE (commit:Commit {sha:row.sha}) SET commit += row MERGE (r)-[included:HAS_COMMIT]->(commit) SET included.authoredAt=row.date
      WITH commit,row WHERE row.authorLogin <> '' MATCH (person:Contributor {login:row.authorLogin})
      MERGE (person)-[authorship:AUTHORED]->(commit) SET authorship.authoredAt=row.date`, { params: { fullName: repository.full_name, rows: commitsToWrite } });

    await graph.query('MATCH (repository:Repository {fullName:$fullName})-[:HAS_BRANCH]->(branch:RepositoryBranch) DETACH DELETE branch',{params:{fullName:repository.full_name}});
    if(activeBranches.length)await graph.query(`UNWIND $rows AS row MATCH (repository:Repository {fullName:$fullName})
      MERGE (branch:RepositoryBranch {name:row.name,repository:$fullName}) SET branch.headSha=row.sha,branch.latestCommitAt=row.date
      MERGE (repository)-[:HAS_BRANCH]->(branch)`,{params:{fullName:repository.full_name,rows:activeBranches}});
    const commitBranches=commitsToWrite.flatMap(commit=>commit.branchNames.map(name=>({sha:commit.sha,name})));
    if(commitBranches.length)await graph.query(`UNWIND $rows AS row MATCH (commit:Commit {sha:row.sha})
      MERGE (branch:RepositoryBranch {name:row.name,repository:$fullName}) MERGE (commit)-[relationship:ON_BRANCH]->(branch)`,{params:{fullName:repository.full_name,rows:commitBranches}});

    const reviews = pullDetails.flatMap((detail) => detail.reviews.map((review) => ({ review, number: detail.number, sourceRepository:detail.sourceRepository }))).filter((entry) => entry.review.user);
    if (reviews.length) await graph.query(`UNWIND $rows AS row
      MATCH (item:WorkItem {number:row.number,kind:'PR',sourceRepository:row.sourceRepository}) MERGE (review:Review {id:row.id})
      SET review.state=row.state,review.body=row.body,review.url=row.url,review.submittedAt=row.submittedAt
      WITH item,review,row MATCH (person:Contributor {login:row.login})
      MERGE (person)-[submission:SUBMITTED]->(review) SET submission.state=row.state,submission.submittedAt=row.submittedAt
      MERGE (review)-[reviewLink:ON_PR]->(item) SET reviewLink.reviewUrl=row.url,reviewLink.submittedAt=row.submittedAt`, { params: { rows: reviews.map(({ review, number, sourceRepository }) => ({ id: String(review.id), state: review.state, body: (review.body ?? '').slice(0, 3000), url: review.html_url, submittedAt: review.submitted_at ?? '', number, sourceRepository, login: review.user!.login })) } });

    const changedFiles = pullDetails.flatMap((detail) => detail.files.map((file) => ({ file, number: detail.number, sourceRepository:detail.sourceRepository })));
    if (changedFiles.length) await graph.query(`UNWIND $rows AS row
      MATCH (item:WorkItem {number:row.number,kind:'PR',sourceRepository:row.sourceRepository}) MERGE (file:File {path:row.path,repository:row.sourceRepository})
      SET file.status=row.status,file.additions=row.additions,file.deletions=row.deletions,file.changes=row.changes,file.url=row.url
      MERGE (item)-[change:MODIFIES]->(file) SET change.status=row.status,change.additions=row.additions,change.deletions=row.deletions,change.changes=row.changes`, { params: { rows: changedFiles.map(({ file, number, sourceRepository }) => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes, url: file.blob_url ?? '', number, sourceRepository })) } });

    const comments = [
      ...pullDetails.flatMap((detail) => detail.comments.map((comment) => ({ comment, number: detail.number, kind: 'PR', sourceRepository:detail.sourceRepository }))),
      ...issueDetails.flatMap((detail) => detail.comments.map((comment) => ({ comment, number: detail.number, kind: 'Issue', sourceRepository:detail.sourceRepository }))),
    ].filter((entry) => entry.comment.user);
    if (comments.length) await graph.query(`UNWIND $rows AS row
      MATCH (item:WorkItem {number:row.number,kind:row.kind,sourceRepository:row.sourceRepository}) MERGE (comment:Comment {id:row.id})
      SET comment.body=row.body,comment.url=row.url,comment.createdAt=row.createdAt,comment.updatedAt=row.updatedAt
      WITH item,comment,row MATCH (person:Contributor {login:row.login})
      MERGE (person)-[authored:WROTE]->(comment) SET authored.createdAt=row.createdAt
      MERGE (comment)-[context:ON_ITEM]->(item) SET context.kind=row.kind,context.createdAt=row.createdAt`, { params: { rows: comments.map(({ comment, number, kind, sourceRepository }) => ({ id: String(comment.id), body: (comment.body ?? '').slice(0, 3000), url: comment.html_url, createdAt: comment.created_at, updatedAt: comment.updated_at ?? comment.created_at, number, kind, sourceRepository, login: comment.user!.login })) } });

    for(const [relationship,label,kind,property] of [
      ['OPENED','WorkItem','PR','pullRequestsOpened'],['OPENED','WorkItem','Issue','issuesOpened'],
    ] as const){
      await graph.query(`MATCH (person:Contributor) OPTIONAL MATCH (person)-[:${relationship}]->(item:${label} {kind:$kind}) WITH person,count(DISTINCT item) AS total SET person.${property}=total`,{params:{kind}});
    }
    await graph.query('MATCH (person:Contributor) OPTIONAL MATCH (person)-[:SUBMITTED]->(review:Review) WITH person,count(DISTINCT review) AS total SET person.reviewsSubmitted=total');
    await graph.query('MATCH (person:Contributor) OPTIONAL MATCH (person)-[:WROTE]->(comment:Comment) WITH person,count(DISTINCT comment) AS total SET person.commentsWritten=total');
    await graph.query('MATCH (person:Contributor) OPTIONAL MATCH (person)-[:AUTHORED]->(commit:Commit) WITH person,count(DISTINCT commit) AS total SET person.commitsAuthored=total');

    // The index is intentionally bounded. Remove items that have fallen outside the newest-updated window.
    const workItemIds = workItems.map((item) => item.id);
    await graph.query(`MATCH (r:Repository {fullName:$fullName})-[:HAS_ITEM]->(item:WorkItem)
      WHERE NOT item.id IN $ids DETACH DELETE item`, { params: { fullName: repository.full_name, ids: workItemIds } });
    const commitShas = commitsToWrite.map((commit) => commit.sha);
    if(defaultCommits.available)await graph.query(`MATCH (r:Repository {fullName:$fullName})-[:HAS_COMMIT]->(commit:Commit)
      WHERE NOT commit.sha IN $shas DETACH DELETE commit`, { params: { fullName: repository.full_name, shas: commitShas } });
    await graph.query(`MATCH (file:File) WHERE file.repository IN $sourceRepositories AND NOT (file)<-[:MODIFIES]-() DETACH DELETE file`, { params: { sourceRepositories } });
    await graph.query('MATCH (review:Review) WHERE NOT (review)-[:ON_PR]->() DETACH DELETE review');
    await graph.query('MATCH (comment:Comment) WHERE NOT (comment)-[:ON_ITEM]->() DETACH DELETE comment');
    await graph.query('MATCH (person:Contributor) WHERE NOT (person)--() DETACH DELETE person');
    await graph.query('MATCH (r:Repository {fullName:$fullName}) SET r += $properties,r.indexedReviews=$reviews,r.indexedFiles=$files,r.indexedComments=$comments,r.indexedContributors=$contributors', { params:{
      fullName:repository.full_name,reviews:reviews.length,files:changedFiles.length,comments:comments.length,contributors:people.length,
      properties:{fullName:repository.full_name,name:repository.name,url:repository.html_url,description:repository.description??'',defaultBranch:repository.default_branch,private:repository.private,upstreamRepository:sourceRepository!==repository.full_name?sourceRepository:'',importedAt,lastSyncedAt:importedAt,latestActivityAt,indexedPullRequests:pulls.length,indexedIssues:issues.length,indexedCommits:commits.length,indexedBranches:activeBranches.length},
    } });

    const response = privateJson({ status: 'complete', source:'github-live', repository: repository.full_name, upstreamRepository:sourceRepository!==repository.full_name?sourceRepository:null, syncedAt: importedAt, latestActivityAt,
      indexWindow: { pullRequests: ITEM_WINDOW, issues: ITEM_WINDOW, detailedPullRequests: DETAIL_WINDOW, detailedIssues: DETAIL_WINDOW },
      detailCoverage:{refreshedPullRequests:detailedPulls.length,refreshedIssues:detailedIssues.length,scope:'most recently updated items'},
      warnings: defaultCommits.available ? [] : ['Commit history was unavailable. Grant Contents: read to include commit activity.'],
      pulls: pulls.map(compact), issues: issues.map(compact), commits:commitsToWrite, graph: privateGraphName(session.id, repository.full_name),
      imported: { people: people.length, pullRequests: pulls.length, issues: issues.length, commits: commits.length, branches:activeBranches.length,reviews: reviews.length, comments: comments.length, files: changedFiles.length },
    });
    await setSession(response, { ...session, selectedRepo: repository.full_name }, new URL(request.url).protocol === 'https:');
    return response;
  } catch (error) {
    console.error('GitHub repository sync failed:', error);
    if (error instanceof GithubApiError && error.rateLimited) {
      const retrySeconds = Math.max(1, Math.ceil((Date.parse(error.retryAt ?? '') - Date.now()) / 1000) || 60);
      return privateJson({
        error: 'GitHub has temporarily limited repository reads. The last successful graph snapshot is still available; retry after the supplied time.',
        code: 'GITHUB_RATE_LIMITED', retryAt: error.retryAt, retryAfterSeconds: retrySeconds,
      }, { status: 429, headers: { 'Retry-After': String(retrySeconds) } });
    }
    if (error instanceof GithubApiError) {
      return privateJson({ error: error.message, code: 'GITHUB_API_ERROR', upstreamStatus: error.status }, { status: 502 });
    }
    return privateJson({ error: error instanceof Error ? error.message : 'Repository import failed.' }, { status: 503 });
  }
}
