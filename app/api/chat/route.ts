import { NextResponse } from 'next/server';
import { coreRequest } from '@/lib/core-api';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 500) : '';
  const targetNumber = typeof body.targetNumber === 'number' && Number.isInteger(body.targetNumber) && body.targetNumber > 0 && body.targetNumber <= 10_000_000 ? body.targetNumber : 0;
  if (!prompt) {
    const response = NextResponse.json({ error: 'Ask a question about the connected repository.' }, { status: 400 });
    response.headers.set('Cache-Control', 'private, no-store, max-age=0');
    return response;
  }
  return coreRequest('/v1/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, targetNumber }) });
}
