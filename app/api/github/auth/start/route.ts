import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { pkce } from '@/lib/github-session';
export async function GET(request:Request){
 const clientId=process.env.GITHUB_APP_CLIENT_ID;if(!clientId)return NextResponse.json({error:'Set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET to enable GitHub sign-in.'},{status:503});
 const {verifier,challenge}=pkce(),state=randomBytes(32).toString('base64url'),url=new URL('https://github.com/login/oauth/authorize');
 url.searchParams.set('client_id',clientId);url.searchParams.set('redirect_uri',`${new URL(request.url).origin}/api/github/auth/callback`);url.searchParams.set('state',state);url.searchParams.set('code_challenge',challenge);url.searchParams.set('code_challenge_method','S256');url.searchParams.set('allow_signup','true');
 const response=NextResponse.redirect(url);const secure=new URL(request.url).protocol==='https:';
 response.cookies.set('engram_oauth_state',state,{httpOnly:true,sameSite:'lax',secure,path:'/',maxAge:600});response.cookies.set('engram_oauth_verifier',verifier,{httpOnly:true,sameSite:'lax',secure,path:'/',maxAge:600});return response;
}
