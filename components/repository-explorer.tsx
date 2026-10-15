'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { BrandMark } from '@/components/brand-mark';
import { ArrowLeft, ArrowRight, ChevronLeft, Database, GitBranch, LoaderCircle, Network, Search, UserRound, X } from 'lucide-react';

type Node = { id:string; label:string; type:string; properties:Record<string,unknown> };
type Edge = { id:string; source:string; target:string; type:string; properties?:Record<string,unknown> };
type Graph = { nodes:Node[]; edges:Edge[]; focus?:{id:string;label:string;type:string}; meta?:{repository?:string;source?:string;viewer?:string;mode?:string;truncated?:boolean} };
type Filter='All'|'Everything'|'Pull requests'|'Issues'|'Reviews'|'Reviewers'|'Assignees'|'Commits'|'Comments'|'Files'|'Contributors'|'Labels';
const filters:Filter[]=['All','Pull requests','Issues','Reviews','Reviewers','Assignees','Commits','Comments','Files','Contributors','Labels'];
const nodeMatchesFilter=(node:Node,filter:Filter)=>{
 const kind=String(node.properties.kind??'').toUpperCase();
 if(filter==='All'||filter==='Everything')return true;
 if(filter==='Pull requests')return node.type==='WorkItem'&&(kind==='PR'||/\bPR\s*#\d+/i.test(node.label));
 if(filter==='Issues')return node.type==='WorkItem'&&(kind==='ISSUE'||/\bissue\s*#\d+/i.test(node.label));
 if(filter==='Reviews')return node.type==='Review';
 if(filter==='Reviewers'||filter==='Assignees')return false;
 if(filter==='Commits')return node.type==='Commit';
 if(filter==='Comments')return node.type==='Comment';
 if(filter==='Files')return node.type==='File';
 if(filter==='Contributors')return node.type==='Contributor';
 return node.type==='RepositoryLabel';
};
const filterNodeIds=(graph:Graph,filter:Filter)=>{
 const ids=new Set<string>();
 if(filter==='All'||filter==='Everything')graph.nodes.forEach(node=>ids.add(node.id));
 else if(filter==='Reviewers'||filter==='Assignees'){
  const pattern=filter==='Reviewers'?/REVIEW_REQUESTED|SUBMITTED/:/ASSIGN/;
  const related=graph.edges.filter(edge=>pattern.test(edge.type));
  related.forEach(edge=>{ids.add(edge.source);ids.add(edge.target)});
  const reviewIds=new Set(graph.nodes.filter(node=>node.type==='Review').map(node=>node.id));
  if(filter==='Reviewers')graph.edges.filter(edge=>reviewIds.has(edge.source)||reviewIds.has(edge.target)).forEach(edge=>{ids.add(edge.source);ids.add(edge.target)});
 }else{
  graph.nodes.filter(node=>nodeMatchesFilter(node,filter)).forEach(node=>ids.add(node.id));
  if(filter==='Reviews')graph.edges.filter(edge=>ids.has(edge.source)||ids.has(edge.target)||/REVIEW_REQUESTED/.test(edge.type)).forEach(edge=>{ids.add(edge.source);ids.add(edge.target)});
 }
 if(graph.focus?.id)ids.add(graph.focus.id);
 return ids;
};
const filterCount=(graph:Graph,filter:Filter)=>filterNodeIds(graph,filter).size-(graph.focus?.id?1:0);
const relationLabel=(edge:Edge)=>edge.type.toLowerCase().replaceAll('_',' ');
function layoutGraph(nodes:Node[],edges:Edge[],focusId?:string){
 const points=new Map<string,{x:number;y:number}>();
 if(!focusId||nodes.length<2){nodes.forEach((node,index)=>points.set(node.id,index===0?{x:50,y:50}:{x:50+32*Math.cos(index*2.4),y:50+32*Math.sin(index*2.4)}));return points}
 const movable=nodes.filter(node=>node.id!==focusId);
 points.set(focusId,{x:50,y:50});
 movable.forEach((node,index)=>{const angle=index*2.399963;const radius=17+(index%4)*5;points.set(node.id,{x:50+Math.cos(angle)*radius,y:50+Math.sin(angle)*radius})});
 const links=edges.filter(edge=>points.has(edge.source)&&points.has(edge.target));
 for(let tick=0;tick<72;tick++){
 const forces=new Map<string,{x:number;y:number}>(movable.map(node=>[node.id,{x:0,y:0}]));
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
   const a=nodes[i],b=nodes[j],pa=points.get(a.id)!,pb=points.get(b.id)!;let dx=pa.x-pb.x,dy=pa.y-pb.y;const d=Math.max(2,Math.hypot(dx,dy)),f=390/(d*d);
   const fa=forces.get(a.id),fb=forces.get(b.id);if(fa){fa.x+=dx/d*f;fa.y+=dy/d*f}if(fb){fb.x-=dx/d*f;fb.y-=dy/d*f}
  }
  for(const edge of links){const a=points.get(edge.source)!,b=points.get(edge.target)!;let dx=b.x-a.x,dy=b.y-a.y;const d=Math.max(1,Math.hypot(dx,dy)),f=(d-20)*.012;const fa=forces.get(edge.source),fb=forces.get(edge.target);if(fa){fa.x+=dx/d*f;fa.y+=dy/d*f}if(fb){fb.x-=dx/d*f;fb.y-=dy/d*f}}
  const cooling=1-tick/76;
  for(const node of movable){const p=points.get(node.id)!,f=forces.get(node.id)!;f.x+=(50-p.x)*.002;f.y+=(50-p.y)*.002;const magnitude=Math.max(.01,Math.hypot(f.x,f.y)),step=Math.min(3.5,magnitude)*cooling;p.x=Math.max(5,Math.min(95,p.x+f.x/magnitude*step));p.y=Math.max(7,Math.min(93,p.y+f.y/magnitude*step))}
 }
 return points
}

export function RepositoryExplorer({guestRepository}:{guestRepository?:string}){
 const isGuest=Boolean(guestRepository);
 const repoPath=guestRepository?`/demo/${guestRepository.split('/').map(encodeURIComponent).join('/')}`:'/workspace/connected';
 const [graph,setGraph]=useState<Graph|null>(null),[history,setHistory]=useState<Graph[]>([]),[selected,setSelected]=useState<Node|null>(null),[q,setQ]=useState(''),[filter,setFilter]=useState<Filter>('All'),[visibleLimit,setVisibleLimit]=useState(8),[error,setError]=useState(''),[loading,setLoading]=useState(true),[repository,setRepository]=useState('');
 const load=async(nodeId?:string)=>{setLoading(true);setError('');try{const query=isGuest?`?repository=${encodeURIComponent(guestRepository??'')}${nodeId?`&nodeId=${encodeURIComponent(nodeId)}`:''}`:nodeId?`?nodeId=${encodeURIComponent(nodeId)}`:'';const response=await fetch(`${isGuest?'/api/demo/graph':'/api/graph/explore'}${query}`,{cache:'no-store'});const data:Graph&{error?:string}=await response.json();if(!response.ok)throw Error(data.error??'Could not load graph.');if(nodeId&&graph)setHistory(previous=>[...previous,graph]);setGraph(data);setRepository(data.meta?.repository??'');setSelected(null);setQ('');setFilter('All');setVisibleLimit(8)}catch(cause){setError(cause instanceof Error?cause.message:'Could not load graph.')}finally{setLoading(false)}};
 useEffect(()=>{void load()},[guestRepository]);
 const matchingIds=useMemo(()=>graph?filterNodeIds(graph,filter):new Set<string>(),[graph,filter]);
 const filteredNodes=useMemo(()=>graph?.nodes.filter(node=>{
   const matchesQuery=`${node.label} ${node.type}`.toLowerCase().includes(q.toLowerCase());
   const matchesType=matchingIds.has(node.id);
   return matchesQuery&&matchesType;
 })??[],[graph,q,matchingIds]);
 const availableFilters:Filter[]=useMemo(()=>graph?filters.filter(item=>item==='All'||filterCount(graph,item)>0):['All'],[graph]);
 const focus=graph?.nodes.find(node=>node.id===graph.focus?.id)??graph?.nodes[0];
 const focusEdges=(graph?.edges??[]).filter(edge=>edge.source===focus?.id||edge.target===focus?.id);
 const directIds=new Set(focusEdges.map(edge=>edge.source===focus?.id?edge.target:edge.source));
 const surrounding=filteredNodes.filter(node=>node.id!==focus?.id&&directIds.has(node.id)&&node.type!=='Repository');
 const visibleSurrounding=surrounding.slice(0,visibleLimit);
 const visibleDirectIds=new Set(visibleSurrounding.map(node=>node.id));
 const secondHopIds=new Set((graph?.edges??[]).flatMap(edge=>{
  if(visibleDirectIds.has(edge.source)&&!directIds.has(edge.target)&&edge.target!==focus?.id)return[edge.target];
  if(visibleDirectIds.has(edge.target)&&!directIds.has(edge.source)&&edge.source!==focus?.id)return[edge.source];
  return[]
 }));
 const visibleSecondHop=filteredNodes.filter(node=>secondHopIds.has(node.id)).slice(0,16);
 const visibleIds=new Set([...(focus?[focus.id]:[]),...visibleSurrounding.map(node=>node.id),...visibleSecondHop.map(node=>node.id)]);
 const visibleNodes=filteredNodes.filter(node=>visibleIds.has(node.id));
 if(focus&&!visibleNodes.some(node=>node.id===focus.id))visibleNodes.unshift(focus);
 const visibleEdges=(graph?.edges??[]).filter(edge=>visibleIds.has(edge.source)&&visibleIds.has(edge.target));
 const positions=layoutGraph(visibleNodes,visibleEdges,focus?.id);
 const selectedRelationships=selected?(graph?.edges??[]).filter(edge=>edge.source===selected.id||edge.target===selected.id).map(edge=>({edge,neighbor:(graph?.nodes??[]).find(node=>node.id===(edge.source===selected.id?edge.target:edge.source))})).filter((item):item is {edge:Edge;neighbor:Node}=>Boolean(item.neighbor)):[];
 const repositoryName=repository.split('/').pop()??repository;
 const goBack=()=>{const previous=history.at(-1);if(previous){setGraph(previous);setHistory(items=>items.slice(0,-1));setSelected(null);setFilter('All');setQ('');setVisibleLimit(8)}};
 return <div className="app-shell"><aside className="sidebar"><Link href={repoPath} className="side-logo"><span className="side-mark"><BrandMark size={38}/></span>engram<span className="brand-dot">.</span></Link><div className="workspace-select"><span className="ws-avatar">{repositoryName.slice(0,2).toUpperCase()}</span><div><strong>{repositoryName}</strong><small>Repository graph</small></div></div><Link href={repoPath} className="side-link"><ArrowLeft/><span>Project overview</span></Link><div className="side-spacer"/><div className="graph-status"><small><i className="status-pulse"/> CONNECTION VIEW</small><p>{filteredNodes.length} of {graph?.nodes.length??0} records · {visibleEdges.length} links</p></div></aside>
 <div className="main-area"><header className="app-header"><div className="breadcrumb"><span>{repository}</span><span>/</span><strong>Explore graph</strong></div><div className="header-tools"><label className="ol-search"><Search size={15}/><input value={q} onChange={event=>setQ(event.target.value)} placeholder="Search graph…"/></label></div></header>
 <main className="explore-content"><div className="explore-intro"><div><span className="pane-label"><Database size={13}/> FALKORDB · {isGuest?'PUBLIC REPOSITORY GRAPH':'PERSONAL CONNECTIONS'}</span><h1>{graph?.focus?.type==='Contributor'?'Your work, connected.':graph?.focus?.label??'Follow a project connection.'}</h1><p>{isGuest?'Start at the repository and follow public contributors, pull requests, issues, reviews, commits, and files.':'Start from your GitHub account, then follow a person, pull request, issue, review, commit, or file to inspect its direct connections.'}</p></div><div className="graph-intro-actions">{history.length>0&&<button className="graph-back-button" onClick={goBack}><ChevronLeft size={15}/> Back to previous node</button>}<Link className="graph-reset-button" href={repoPath}><UserRound size={14}/> {isGuest?'Public repository overview':'My repository overview'}</Link></div></div>
 <div className="graph-filter-bar"><div className="graph-filter-tabs" role="tablist" aria-label="Filter graph records">{availableFilters.map(item=><button key={item} role="tab" aria-selected={filter===item||item==='All'&&filter==='Everything'} className={filter===item||item==='All'&&filter==='Everything'?'selected':''} onClick={()=>{setFilter(item);setVisibleLimit(8)}}>{item==='Pull requests'?'PRs':item}<span className="graph-filter-count">{graph?filterCount(graph,item):0}</span></button>)}</div><span>{graph?.meta?.viewer?`Signed in as @${graph.meta.viewer}`:isGuest?'Public repository data · no personal connections':'Filter connected graph records by type or relationship'}</span></div>
 {error?<div className="setup-alert">{error}{history.length>0&&<button onClick={goBack}>Return to previous node</button>}</div>:loading&&!graph?<div className="graph-loading"><LoaderCircle className="spin" size={20}/> Loading repository graph…</div>:!graph?.nodes.length?<div className="panel-card ol-empty"><h3>No connected activity yet</h3><p>Import this repository to load its latest public activity into the graph.</p><Link className="button-dark" href={repoPath}>Open repository overview</Link></div>:<>
 <div className="connection-summary"><div className="connection-summary-icon"><Network size={16}/></div><div><strong>{focus?.label??'Selected graph record'}</strong><span>Showing {Math.min(visibleLimit,surrounding.length)} of {surrounding.length} direct connections{graph.meta?.truncated?' · newest 60 indexed links':''}</span></div>{surrounding.length>visibleLimit&&<button className="graph-more-button" onClick={()=>setVisibleLimit(limit=>limit+8)}>Show {Math.min(8,surrounding.length-visibleLimit)} more <ArrowRight size={12}/></button>}<small>FOCUS NODE</small></div>
 <div className="live-canvas connection-canvas" aria-label="FalkorDB graph neighborhood"><svg viewBox="0 0 100 100" preserveAspectRatio="none">{visibleEdges.map(edge=>{const from=positions.get(edge.source),to=positions.get(edge.target);return from&&to?<g key={edge.id}><line x1={`${from.x}%`} y1={`${from.y}%`} x2={`${to.x}%`} y2={`${to.y}%`} className="live-edge"/><text x={`${(from.x+to.x)/2}%`} y={`${(from.y+to.y)/2}%`} className="edge-label">{relationLabel(edge)}</text></g>:null})}</svg>{visibleNodes.map(node=>{const point=positions.get(node.id);return point?<button key={node.id} className={`live-node live-${node.type.toLowerCase()} ${node.id===focus?.id?'focus-node':''} ${node.id===selected?.id?'active-node':''}`} style={{left:`${point.x}%`,top:`${point.y}%`}} onClick={()=>setSelected(node)} aria-label={`${node.type}: ${node.label}`}><i/><span>{node.label.length>28?`${node.label.slice(0,26)}…`:node.label}</span></button>:null})}
 <div className="live-canvas-hint">{loading?<><LoaderCircle className="spin" size={12}/> Following graph edges…</>:`FalkorDB · ${visibleNodes.length} nodes · ${visibleEdges.length} relationships`}</div>
 {selected&&<aside className="live-detail"><div className="live-detail-top"><span className="pane-label">{selected.type.toUpperCase()}</span><div>{history.length>0&&<button className="detail-back-button" onClick={goBack} aria-label="Back to previous graph" title="Back to previous graph"><ChevronLeft size={16}/></button>}<button className="detail-close-button" onClick={()=>setSelected(null)} aria-label="Close node details" title="Close node details"><X size={16}/></button></div></div><h2>{selected.label}</h2><button className="follow-node-button" onClick={()=>void load(selected.id)} disabled={loading}><Network size={14}/>{loading?'Loading connections…':'Follow this node’s connections'}<ArrowRight size={13}/></button><div className="node-section"><h3>ABOUT</h3><div>{String(selected.properties.description??selected.properties.body??selected.properties.title??selected.properties.path??selected.properties.fullName??'Connected record from repository activity.')}</div></div><div className="node-section"><h3>DIRECT CONNECTIONS · {selectedRelationships.length}</h3>{selectedRelationships.length?selectedRelationships.map(({edge,neighbor})=><button className="connected-record-row" key={edge.id} onClick={()=>void load(neighbor.id)}><span>{edge.type.toLowerCase().replaceAll('_',' ')} · {neighbor.label}</span><ArrowRight size={12}/></button>):<div>No relationships in the imported window.</div>}</div>{Object.entries(selected.properties).filter(([key,value])=>!['body','description','title','path','fullName'].includes(key)&&value!==''&&value!==null).slice(0,8).length>0&&<div className="live-props">{Object.entries(selected.properties).filter(([key,value])=>!['body','description','title','path','fullName'].includes(key)&&value!==''&&value!==null).slice(0,8).map(([key,value])=><div key={key}><small>{key}</small><span>{Array.isArray(value)?value.join(', '):String(value)}</span></div>)}</div>}{typeof selected.properties.url==='string'&&<a target="_blank" rel="noreferrer" href={selected.properties.url as string}>Open source record ↗</a>}<Link className="button-dark" href={`${repoPath}/node/${selected.id}`} style={{marginTop:12}}>Open node detail <ArrowRight size={12}/></Link></aside>}</div>
 {graph.meta?.truncated&&<p className="graph-limit-note">This node has more than 60 direct links. Use the filters and search to narrow this view; each followed record opens its own focused neighborhood.</p>}
 </>}
 </main></div></div>
}
