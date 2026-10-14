type CacheGraph={query:(query:string,options?:{params?:Record<string,unknown>})=>Promise<unknown>};
export type CachedItem = { number:number;title:string;state:string;url:string;author:string;comments:number;updated_at:string };
export type CachedSnapshot = {
  repository:string;pulls:CachedItem[];issues:CachedItem[];graph:string;syncedAt:string;latestActivityAt:string|null;
  counts:{pullRequests:number;issues:number;reviews:number;files:number;comments:number};stale:boolean;ageMs:number;
};
type Row=Record<string,unknown>;
const object=(value:unknown):Row=>value&&typeof value==='object'?value as Row:{};
function compact(value:unknown):CachedItem {
  const item=object(value);
  return {number:Number(item.number??0),title:String(item.title??''),state:String(item.state??'unknown'),url:String(item.url??''),author:String(item.author??'unknown'),comments:Number(item.comments??0),updated_at:String(item.updatedAt??'')};
}
export async function readRepositoryCache(graph:CacheGraph,graphName:string,fullName:string):Promise<CachedSnapshot|null>{
  const result=await graph.query(`MATCH (repo:Repository {fullName:$fullName})-[:HAS_ITEM]->(item:WorkItem)
    RETURN properties(repo) AS repository,properties(item) AS item ORDER BY item.updatedAt DESC LIMIT 1000`,{params:{fullName}}) as {data?:Row[]};
  const records=Array.isArray(result?.data)?result.data:[];
  if(!records.length)return null;
  const metadata=object(records[0].repository);
  const items=records.map(row=>compact(row.item));
  const pulls=items.filter((item,index)=>String(object(records[index].item).kind)==='PR');
  const issues=items.filter((item,index)=>String(object(records[index].item).kind)==='Issue');
  const importedAt=String(metadata.importedAt??'');
  const ageMs=importedAt?Math.max(0,Date.now()-Date.parse(importedAt)):Number.POSITIVE_INFINITY;
  return {repository:String(metadata.fullName??fullName),pulls,issues,graph:graphName,syncedAt:importedAt,latestActivityAt:metadata.latestActivityAt?String(metadata.latestActivityAt):null,
    counts:{pullRequests:Number(metadata.indexedPullRequests??pulls.length),issues:Number(metadata.indexedIssues??issues.length),reviews:Number(metadata.indexedReviews??0),files:Number(metadata.indexedFiles??0),comments:Number(metadata.indexedComments??0)},
    stale:ageMs>60*60*1000,ageMs};
}
