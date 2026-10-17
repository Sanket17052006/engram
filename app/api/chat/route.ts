import { NextResponse } from 'next/server';
import { coreRequest } from '@/lib/core-api';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 500) : '';
  const targetNumber = typeof body.targetNumber === 'number' && Number.isInteger(body.targetNumber) && body.targetNumber > 0 && body.targetNumber <= 10_000_000 ? body.targetNumber : 0;
  const allowedProviders = new Set(['openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'together', 'deepseek', 'ollama']);
  let modelConfig: { provider: string; model: string; apiKey?: string } | undefined;
  if (body.modelConfig !== undefined) {
    const candidate = body.modelConfig;
    if (!candidate || typeof candidate !== 'object' || !allowedProviders.has(candidate.provider) || typeof candidate.model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(candidate.model)) {
      const response = NextResponse.json({ error: 'Choose a supported model provider and valid model ID.' }, { status: 400 });
      response.headers.set('Cache-Control', 'private, no-store, max-age=0');
      return response;
    }
    if (candidate.provider !== 'ollama' && (typeof candidate.apiKey !== 'string' || candidate.apiKey.length < 8 || candidate.apiKey.length > 4096)) {
      const response = NextResponse.json({ error: 'Add a valid provider API key.' }, { status: 400 });
      response.headers.set('Cache-Control', 'private, no-store, max-age=0');
      return response;
    }
    modelConfig = { provider: candidate.provider, model: candidate.model, ...(candidate.provider === 'ollama' ? {} : { apiKey: candidate.apiKey }) };
  }
  if (!prompt) {
    const response = NextResponse.json({ error: 'Ask a question about the connected repository.' }, { status: 400 });
    response.headers.set('Cache-Control', 'private, no-store, max-age=0');
    return response;
  }
  return coreRequest('/v1/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, targetNumber, ...(modelConfig ? { modelConfig } : {}) }) });
}
