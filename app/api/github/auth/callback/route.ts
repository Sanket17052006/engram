import { NextResponse } from 'next/server';
import { setSession, type GithubSession } from '@/lib/github-session';
export async function GET(request:Request){
 const url=new URL(request.url),code=url.searchParams.get('code'),state=url.searchParams.get('state'),jar=request.headers.get('cookie')??'';
 const cookie=(name:string)=>decodeURIComponent(jar.split('; ').find(v=>v.startsWith(`${name}=`))?.slice(name.length+1)??'');
 const destination=new URL('/setup/github',url.origin);
 if(!code||!state||state!==cookie('engram_oauth_state')||!cookie('engram_oauth_verifier')){destination.searchParams.set('error','github_auth_state_invalid');return NextResponse.redirect(destination);}
 const clientId=process.env.GITHUB_APP_CLIENT_ID,clientSecret=process.env.GITHUB_APP_CLIENT_SECRET;if(!clientId||!clientSecret){destination.searchParams.set('error','github_auth_not_configured');return NextResponse.redirect(destination);}
 try{
  const tokenResponse=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:clientId,client_secret:clientSecret,code,redirect_uri:`${url.origin}/api/github/auth/callback`,code_verifier:cookie('engram_oauth_verifier')}),cache:'no-store'});
  const token=await tokenResponse.json();if(!tokenResponse.ok||!token.access_token)throw new Error('GitHub did not return an access token.');
  const userResponse=await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},cache:'no-store'});if(!userResponse.ok)throw new Error('Could not read your GitHub profile.');
  const user=await userResponse.json(),session:GithubSession={id:user.id,login:user.login,avatar:user.avatar_url,token:token.access_token,refreshToken:token.refresh_token,expiresAt:Date.now()+Number(token.expires_in??28800)*1000};
  const response=NextResponse.redirect(new URL('/api/github/start',url.origin));await setSession(response,session,url.protocol==='https:');response.cookies.delete('engram_oauth_state');response.cookies.delete('engram_oauth_verifier');return response;
 }catch(error){destination.searchParams.set('error',error instanceof Error?error.message:'github_auth_failed');return NextResponse.redirect(destination);}
}
