import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
import { privateJson } from '@/lib/private-response';
import { privateGraphName, readSession } from '@/lib/github-session';

type GraphNode = { labels?: string[]; properties?: Record<string, unknown> };
function unwrap(value: unknown): GraphNode {
  if (!value || typeof value !== 'object') return {};
  const object = value as GraphNode;
  if (object.properties) return object;
  return { properties: object as Record<string, unknown> };
}
function nodeLabel(properties:Record<string,unknown>,type:string,id:string) {
  const content = type==='Commit'?String(properties.message??'')
    : type==='Comment'?String(properties.body??'')
    : type==='Review'?`${String(properties.state??'Review')} review`
    : '';
  if (type === 'WorkItem') {
    const state=properties.mergedAt?'Merged':String(properties.state??'').toLowerCase()==='open'?'Open':'Closed';
    const kind = properties.kind === 'PR' ? 'PR' : 'issue';
    return `${state} ${kind} #${properties.number ?? id} · ${String(properties.title ?? '').slice(0, 42)}`;
  }
  return String(properties.title??properties.login??properties.fullName??properties.name??properties.path??(content?content.split('\n')[0].slice(0,58):`${type} ${properties.number??id}`));
}

/**
 * The explorer is intentionally ego-centered: first load shows the signed-in
 * contributor and one hop of relationships. Following a node replaces that
 * view with its own one-hop neighborhood, keeping large repositories legible.
 */
export async function GET(request: Request) {
  const session=await readSession();
  if(!session)return privateJson({error:'Sign in with GitHub and select a repository first.'},{status:401});
  if(!session.selectedRepo)return privateJson({error:'Select a repository before exploring a graph.'},{status:409});
  if (!isFalkorConfigured()) return privateJson({error:'FalkorDB is not configured.'},{status:503});
  const nodeId=new URL(request.url).searchParams.get('nodeId');
  if (nodeId && !/^\d+$/.test(nodeId)) return privateJson({error:'Choose a graph node to follow.'},{status:400});
  try {
    const graph=await getGraph(privateGraphName(session.id,session.selectedRepo));
    const query=nodeId
      ? `MATCH (focus) WHERE id(focus)=$nodeId
         OPTIONAL MATCH (focus)-[r]-(other)
         WITH focus,r,other ORDER BY coalesce(other.updatedAt,other.createdAt,other.date,other.submittedAt,'') DESC LIMIT 61
         RETURN id(focus) AS focusId,labels(focus) AS focusLabels,focus AS focus,
           id(other) AS otherId,labels(other) AS otherLabels,other AS other,
           type(r) AS relation,properties(r) AS relationProperties
         LIMIT 101`
      : `MATCH (focus:Contributor {login:$login})
         OPTIONAL MATCH (focus)-[r]-(other)
         WITH focus,r,other ORDER BY coalesce(other.updatedAt,other.createdAt,other.date,other.submittedAt,'') DESC LIMIT 61
         RETURN id(focus) AS focusId,labels(focus) AS focusLabels,focus AS focus,
           id(other) AS otherId,labels(other) AS otherLabels,other AS other,
           type(r) AS relation,properties(r) AS relationProperties
         LIMIT 101`;
    const result=await graph.query(query,{params:nodeId?{nodeId:Number(nodeId)}:{login:session.login}}) as {data?:Record<string,unknown>[]};
    const rows=result.data??[];
    if (!rows.length) return privateJson({error:nodeId?'That record is not in the selected repository graph.':'Your GitHub account has no indexed connections in this repository yet.'},{status:404});
    const focus=unwrap(rows[0].focus),focusId=String(rows[0].focusId);
    const focusLabels=(rows[0].focusLabels as string[]|undefined)??focus.labels??[];
    const focusProperties=focus.properties??{};
    const mappedNodes=new Map<string,{id:string;label:string;type:string;properties:Record<string,unknown>}>([[focusId,{id:focusId,label:nodeLabel(focusProperties,focusLabels[0]??'Contributor',focusId),type:focusLabels[0]??'Contributor',properties:focusProperties}]]);
    const edges=rows.filter(row=>row.otherId!==null&&row.otherId!==undefined&&row.relation).map((row,index)=>{
      const other=unwrap(row.other),otherId=String(row.otherId),labels=(row.otherLabels as string[]|undefined)??other.labels??[],properties=other.properties??{};
      if(!mappedNodes.has(otherId))mappedNodes.set(otherId,{id:otherId,label:nodeLabel(properties,labels[0]??'Node',otherId),type:labels[0]??'Node',properties});
      return{id:`edge-${index}`,source:focusId,target:otherId,type:String(row.relation),properties:(row.relationProperties as Record<string,unknown>|undefined)??{}};
    });
    return privateJson({nodes:Array.from(mappedNodes.values()),edges,focus:{id:focusId,label:nodeLabel(focusProperties,focusLabels[0]??'Contributor',focusId),type:focusLabels[0]??'Contributor'},meta:{source:'falkordb',repository:session.selectedRepo,viewer:session.login,mode:nodeId?'neighborhood':'my-connections',truncated:rows.length>60}});
  } catch (error) {
    console.error('FalkorDB graph exploration failed:', error);
    return privateJson({ error:'FalkorDB graph exploration failed.' }, { status:503 });
  }
}
