import { NextResponse } from 'next/server';
import { coreRequest } from '@/lib/core-api';

export const runtime = 'nodejs';

export async function GET() {
  return coreRequest('/v1/memories');
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const episodeId = typeof body.episodeId === 'string' ? body.episodeId : '';
  if (!/^[0-9a-f-]{36}$/i.test(episodeId)) {
    return privateJson({ error: 'Choose a completed, source-backed investigation to save.' }, 400);
  }
  return coreRequest('/v1/memories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodeId }),
  });
}

export async function DELETE(request: Request) {
  const body = await request.json().catch(() => ({}));
  const memoryId = typeof body.memoryId === 'string' ? body.memoryId : '';
  if (!/^memory-[0-9a-f-]{36}$/i.test(memoryId)) {
    return privateJson({ error: 'Choose a saved memory to remove.' }, 400);
  }
  return coreRequest('/v1/memories', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memoryId }),
  });
}

function privateJson(body: unknown, status: number) {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
