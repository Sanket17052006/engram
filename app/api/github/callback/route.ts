import { NextResponse } from 'next/server';
export async function GET(request: Request) {
  const url = new URL(request.url); const state = url.searchParams.get('state'); const installationId = url.searchParams.get('installation_id');
  const cookieState = request.headers.get('cookie')?.split('; ').find(v => v.startsWith('engram_github_state='))?.split('=')[1];
  const destination = new URL('/setup/github', url.origin);
  if (!state || !cookieState || state !== decodeURIComponent(cookieState) || !installationId) { destination.searchParams.set('error', 'github_installation_not_verified'); return NextResponse.redirect(destination); }
  destination.searchParams.set('connected', '1');
  const response = NextResponse.redirect(destination);
  response.cookies.delete('engram_github_state');
  response.cookies.set('engram_installation', installationId, { httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', path: '/', maxAge: 60 * 60 * 24 * 30 });
  return response;
}
