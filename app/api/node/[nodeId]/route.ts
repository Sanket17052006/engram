import { NextResponse } from 'next/server';
import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
import { privateGraphName, readSession } from '@/lib/github-session';

type GraphNode = { labels?: string[]; properties?: Record<string, unknown> };
function unwrap(value: unknown): GraphNode {
  if (!value || typeof value !== 'object') return {};
  const object = value as GraphNode;
  if (object.properties) return object;
  if ('properties' in object) return object;
  return { properties: object as Record<string, unknown> };
}
export async function GET(request: Request, { params }: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await params;
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'Sign in with GitHub and select a repository first.' }, { status: 401 });
  if (!session.selectedRepo) return NextResponse.json({ error: 'Select a repository before viewing graph records.' }, { status: 409 });
  if (!isFalkorConfigured()) return NextResponse.json({ error: 'FalkorDB is not configured.' }, { status: 503 });
  if (/^\d+$/.test(nodeId)) {
    try {
      const graph = await getGraph(privateGraphName(session.id, session.selectedRepo));
      const result = await graph.query(`MATCH (node) WHERE id(node)=$nodeId
        OPTIONAL MATCH (node)-[relationship]-(other)
        RETURN labels(node) AS labels,node AS node,type(relationship) AS relationshipType,properties(relationship) AS relationshipProperties,
          id(other) AS otherId,labels(other) AS otherLabels,other AS other LIMIT 40`, { params: { nodeId: Number(nodeId) } });
      const rows = (result as { data?: Record<string, unknown>[] }).data ?? [];
      if (!rows.length) return NextResponse.json({ error: 'Node not found in this repository graph.' }, { status: 404 });
      const node = unwrap(rows[0].node);
      const properties = node.properties ?? {};
      const relationships = rows.filter((row) => row.otherId !== null && row.otherId !== undefined).map((row) => {
        const other = unwrap(row.other);
        const otherProperties = other.properties ?? {};
        return { id: String(row.otherId), type: String(row.relationshipType ?? ''), label: String(otherProperties.title ?? otherProperties.login ?? otherProperties.fullName ?? otherProperties.path ?? `${String((row.otherLabels as string[] | undefined)?.[0] ?? 'Node')} ${String(otherProperties.number ?? row.otherId)}`), labels: row.otherLabels ?? other.labels ?? [], properties: otherProperties, edgeProperties: row.relationshipProperties ?? {} };
      });
      return NextResponse.json({ id: nodeId, type: (rows[0].labels as string[] | undefined)?.[0] ?? node.labels?.[0] ?? 'Node', label: String(properties.title ?? properties.login ?? properties.fullName ?? properties.path ?? `${nodeId}`), properties, relationships, graph: 'falkordb' });
    } catch (error) {
      console.error('Node detail query failed:', error);
      return NextResponse.json({ error: 'Could not load node details from FalkorDB.' }, { status: 503 });
    }
  }
  return NextResponse.json({ error: 'Node not found in this repository graph.' }, { status: 404 });
}
