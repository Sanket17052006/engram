import { NextResponse } from 'next/server';
import { readSession, type GithubSession } from '@/lib/github-session';

export async function coreRequest(path: string, init: RequestInit = {}) {
  const session = await readSession();
  if (!session) return privateJson({ error: 'Sign in with GitHub and select a repository first.' }, { status: 401 });
  if (!session.selectedRepo) return privateJson({ error: 'Select a repository first.' }, { status: 409 });
  return coreRequestForSession(path, session, init);
}

export async function coreRequestForSession(path: string, session: GithubSession, init: RequestInit = {}, timeoutMs = 60_000) {
  const base = process.env.ENGRAM_CORE_URL?.replace(/\/$/, '');
  const key = process.env.ENGRAM_INTERNAL_API_KEY;
  if (!base || !key) return privateJson({ error: 'The Python agent core is not configured. Set ENGRAM_CORE_URL and ENGRAM_INTERNAL_API_KEY.' }, { status: 503 });
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init.headers ?? {}),
        'X-Engram-Core-Key': key,
        'X-Engram-User-Id': String(session.id),
        'X-Engram-Login': session.login,
        'X-Engram-Repository': session.selectedRepo ?? '',
      },
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const body = typeof payload.detail === 'string' && !payload.error ? { ...payload, error: payload.detail } : payload;
    return privateJson(body, { status: response.status });
  } catch {
    return privateJson({ error: 'The Python agent core is unavailable. Start the FastAPI service and retry.' }, { status: 503 });
  }
}

/** Public demo requests use a reserved anonymous principal and a validated public repository.
 * They deliberately bypass browser sessions and never accept identity headers from a client. */
export async function guestCoreRequest(path: string, repository: string, init: RequestInit = {}) {
  const base = process.env.ENGRAM_CORE_URL?.replace(/\/$/, '');
  const key = process.env.ENGRAM_INTERNAL_API_KEY;
  if (!base || !key) return privateJson({ error: 'The Python agent core is not configured.' }, { status: 503 });
  try {
    const response = await fetch(`${base}${path}`, {
      ...init, cache: 'no-store', signal: AbortSignal.timeout(60_000),
      headers: { ...(init.headers ?? {}), 'X-Engram-Core-Key': key, 'X-Engram-User-Id': '0', 'X-Engram-Login': 'guest', 'X-Engram-Repository': repository },
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const body = typeof payload.detail === 'string' && !payload.error ? { ...payload, error: payload.detail } : payload;
    return privateJson(body, { status: response.status });
  } catch {
    return privateJson({ error: 'The Python agent core is unavailable. Start the FastAPI service and retry.' }, { status: 503 });
  }
}

function privateJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
