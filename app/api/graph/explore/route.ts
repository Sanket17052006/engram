import { NextResponse } from 'next/server';
import { nodes, edges } from '@/lib/agent';
import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url); const q = (searchParams.get('q') ?? '').toLowerCase();
  if (isFalkorConfigured()) {
    try {
      const graph = await getGraph(searchParams.get('workspace') ? `engram_${searchParams.get('workspace')}` : undefined);
      const result = await graph.query('MATCH (a)-[r]->(b) RETURN id(a) AS sourceId, labels(a) AS sourceLabels, a AS source, type(r) AS relation, id(b) AS targetId, labels(b) AS targetLabels, b AS target LIMIT 150');
      const records = (result as { data?: Record<string, unknown>[] }).data ?? [];
      const mappedNodes = new Map<string, { id: string; label: string; type: string; properties: Record<string, unknown> }>();
      const mappedEdges = records.map((row, index) => {
        const a = String(row.sourceId); const b = String(row.targetId);
        const sourceLabels = row.sourceLabels as string[]; const targetLabels = row.targetLabels as string[];
        const sourceProps = row.source as Record<string, unknown>; const targetProps = row.target as Record<string, unknown>;
        if (!mappedNodes.has(a)) mappedNodes.set(a, { id:a,label:String(sourceProps.name ?? sourceProps.title ?? a),type:sourceLabels?.[0] ?? 'Node',properties:sourceProps });
        if (!mappedNodes.has(b)) mappedNodes.set(b, { id:b,label:String(targetProps.name ?? targetProps.title ?? b),type:targetLabels?.[0] ?? 'Node',properties:targetProps });
        return { id:`edge-${index}`,source:a,target:b,type:String(row.relation) };
      });
      return NextResponse.json({ nodes:Array.from(mappedNodes.values()),edges:mappedEdges,meta:{source:'falkordb',workspace:searchParams.get('workspace') ?? 'company'} });
    } catch (error) {
      console.error('FalkorDB graph exploration failed:', error);
      return NextResponse.json({ error:'FalkorDB graph exploration failed.' }, { status:503 });
    }
  }
  const selected = nodes.filter(n => !q || n.label.toLowerCase().includes(q) || n.type.toLowerCase().includes(q));
  const ids = new Set(selected.map(n => n.id));
  return NextResponse.json({ nodes:selected,edges:edges.filter(e => ids.has(e.source) && ids.has(e.target)),meta:{source:'mock',workspace:searchParams.get('workspace') ?? 'company'} });
}
