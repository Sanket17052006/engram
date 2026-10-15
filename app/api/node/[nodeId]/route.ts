import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
import { privateJson } from '@/lib/private-response';
import { privateGraphName, readSession } from '@/lib/github-session';

type GraphNode = { labels?: string[]; properties?: Record<string, unknown> };
function unwrap(value: unknown): GraphNode {
  if (!value || typeof value !== 'object') return {};
  const object = value as GraphNode;
  if (object.properties) return object;
  if ('properties' in object) return object;
  return { properties: object as Record<string, unknown> };
}
function nodeLabel(properties:Record<string,unknown>,type:string,id:string) {
  const content = type==='Commit'?String(properties.message??'')
    : type==='Comment'?String(properties.body??'')
    : type==='Review'?`${String(properties.state??'Review')} review`
    : '';
  return String(properties.title??properties.login??properties.fullName??properties.path??(content?content.split('\n')[0].slice(0,58):`${type} ${properties.number??id}`));
}
export async function GET(request: Request, { params }: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await params;
  const session = await readSession();
  if (!session) return privateJson({ error: 'Sign in with GitHub and select a repository first.' }, { status: 401 });
  if (!session.selectedRepo) return privateJson({ error: 'Select a repository before viewing graph records.' }, { status: 409 });
  if (!isFalkorConfigured()) return privateJson({ error: 'FalkorDB is not configured.' }, { status: 503 });
  if (/^\d+$/.test(nodeId)) {
    try {
      const graph = await getGraph(privateGraphName(session.id, session.selectedRepo));
      const result = await graph.query(`MATCH (node) WHERE id(node)=$nodeId
        OPTIONAL MATCH (node)-[relationship]-(other)
        RETURN labels(node) AS labels,node AS node,type(relationship) AS relationshipType,properties(relationship) AS relationshipProperties,
          id(other) AS otherId,labels(other) AS otherLabels,other AS other LIMIT 40`, { params: { nodeId: Number(nodeId) } });
      const rows = (result as { data?: Record<string, unknown>[] }).data ?? [];
      if (!rows.length) return privateJson({ error: 'Node not found in this repository graph.' }, { status: 404 });
      const node = unwrap(rows[0].node);
      const properties = node.properties ?? {};
      const relationships = rows.filter((row) => row.otherId !== null && row.otherId !== undefined).map((row) => {
        const other = unwrap(row.other);
        const otherProperties = other.properties ?? {};
        const labels=(row.otherLabels as string[] | undefined)??other.labels??[];
        return { id: String(row.otherId), type: String(row.relationshipType ?? ''), label: nodeLabel(otherProperties,labels[0]??'Node',String(row.otherId)), labels, properties: otherProperties, edgeProperties: row.relationshipProperties ?? {} };
      });
      const type=(rows[0].labels as string[] | undefined)?.[0] ?? node.labels?.[0] ?? 'Node';
      const label=nodeLabel(properties,type,nodeId);
      return privateJson({ id: nodeId, type, label, properties, relationships, graph: 'falkordb' });
    } catch (error) {
      console.error('Node detail query failed:', error);
      return privateJson({ error: 'Could not load node details from FalkorDB.' }, { status: 503 });
    }
  }
  return privateJson({ error: 'Node not found in this repository graph.' }, { status: 404 });
}
