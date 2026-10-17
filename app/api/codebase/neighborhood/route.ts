import { coreRequest } from '@/lib/core-api';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.paths) || body.paths.length < 1 || body.paths.length > 20 || body.paths.some((path: unknown) => typeof path !== 'string')) {
    return Response.json({ error: 'Choose one or more changed code paths.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
  }
  return coreRequest('/v1/codebase/neighborhood', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: body.paths }) });
}
