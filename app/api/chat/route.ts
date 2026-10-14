import { NextResponse } from 'next/server';
import { answerFor, reviewerCypher } from '@/lib/agent';
import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return NextResponse.json({ error: 'A prompt is required.' }, { status: 400 });
  const result = answerFor(prompt);
  if (isFalkorConfigured()) {
    try {
      const graph = await getGraph(typeof body.workspaceId === 'string' ? `engram_${body.workspaceId}` : undefined);
      const prNumber = Number(prompt.match(/#?(\d{2,})/)?.[1] ?? 442);
      const queryResult = await graph.query(reviewerCypher, { params: { prNumber } });
      const rows = (queryResult as { data?: Record<string, unknown>[] }).data ?? [];
      if (rows.length) {
        const first = rows[0];
        const reviewer = String(first['p.name'] ?? first.name ?? 'A strong graph match');
        result.answer = `${reviewer} is the strongest match from the connected graph for ${prompt}.`;
        result.reasoning.plainEnglish = `FalkorDB found ${rows.length} matching people by following ownership and review history for PR #${prNumber}.`;
      }
    } catch (error) {
      console.error('FalkorDB query failed:', error);
      return NextResponse.json({ error: 'The configured FalkorDB graph could not be queried. Check the connection and graph name.' }, { status: 503 });
    }
  }
  return NextResponse.json({ ...result, conversationId: body.conversationId ?? 'demo', source: isFalkorConfigured() ? 'falkordb' : 'mock' });
}
