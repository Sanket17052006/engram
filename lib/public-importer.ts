import { getGraph } from '@/lib/falkordb';
import { guestGraphName, githubPublicGet, requirePublicRepository, type PublicRepository } from '@/lib/public-github';
import { readRepositoryCache } from '@/lib/repository-cache';

type GithubUser = { login:string; html_url:string; avatar_url?:string; type?:string };
type GithubItem = { id:number; number:number; title:string; body:string|null; state:string; html_url:string; user:GithubUser|null; created_at:string; updated_at:string; closed_at:string|null; merged_at?:string|null; comments:number; assignees?:GithubUser[]; requested_reviewers?:GithubUser[]; labels?:{name:string}[]; base?:{ref:string}; head?:{ref:string}; additions?:number; deletions?:number; changed_files?:number; review_comments?:number; pull_request?:unknown };
type GithubCommit = {sha:string;html_url:string;commit:{message:string;author:{name:string;date:string}|null;committer?:{date:string}|null};author:GithubUser|null};
type GithubReview = {id:number;user:GithubUser|null;state:string;body:string|null;html_url:string;submitted_at:string|null};
type GithubComment = {id:number;user:GithubUser|null;body:string|null;html_url:string;created_at:string;updated_at?:string};
type GithubFile = {filename:string;status:string;additions:number;deletions:number;changes:number;blob_url:string|null};
type Row=Record<string,unknown>;
const bodyLimit=1800;
async function list<T>(path:string, perPage=30):Promise<T[]>{return githubPublicGet<T[]>(`${path}${path.includes('?')?'&':'?'}per_page=${perPage}&page=1`)}
const scalar=(value:unknown)=>value==null?'':String(value);

export async function readPublicSnapshot(repository:string){
  const graphName=guestGraphName(repository);
  const snapshot=await readRepositoryCache(await getGraph(graphName),graphName,repository);
  return snapshot;
}

