import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { readSession, setSession } from '@/lib/github-session';
import { installationForAccount } from '@/lib/github-app';
export async function GET(request: Request) {
  const session=await readSession();if(!session)return NextResponse.redirect(new URL('/setup/github?error=sign_in_required',request.url));
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) return NextResponse.json({ error: 'Set GITHUB_APP_SLUG to your GitHub App slug first.' }, { status: 503 });
  // Returning users commonly already installed Engram. GitHub routes an
  // installation-new URL to its settings page in that case and does not call
  // the setup callback, which previously stranded the browser outside Engram.
  try{
    const installation=await installationForAccount(session.login);
    if(installation&&installation.account.login.toLowerCase()===session.login.toLowerCase()){
      const destination=new URL('/setup/github',request.url);destination.searchParams.set('connected','1');
      const response=NextResponse.redirect(destination);
      await setSession(response,{...session,installationId:String(installation.id)},new URL(request.url).protocol==='https:');
      return response;
    }
  }catch(error){
    console.error('Could not resolve existing GitHub App installation:',error);
    return NextResponse.redirect(new URL('/setup/github?error=github_installation_lookup_failed',request.url));
  }
  const state = randomBytes(24).toString('hex');
  const response = NextResponse.redirect(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${state}`);
  response.cookies.set('engram_install_state', state, { httpOnly: true, sameSite: 'lax', secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: 600 });
  return response;
}
