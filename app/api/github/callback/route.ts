import { NextResponse } from 'next/server';
import { readSession, setSession } from '@/lib/github-session';
import { verifyInstallation } from '@/lib/github-app';
export async function GET(request: Request) {
  const url = new URL(request.url); const state = url.searchParams.get('state'); const installationId = url.searchParams.get('installation_id');
  const cookieState = request.headers.get('cookie')?.split('; ').find(v => v.startsWith('engram_install_state='))?.split('=')[1];
  const session=await readSession();
  const destination = new URL('/setup/github', url.origin);
  if (!state || !cookieState || state !== decodeURIComponent(cookieState) || !installationId || !session) { destination.searchParams.set('error', 'github_installation_not_verified'); return NextResponse.redirect(destination); }
  try{const installation=await verifyInstallation(installationId);if(installation.account.login.toLowerCase()!==session.login.toLowerCase()){destination.searchParams.set('error','github_installation_account_mismatch');return NextResponse.redirect(destination);}}catch{destination.searchParams.set('error','github_installation_not_verified');return NextResponse.redirect(destination);}
  destination.searchParams.set('connected', '1');
  const response = NextResponse.redirect(destination);
  response.cookies.delete('engram_install_state');
  await setSession(response,{...session,installationId},url.protocol==='https:');
  response.cookies.delete('engram_installation');
  return response;
}
