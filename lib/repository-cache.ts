type CacheGraph={query:(query:string,options?:{params?:Record<string,unknown>})=>Promise<unknown>};
export type CachedItem = { number:number;title:string;state:string;url:string;author:string;comments:number;updated_at:string };
export type CachedCommit = {sha:string;message:string;url:string;authorLogin:string;authorName:string;date:string};
export type CachedSnapshot = {
  repository:string;upstreamRepository:string|null;pulls:CachedItem[];issues:CachedItem[];commits:CachedCommit[];graph:string;syncedAt:string;latestActivityAt:string|null;
  counts:{pullRequests:number;issues:number;reviews:number;files:number;comments:number;commits:number;branches:number;contributors:number};stale:boolean;ageMs:number;
};
type Row=Record<string,unknown>;
const object=(value:unknown):Row=>value&&typeof value==='object'?value as Row:{};
function compact(value:unknown):CachedItem {
  const item=object(value);
  return {number:Number(item.number??0),title:String(item.title??''),state:String(item.state??'unknown'),url:String(item.url??''),author:String(item.author??'unknown'),comments:Number(item.comments??0),updated_at:String(item.updatedAt??'')};
}
export async function readRepositoryCache(graph:CacheGraph,graphName:string,fullName:string):Promise<CachedSnapshot|null>{
  const repoResult=await graph.query(`MATCH (repo:Repository {fullName:$fullName}) RETURN properties(repo) AS repository LIMIT 1`,{params:{fullName}}) as {data?:Row[]};
  const metadata=object(repoResult.data?.[0]?.repository);
  if(!Object.keys(metadata).length)return null;
  const [itemResult,commitResult]=await Promise.all([
    graph.query(`MATCH (:Repository {fullName:$fullName})-[:HAS_ITEM]->(item:WorkItem)
      RETURN properties(item) AS item ORDER BY item.updatedAt DESC LIMIT 1000`,{params:{fullName}}),
    graph.query(`MATCH (:Repository {fullName:$fullName})-[:HAS_COMMIT]->(commit:Commit)
      RETURN properties(commit) AS commit ORDER BY commit.date DESC LIMIT 200`,{params:{fullName}}),
  ]) as [{data?:Row[]},{data?:Row[]}];
  const itemRecords=Array.isArray(itemResult.data)?itemResult.data:[];
  const commitRecords=Array.isArray(commitResult.data)?commitResult.data:[];
  const items=itemRecords.map(row=>compact(row.item));
  const pulls=items.filter((item,index)=>String(object(itemRecords[index].item).kind)==='PR');
  const issues=items.filter((item,index)=>String(object(itemRecords[index].item).kind)==='Issue');
  const commits=commitRecords.map(row=>{const commit=object(row.commit);return {sha:String(commit.sha??''),message:String(commit.message??''),url:String(commit.url??''),authorLogin:String(commit.authorLogin??''),authorName:String(commit.authorName??''),date:String(commit.date??'')}});
  const importedAt=String(metadata.importedAt??'');
  const ageMs=importedAt?Math.max(0,Date.now()-Date.parse(importedAt)):Number.POSITIVE_INFINITY;
  return {repository:String(metadata.fullName??fullName),upstreamRepository:metadata.upstreamRepository?String(metadata.upstreamRepository):null,pulls,issues,commits,graph:graphName,syncedAt:importedAt,latestActivityAt:metadata.latestActivityAt?String(metadata.latestActivityAt):commits[0]?.date??null,
    counts:{pullRequests:Number(metadata.indexedPullRequests??pulls.length),issues:Number(metadata.indexedIssues??issues.length),reviews:Number(metadata.indexedReviews??0),files:Number(metadata.indexedFiles??0),comments:Number(metadata.indexedComments??0),commits:Number(metadata.indexedCommits??commits.length),branches:Number(metadata.indexedBranches??0),contributors:Number(metadata.indexedContributors??0)},
    stale:ageMs>60*60*1000,ageMs};
}
