import { NextResponse } from 'next/server';
import { coreRequestForSession } from '@/lib/core-api';
import { importCodebaseSnapshot } from '@/lib/repair-agent';
import { readSession } from '@/lib/github-session';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST() {
  const session = await readSession();
  if (!session) return privateJson({ error: 'Sign in with GitHub to import repository source.' }, 401);
  if (!session.selectedRepo) return privateJson({ error: 'Select a repository before importing its code graph.' }, 409);
  try {
    const snapshot = await importCodebaseSnapshot(session);
    return coreRequestForSession('/v1/codebase/import-content', session, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: snapshot.files, commit: snapshot.commit, branch: snapshot.branch }),
    }, 240_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not fetch source from the selected GitHub repository.';
    return privateJson({ error: message }, 422);
  }
}

function privateJson(body: unknown, status: number) {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
