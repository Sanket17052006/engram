import { NextResponse } from 'next/server';
import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return NextResponse.json({ error: 'Ask a question about Open Library.' }, { status: 400 });
  try {
    if (isFalkorConfigured()) {
      const graph = await getGraph('engram_openlibrary');
      const term = prompt.toLowerCase().replace(/[^a-z0-9_# -]/g, ' ').trim();
      const result = await graph.query('MATCH (r:Repository {fullName:$repo})-[:HAS_ITEM]->(x:WorkItem) WHERE toLower(x.title) CONTAINS $term OR toLower(x.body) CONTAINS $term OR toString(x.number) CONTAINS $term OPTIONAL MATCH (u:Contributor)-[:OPENED]->(x) OPTIONAL MATCH (x)-[:MODIFIES]->(f:File) OPTIONAL MATCH (c:Contributor)-[:SUBMITTED]->(:Review)-[:ON_PR]->(x) RETURN x.title AS title,x.kind AS kind,x.number AS number,x.url AS url,x.state AS state,x.author AS author,collect(DISTINCT u.login) AS contributors,collect(DISTINCT f.path)[0..5] AS files,collect(DISTINCT c.login)[0..5] AS reviewers LIMIT 8', { params: { repo: 'internetarchive/openlibrary', term } });
      const rows = (result as { data?: Record<string, unknown>[] }).data ?? [];
      return NextResponse.json({ source: 'falkordb', prompt, rows, cypher: 'MATCH (r:Repository)-[:HAS_ITEM]->(x:WorkItem) OPTIONAL MATCH contributor, review, file evidence RETURN matching project records and their connected context' });
    }
    const rows = Array.isArray(body.records) ? body.records.filter((x: any) => `${x.title} ${x.author} ${x.number}`.toLowerCase().includes(prompt.toLowerCase().replace(/who|worked|on|issue|pr|knows|about/g, '').trim()) || prompt.includes(String(x.number))).slice(0, 8) : [];
    return NextResponse.json({ source: 'preview', prompt, rows, message: 'Configure FalkorDB for persisted graph queries.' });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'FalkorDB query failed.' }, { status: 503 }); }
}
