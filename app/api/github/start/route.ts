import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
export async function GET(request: Request) {
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) return NextResponse.json({ error: 'Set GITHUB_APP_SLUG to your GitHub App slug first.' }, { status: 503 });
  const state = randomBytes(24).toString('hex');
  const response = NextResponse.redirect(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${state}`);
  response.cookies.set('engram_github_state', state, { httpOnly: true, sameSite: 'lax', secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: 600 });
  return response;
}
