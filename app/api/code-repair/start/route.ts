import { NextResponse } from 'next/server';
import { readSession } from '@/lib/github-session';
import { prepareIssueRepair } from '@/lib/repair-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function json(body: unknown, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) return json({ error: 'Sign in with GitHub before preparing an issue fix.' }, 401);
  if (!session.selectedRepo) return json({ error: 'Select a repository before preparing an issue fix.' }, 409);

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const issueNumber = Number(body.issueNumber);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || issueNumber > 10_000_000) return json({ error: 'Choose an issue from the selected repository.' }, 400);

  let modelConfig: { provider: string; model: string; apiKey?: string } | undefined;
  if (body.modelConfig !== undefined && body.modelConfig !== null) {
    const candidate = body.modelConfig as Record<string, unknown>;
    const allowed = new Set(['openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'together', 'deepseek', 'ollama']);
    if (!candidate || typeof candidate !== 'object' || !allowed.has(String(candidate.provider)) || typeof candidate.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,120}$/.test(candidate.model)) return json({ error: 'Choose a supported provider and valid model ID in Workspace settings.' }, 400);
    if (candidate.provider !== 'ollama' && (typeof candidate.apiKey !== 'string' || candidate.apiKey.length < 8 || candidate.apiKey.length > 4096)) return json({ error: 'Add a valid provider key in Workspace settings.' }, 400);
    modelConfig = { provider: String(candidate.provider), model: candidate.model, ...(candidate.provider === 'ollama' ? {} : { apiKey: candidate.apiKey as string }) };
  }

  try {
    const result = await prepareIssueRepair(session, issueNumber, modelConfig);
    return json({ id: result.id, issue: result.issue, repository: result.repository, branch: result.branch, originalBranch: result.originalBranch, stashedChanges: result.stashedChanges?.slice(0, 12) ?? null, baseRef: result.baseRef, baseCommit: result.baseCommit.slice(0, 12), summary: result.summary, changedFiles: result.changedFiles, checks: result.checks, committed: result.committed, graphNodes: result.graphTrace.nodes.length, graphEdges: result.graphTrace.edges.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Engram could not prepare this issue fix.';
    console.error('Issue repair preparation failed:', message);
    return json({ error: message }, 422);
  }
}
