import { NextResponse } from 'next/server';
import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
import { githubApi, installationToken } from '@/lib/github-app';

type User = { id:number; login:string; html_url:string; avatar_url:string; type?:string };
type Pull = { id:number; number:number; title:string; body:string|null; state:string; user:User; html_url:string; created_at:string; updated_at:string; merged_at:string|null; additions:number; deletions:number; changed_files:number; base:{ref:string}; head:{ref:string} };
type Issue = { id:number; number:number; title:string; body:string|null; state:string; user:User; html_url:string; created_at:string; updated_at:string; pull_request?:unknown; comments:number; labels:{name:string}[] };
type Commit = { sha:string; html_url:string; commit:{message:string;author:{name:string;date:string}|null}; author:User|null };
type ChangedFile = { filename:string; status:string; additions:number; deletions:number; changes:number; blob_url:string|null };
type Review = { id:number; user:User|null; state:string; body:string|null; html_url:string; submitted_at:string|null };
type Comment = { id:number; user:User|null; body:string|null; html_url:string; created_at:string; issue_url?:string; pull_request_url?:string };
const headers = { 'X-GitHub-Api-Version':'2022-11-28' };
async function pages<T>(path:string,token:string,max=200):Promise<T[]> { const rows:T[]=[]; for(let page=1;rows.length<max;page++){const batch=await githubApi<T[]>(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`,token);rows.push(...batch);if(batch.length<100)break;}return rows.slice(0,max); }
async function chunks<T,R>(items:T[],size:number,fn:(item:T)=>Promise<R>):Promise<R[]> { const all:R[]=[];for(let i=0;i<items.length;i+=size)all.push(...await Promise.all(items.slice(i,i+size).map(fn)));return all; }
export async function POST(request:Request) {
  const body=await request.json().catch(()=>({})); const fullName=typeof body.repository==='string'?body.repository:''; const [owner,repo]=fullName.split('/');
  if(!owner||!repo||fullName.split('/').length!==2) return NextResponse.json({error:'Choose a repository in owner/name format.'},{status:400});
  if(!isFalkorConfigured()) return NextResponse.json({error:'Add FALKORDB_URL before importing repository data.'},{status:503});
  try {
    const token=await installationToken(); const prefix=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const repository=await githubApi<{full_name:string;name:string;html_url:string;description:string|null;default_branch:string;private:boolean}>(prefix,token);
    const [pulls,issues,commits,contributors]=await Promise.all([
      pages<Pull>(`${prefix}/pulls?state=all`,token,200), pages<Issue>(`${prefix}/issues?state=all`,token,200).then(rows=>rows.filter(row=>!row.pull_request)),
      pages<Commit>(`${prefix}/commits`,token,200), pages<User>(`${prefix}/contributors`,token,100)
    ]);
    const recentPulls=pulls.slice(0,50);
    const pullDetails=await chunks(recentPulls,5,async pr=>{
      const [reviews,reviewComments,issueComments,files]=await Promise.all([
        githubApi<Review[]>(`${prefix}/pulls/${pr.number}/reviews?per_page=100`,token),
        githubApi<Comment[]>(`${prefix}/pulls/${pr.number}/comments?per_page=100`,token),
        githubApi<Comment[]>(`${prefix}/issues/${pr.number}/comments?per_page=100`,token),
        githubApi<ChangedFile[]>(`${prefix}/pulls/${pr.number}/files?per_page=100`,token)
      ]);
      return {number:pr.number,reviews,comments:[...reviewComments,...issueComments],files};
    });
    const issueDetails=await chunks(issues.slice(0,50),5,async issue=>({number:issue.number,comments:await githubApi<Comment[]>(`${prefix}/issues/${issue.number}/comments?per_page=100`,token)}));
    const peopleByLogin=new Map<string,User>();
    for(const person of contributors)peopleByLogin.set(person.login,person);
    for(const person of [...pulls.map(p=>p.user),...issues.map(i=>i.user),...commits.map(c=>c.author).filter((u):u is User=>Boolean(u)),...pullDetails.flatMap(d=>[...d.reviews.map(r=>r.user),...d.comments.map(c=>c.user)].filter((u):u is User=>Boolean(u)))]) peopleByLogin.set(person.login,person);
    const graph=await getGraph('engram_company');
    const common={fullName:repository.full_name,name:repository.name,url:repository.html_url,description:repository.description??'',defaultBranch:repository.default_branch,private:repository.private};
    await graph.query('MERGE (r:Repository {fullName:$fullName}) SET r += $properties',{params:{fullName:repository.full_name,properties:common}});
    const people=Array.from(peopleByLogin.values()).map(u=>({login:u.login,url:u.html_url,avatar:u.avatar_url,type:u.type??'User'}));
    if(people.length)await graph.query('UNWIND $rows AS row MERGE (u:User {login:row.login}) SET u += row',{params:{rows:people}});
    const pullRows=pulls.map(p=>({id:String(p.id),number:p.number,title:p.title,body:p.body??'',state:p.state,url:p.html_url,createdAt:p.created_at,updatedAt:p.updated_at,mergedAt:p.merged_at??'',author:p.user.login,base:p.base.ref,head:p.head.ref,additions:p.additions,deletions:p.deletions,changedFiles:p.changed_files}));
    if(pullRows.length)await graph.query('UNWIND $rows AS row MATCH (r:Repository {fullName:$fullName}) MERGE (p:PR {id:row.id}) SET p += row MERGE (r)-[:HAS_PR]->(p) WITH p,row MATCH (u:User {login:row.author}) MERGE (u)-[:OPENED]->(p)',{params:{fullName:repository.full_name,rows:pullRows}});
    const issueRows=issues.map(i=>({id:String(i.id),number:i.number,title:i.title,body:i.body??'',state:i.state,url:i.html_url,createdAt:i.created_at,updatedAt:i.updated_at,author:i.user.login,labels:i.labels.map(l=>l.name),comments:i.comments}));
    if(issueRows.length)await graph.query('UNWIND $rows AS row MATCH (r:Repository {fullName:$fullName}) MERGE (i:Issue {id:row.id}) SET i += row MERGE (r)-[:HAS_ISSUE]->(i) WITH i,row MATCH (u:User {login:row.author}) MERGE (u)-[:OPENED]->(i)',{params:{fullName:repository.full_name,rows:issueRows}});
    const commitRows=commits.map(c=>({sha:c.sha,message:c.commit.message,url:c.html_url,author:c.author?.login??c.commit.author?.name??'unknown',date:c.commit.author?.date??''}));
    if(commitRows.length)await graph.query('UNWIND $rows AS row MATCH (r:Repository {fullName:$fullName}) MERGE (c:Commit {sha:row.sha}) SET c += row MERGE (r)-[:HAS_COMMIT]->(c)',{params:{fullName:repository.full_name,rows:commitRows}});
    const allReviews=pullDetails.flatMap(d=>d.reviews.map(review=>({...review,pullNumber:d.number}))).filter(review=>review.user);
    if(allReviews.length)await graph.query('UNWIND $rows AS row MATCH (p:PR {number:row.pullNumber}) MERGE (v:Review {id:toString(row.id)}) SET v.state=row.state,v.body=row.body,v.url=row.url,v.submittedAt=row.submittedAt WITH p,v,row MATCH (u:User {login:row.login}) MERGE (u)-[:SUBMITTED]->(v)-[:ON_PR]->(p)',{params:{rows:allReviews.map(r=>({id:r.id,state:r.state,body:r.body??'',url:r.html_url,submittedAt:r.submitted_at??'',pullNumber:r.pullNumber,login:r.user!.login}))}});
    const allComments=pullDetails.flatMap(d=>d.comments.map(comment=>({...comment,pullNumber:d.number}))).filter(comment=>comment.user);
    const issueComments=issueDetails.flatMap(d=>d.comments.map(comment=>({...comment,issueNumber:d.number}))).filter(comment=>comment.user);
    const changedFiles=pullDetails.flatMap(d=>d.files.map(file=>({...file,pullNumber:d.number})));
    if(changedFiles.length)await graph.query('UNWIND $rows AS row MATCH (p:PR {number:row.pullNumber}) MERGE (f:File {path:row.path, repository:$fullName}) SET f.status=row.status,f.additions=row.additions,f.deletions=row.deletions,f.changes=row.changes,f.url=row.url MERGE (p)-[:MODIFIES]->(f)',{params:{fullName:repository.full_name,rows:changedFiles.map(f=>({path:f.filename,status:f.status,additions:f.additions,deletions:f.deletions,changes:f.changes,url:f.blob_url??'',pullNumber:f.pullNumber}))}});
    if(issueComments.length)await graph.query('UNWIND $rows AS row MATCH (i:Issue {number:row.issueNumber}) MERGE (c:Comment {id:toString(row.id)}) SET c.body=row.body,c.url=row.url,c.createdAt=row.createdAt WITH i,c,row MATCH (u:User {login:row.login}) MERGE (u)-[:WROTE]->(c)-[:ON_ISSUE]->(i)',{params:{rows:issueComments.map(c=>({id:c.id,body:c.body??'',url:c.html_url,createdAt:c.created_at,issueNumber:c.issueNumber,login:c.user!.login}))}});
    if(allComments.length)await graph.query('UNWIND $rows AS row MATCH (p:PR {number:row.pullNumber}) MERGE (c:Comment {id:toString(row.id)}) SET c.body=row.body,c.url=row.url,c.createdAt=row.createdAt WITH p,c,row MATCH (u:User {login:row.login}) MERGE (u)-[:WROTE]->(c)-[:ON_PR]->(p)',{params:{rows:allComments.map(c=>({id:c.id,body:c.body??'',url:c.html_url,createdAt:c.created_at,pullNumber:c.pullNumber,login:c.user!.login}))}});
    const response=NextResponse.json({status:'complete',repository:repository.full_name,imported:{people:people.length,pullRequests:pullRows.length,issues:issueRows.length,commits:commitRows.length,reviews:allReviews.length,comments:allComments.length+issueComments.length,files:changedFiles.length},limits:{pullRequests:200,issues:200,commits:200,reviewDetailsFor:50,issueCommentDetailsFor:50}});
    response.cookies.set('engram_onboarding_done','1',{httpOnly:true,sameSite:'lax',secure:request.url.startsWith('https:'),path:'/',maxAge:60*60*24*365});
    return response;
  }catch(error){console.error('GitHub repository sync failed:',error);const message=error instanceof Error?error.message:'Repository import failed.';return NextResponse.json({error:message},{status:503});}
}
