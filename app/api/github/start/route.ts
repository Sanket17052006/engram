import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { readSession } from '@/lib/github-session';
export async function GET(request: Request) {
  const session=await readSession();if(!session)return NextResponse.redirect(new URL('/setup/github?error=sign_in_required',request.url));
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) return NextResponse.json({ error: 'Set GITHUB_APP_SLUG to your GitHub App slug first.' }, { status: 503 });
  const state = randomBytes(24).toString('hex');
  const response = NextResponse.redirect(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${state}`);
  response.cookies.set('engram_install_state', state, { httpOnly: true, sameSite: 'lax', secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: 600 });
  return response;
}
