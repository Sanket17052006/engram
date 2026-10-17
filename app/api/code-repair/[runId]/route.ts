import { NextResponse } from 'next/server';
import { readSession } from '@/lib/github-session';
import { getRepairManifest, rerunRepairChecks } from '@/lib/repair-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function json(body: unknown, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}

async function accessibleManifest(runId: string) {
  const session = await readSession();
  if (!session) return { response: json({ error: 'Sign in with GitHub to view this repair.' }, 401) };
  try {
    const manifest = await getRepairManifest(runId);
    if (manifest.userId !== session.id || manifest.repository.toLowerCase() !== session.selectedRepo?.toLowerCase()) return { response: json({ error: 'This repair is not available in the selected workspace.' }, 403) };
    return { manifest };
  } catch {
    return { response: json({ error: 'This repair session could not be found.' }, 404) };
  }
}

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  const access = await accessibleManifest(runId);
  if (access.response) return access.response;
  const { manifest } = access;
  return json({
    mode: 'review', id: manifest.id, issue: manifest.issue, repository: manifest.repository,
    summary: manifest.summary, branch: manifest.branch, baseRef: manifest.baseRef,
    originalBranch: manifest.originalBranch, stashedChanges: manifest.stashedChanges ? manifest.stashedChanges.slice(0, 12) : null,
    baseCommit: manifest.baseCommit.slice(0, 12), commitCreated: manifest.committed,
    changedFiles: manifest.changedFiles, diff: manifest.diff, checks: manifest.checks,
    graphEvidence: manifest.graphEvidence, graphTrace: manifest.graphTrace, createdAt: manifest.createdAt,
  });
}

export async function POST(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  const access = await accessibleManifest(runId);
  if (access.response) return access.response;
  try {
    const checks = await rerunRepairChecks(access.manifest);
    return json(checks, checks.status === 'failed' ? 422 : 200);
  } catch {
    return json({ error: 'Could not rerun the tests for this repair branch.' }, 503);
  }
}