export async function importPublicRepository(repository:string){
  const details=await requirePublicRepository(repository);
  const upstream=details.fork&&details.parent&&!details.parent.private?details.parent:null;
  const sourceRepo=upstream?.full_name??details.full_name;
  const [owner,name]=sourceRepo.split('/');
  const prefix=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const repoPrefix=`/repos/${encodeURIComponent(details.full_name.split('/')[0])}/${encodeURIComponent(details.full_name.split('/')[1])}`;
  const graphName=guestGraphName(details.full_name);
  const graph=await getGraph(graphName);
  const [pulls,issueRows,commits,contributors,branches]=await Promise.all([
    list<GithubItem>(`${prefix}/pulls?state=all&sort=updated&direction=desc`,30),
    list<GithubItem>(`${prefix}/issues?state=all&sort=updated&direction=desc`,30),
    list<GithubCommit>(`${repoPrefix}/commits`,40).catch(()=>[]),
    list<GithubUser>(`${prefix}/contributors`,30).catch(()=>[]),
    list<{name:string;commit:{sha:string}}>(`${repoPrefix}/branches`,30).catch(()=>[]),
  ]);
  const issues=issueRows.filter(item=>!item.pull_request);
  const detailedPulls=pulls.slice(0,5);
  const detailsByPull=await Promise.all(detailedPulls.map(async pull=>{
    const [reviews,reviewComments,comments,files]=await Promise.all([
      list<GithubReview>(`${prefix}/pulls/${pull.number}/reviews`,100).catch(()=>[]),
      list<GithubComment>(`${prefix}/pulls/${pull.number}/comments`,100).catch(()=>[]),
      list<GithubComment>(`${prefix}/issues/${pull.number}/comments`,100).catch(()=>[]),
      list<GithubFile>(`${prefix}/pulls/${pull.number}/files`,100).catch(()=>[]),
    ]);
    return {pull,reviews,comments:[...reviewComments,...comments],files};
  }));
  const detailedIssues=await Promise.all(issues.slice(0,3).map(async issue=>({issue,comments:await list<GithubComment>(`${prefix}/issues/${issue.number}/comments`,100).catch(()=>[])})));
  const allUsers=[...contributors,...pulls.map(x=>x.user),...issues.map(x=>x.user),...pulls.flatMap(x=>[...(x.assignees??[]),...(x.requested_reviewers??[])]),...commits.map(x=>x.author),...detailsByPull.flatMap(x=>[...x.reviews.map(y=>y.user),...x.comments.map(y=>y.user)]),...detailedIssues.flatMap(x=>x.comments.map(y=>y.user))].filter((x):x is GithubUser=>Boolean(x?.login));
  const people=new Map(allUsers.map(user=>[user.login,user]));
  const importedAt=new Date().toISOString();
  await graph.query('MERGE (r:Repository {fullName:$fullName}) RETURN r.fullName AS fullName',{params:{fullName:details.full_name}});
  await graph.query(`MATCH (r:Repository {fullName:$fullName}) SET r.name=$name,r.url=$url,r.description=$description,r.defaultBranch=$defaultBranch,r.private=false,r.upstreamRepository=$upstream,r.importedAt=$importedAt,r.latestActivityAt=$latestActivityAt,r.indexedPullRequests=$pullCount,r.indexedIssues=$issueCount,r.indexedReviews=$reviewCount,r.indexedFiles=$fileCount,r.indexedComments=$commentCount,r.indexedCommits=$commitCount,r.indexedBranches=$branchCount,r.indexedContributors=$contributorCount`,{params:{fullName:details.full_name,name:details.name,url:details.html_url,description:details.description??'',defaultBranch:details.default_branch,upstream:upstream?.full_name??'',importedAt,latestActivityAt:[...pulls,...issues].map(x=>x.updated_at).sort().at(-1)??commits[0]?.commit.committer?.date??null,pullCount:pulls.length,issueCount:issues.length,reviewCount:detailsByPull.reduce((n,x)=>n+x.reviews.length,0),fileCount:detailsByPull.reduce((n,x)=>n+x.files.length,0),commentCount:detailsByPull.reduce((n,x)=>n+x.comments.length,0)+detailedIssues.reduce((n,x)=>n+x.comments.length,0),commitCount:commits.length,branchCount:branches.length,contributorCount:people.size}});
  const peopleRows=Array.from(people.values()).map(user=>({login:user.login,url:user.html_url,avatar:user.avatar_url??'',type:user.type??'User'}));
  for(let i=0;i<peopleRows.length;i+=100) await graph.query(`UNWIND $rows AS row MATCH (r:Repository {fullName:$fullName}) MERGE (u:Contributor {login:row.login}) SET u.url=row.url,u.avatar=row.avatar,u.type=row.type MERGE (r)-[seen:HAS_CONTRIBUTOR]->(u) SET seen.source='public GitHub activity'`,{params:{fullName:details.full_name,rows:peopleRows.slice(i,i+100)}});
  const workItems=[...pulls.map(item=>({kind:'PR',item,sourceRepository:sourceRepo})),...issues.map(item=>({kind:'Issue',item,sourceRepository:sourceRepo}))];
  const itemRows=workItems.map(({kind,item,sourceRepository})=>({id:String(item.id),sourceRepository,kind,number:item.number,title:item.title,body:(item.body??'').slice(0,bodyLimit),state:item.state,url:item.html_url,author:item.user?.login??'unknown',createdAt:item.created_at,updatedAt:item.updated_at,closedAt:item.closed_at??'',mergedAt:item.merged_at??'',comments:(item.comments??0)+(item.review_comments??0),base:item.base?.ref??'',head:item.head?.ref??'',additions:item.additions??0,deletions:item.deletions??0,changedFiles:item.changed_files??0}));
  for(let i=0;i<itemRows.length;i+=100) await graph.query(`UNWIND $rows AS row MATCH (r:Repository {fullName:$fullName}) MERGE (item:WorkItem {id:row.id}) SET item += row MERGE (r)-[:HAS_ITEM]->(item) WITH item,row MATCH (person:Contributor {login:row.author}) MERGE (person)-[:OPENED]->(item)`,{params:{fullName:details.full_name,rows:itemRows.slice(i,i+100)}});
  const extras=workItems.flatMap(({item,kind})=>(item.assignees??[]).map(user=>({login:user.login,number:item.number,kind})));
  if(extras.length) await graph.query('UNWIND $rows AS row MATCH (person:Contributor {login:row.login}),(item:WorkItem {number:row.number,kind:row.kind}) MERGE (person)-[r:ASSIGNED]->(item) SET r.kind=row.kind',{params:{rows:extras}});
  const requested=workItems.flatMap(({item})=>(item.requested_reviewers??[]).map(user=>({login:user.login,number:item.number})));
  if(requested.length)await graph.query('UNWIND $rows AS row MATCH (person:Contributor {login:row.login}),(item:WorkItem {number:row.number,kind:"PR"}) MERGE (person)-[:REVIEW_REQUESTED]->(item)',{params:{rows:requested}});
  const labels=workItems.flatMap(({kind,item,sourceRepository})=>(item.labels??[]).map(label=>({id:String(item.id),name:label.name,sourceRepository,kind})));
  if(labels.length)await graph.query('UNWIND $rows AS row MATCH (item:WorkItem {id:row.id}) MERGE (label:RepositoryLabel {name:row.name,repository:row.sourceRepository}) MERGE (item)-[r:HAS_LABEL]->(label) SET r.kind=row.kind',{params:{rows:labels}});
  const commitRows=commits.map(commit=>({sha:commit.sha,message:commit.commit.message.slice(0,bodyLimit),url:commit.html_url,authorLogin:commit.author?.login??'',authorName:commit.commit.author?.name??'',date:commit.commit.committer?.date??commit.commit.author?.date??''}));
  if(commitRows.length)await graph.query(`UNWIND $rows AS row MATCH (r:Repository {fullName:$fullName}) MERGE (c:Commit {sha:row.sha}) SET c += row MERGE (r)-[:HAS_COMMIT]->(c) WITH c,row WHERE row.authorLogin <> '' MATCH (p:Contributor {login:row.authorLogin}) MERGE (p)-[:AUTHORED]->(c)`,{params:{fullName:details.full_name,rows:commitRows}});
  const branchRows=branches.map(branch=>({name:branch.name,repository:details.full_name,headSha:branch.commit.sha}));
  if(branchRows.length)await graph.query(`UNWIND $rows AS row MATCH (r:Repository {fullName:$fullName}) MERGE (b:RepositoryBranch {name:row.name,repository:row.repository}) SET b.headSha=row.headSha MERGE (r)-[:HAS_BRANCH]->(b)`,{params:{fullName:details.full_name,rows:branchRows}});
  const reviewRows=detailsByPull.flatMap(({pull,reviews})=>reviews.filter(review=>review.user).map(review=>({id:String(review.id),state:review.state,body:(review.body??'').slice(0,bodyLimit),url:review.html_url,submittedAt:review.submitted_at??'',login:review.user!.login,number:pull.number,sourceRepository:sourceRepo})));
  if(reviewRows.length)await graph.query(`UNWIND $rows AS row MATCH (person:Contributor {login:row.login}),(item:WorkItem {number:row.number,kind:'PR'}) MERGE (review:Review {id:row.id}) SET review.state=row.state,review.body=row.body,review.url=row.url,review.submittedAt=row.submittedAt MERGE (person)-[:SUBMITTED]->(review) MERGE (review)-[:ON_PR]->(item)`,{params:{rows:reviewRows}});
  const fileRows=detailsByPull.flatMap(({pull,files})=>files.map(file=>({path:file.filename,status:file.status,additions:file.additions,deletions:file.deletions,changes:file.changes,url:file.blob_url??'',number:pull.number,sourceRepository:sourceRepo})));
  if(fileRows.length)await graph.query(`UNWIND $rows AS row MATCH (item:WorkItem {number:row.number,kind:'PR'}) MERGE (file:File {path:row.path,repository:row.sourceRepository}) SET file.status=row.status,file.additions=row.additions,file.deletions=row.deletions,file.changes=row.changes,file.url=row.url MERGE (item)-[:MODIFIES]->(file)`,{params:{rows:fileRows}});
  const commentRows=[...detailsByPull.flatMap(({pull,comments})=>comments.map(comment=>({...comment,number:pull.number,sourceRepository:sourceRepo}))),...detailedIssues.flatMap(({issue,comments})=>comments.map(comment=>({...comment,number:issue.number,sourceRepository:sourceRepo})))].filter(comment=>comment.user).map(comment=>({id:String(comment.id),body:(comment.body??'').slice(0,bodyLimit),url:comment.html_url,createdAt:comment.created_at,updatedAt:comment.updated_at??'',login:comment.user!.login,number:comment.number,sourceRepository:comment.sourceRepository}));
  if(commentRows.length)await graph.query(`UNWIND $rows AS row MATCH (person:Contributor {login:row.login}),(item:WorkItem {number:row.number}) MERGE (comment:Comment {id:row.id}) SET comment.body=row.body,comment.url=row.url,comment.createdAt=row.createdAt,comment.updatedAt=row.updatedAt MERGE (person)-[:WROTE]->(comment) MERGE (comment)-[:ON_ITEM]->(item)`,{params:{rows:commentRows}});
  return {repository:details.full_name,upstreamRepository:upstream?.full_name??null,pulls:pulls.map(item=>({number:item.number,title:item.title,state:item.merged_at?'merged':item.state,url:item.html_url,author:item.user?.login??'unknown',comments:item.comments??0,updated_at:item.updated_at})),issues:issues.map(item=>({number:item.number,title:item.title,state:item.state,url:item.html_url,author:item.user?.login??'unknown',comments:item.comments??0,updated_at:item.updated_at})),commits:commitRows.map(item=>({sha:item.sha,message:item.message,url:item.url,authorLogin:item.authorLogin,authorName:item.authorName,date:item.date})),graph:graphName,syncedAt:importedAt,latestActivityAt:[...pulls,...issues].map(x=>x.updated_at).sort().at(-1)??commits[0]?.commit.committer?.date??null,stale:false,counts:{pullRequests:pulls.length,issues:issues.length,reviews:reviewRows.length,files:fileRows.length,comments:commentRows.length,commits:commits.length,branches:branches.length,contributors:people.size},publicRepository:details as PublicRepository};
}
