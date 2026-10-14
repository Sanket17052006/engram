import { NextResponse } from 'next/server';
import { nodes, edges } from '@/lib/agent';
import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
import { privateGraphName, readSession } from '@/lib/github-session';
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url); const q = (searchParams.get('q') ?? '').toLowerCase();
  if (isFalkorConfigured()) {
    try {
      const session=await readSession();const graph=await getGraph(session?.selectedRepo?privateGraphName(session.id,session.selectedRepo):searchParams.get('workspace')?`engram_${searchParams.get('workspace')}`:undefined);
      const result = await graph.query('MATCH (a)-[r]->(b) RETURN id(a) AS sourceId, labels(a) AS sourceLabels, a AS source, type(r) AS relation, properties(r) AS relationProperties, id(b) AS targetId, labels(b) AS targetLabels, b AS target LIMIT 250');
      const records = (result as { data?: Record<string, unknown>[] }).data ?? [];
      const mappedNodes = new Map<string, { id: string; label: string; type: string; properties: Record<string, unknown> }>();
      const mappedEdges = records.map((row, index) => {
        const a = String(row.sourceId); const b = String(row.targetId);
        const sourceNode = row.source as { labels?: string[]; properties?: Record<string, unknown> };
        const targetNode = row.target as { labels?: string[]; properties?: Record<string, unknown> };
        const sourceLabels = (row.sourceLabels as string[] | undefined) ?? sourceNode?.labels ?? [];
        const targetLabels = (row.targetLabels as string[] | undefined) ?? targetNode?.labels ?? [];
        const sourceProps = sourceNode?.properties ?? row.source as Record<string, unknown>;
        const targetProps = targetNode?.properties ?? row.target as Record<string, unknown>;
        const label = (props:Record<string,unknown>,labels:string[],id:string) => String(props.title ?? props.login ?? props.fullName ?? `${labels[0] ?? 'Node'} ${props.number ?? id}`);
        if (!mappedNodes.has(a)) mappedNodes.set(a, { id:a,label:label(sourceProps,sourceLabels,a),type:sourceLabels?.[0] ?? 'Node',properties:sourceProps });
        if (!mappedNodes.has(b)) mappedNodes.set(b, { id:b,label:label(targetProps,targetLabels,b),type:targetLabels?.[0] ?? 'Node',properties:targetProps });
        const relation=String(row.relation);
        const storedRelationProps=(row.relationProperties as Record<string,unknown>|undefined)??{};
        // Older imports stored only the topology. Reconstruct useful edge context
        // from the attached node attributes until the next import persists it.
        const inferredRelationProps=relation==='HAS_ITEM'
          ? { lastSyncedAt:sourceProps.importedAt??targetProps.updatedAt??'',kind:targetProps.kind??'' }
          : relation==='OPENED'
            ? { createdAt:targetProps.createdAt??'',kind:targetProps.kind??'' }
            : relation==='MODIFIES'
              ? { status:targetProps.status??'',additions:targetProps.additions??0,deletions:targetProps.deletions??0,changes:targetProps.changes??0 }
              : relation==='SUBMITTED'
                ? { state:targetProps.state??'',submittedAt:targetProps.submittedAt??'' }
                : relation==='ON_PR'
                  ? { reviewUrl:targetProps.url??'',submittedAt:targetProps.submittedAt??'' }
                  : relation==='WROTE'
                    ? { createdAt:targetProps.createdAt??'' }
                    : relation==='ON_ITEM'
                      ? { kind:targetProps.kind??'',createdAt:sourceProps.createdAt??'' }
                      : {};
        return { id:`edge-${index}`,source:a,target:b,type:relation,properties:Object.keys(storedRelationProps).length?storedRelationProps:inferredRelationProps };
      });
      return NextResponse.json({ nodes:Array.from(mappedNodes.values()),edges:mappedEdges,meta:{source:'falkordb',workspace:searchParams.get('workspace') ?? 'company',repository:session?.selectedRepo??'internetarchive/openlibrary'} });
    } catch (error) {
      console.error('FalkorDB graph exploration failed:', error);
      return NextResponse.json({ error:'FalkorDB graph exploration failed.' }, { status:503 });
    }
  }
  const selected = nodes.filter(n => !q || n.label.toLowerCase().includes(q) || n.type.toLowerCase().includes(q));
  const ids = new Set(selected.map(n => n.id));
  return NextResponse.json({ nodes:selected,edges:edges.filter(e => ids.has(e.source) && ids.has(e.target)),meta:{source:'mock',workspace:searchParams.get('workspace') ?? 'company',repository:'sample/acme'} });
}
