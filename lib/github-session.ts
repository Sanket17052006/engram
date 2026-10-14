import { createHash, randomBytes } from 'node:crypto';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export type GithubSession = { id:number; login:string; avatar:string; token:string; refreshToken?:string; expiresAt:number; selectedRepo?:string; installationId?:string };
const COOKIE='engram_github_session';
function key(){const secret=process.env.SESSION_SECRET;if(!secret)throw new Error('Set SESSION_SECRET in .env.local');return createHash('sha256').update(secret).digest();}
export async function sealSession(session:GithubSession){return new EncryptJWT(session as unknown as Record<string,unknown>).setProtectedHeader({alg:'dir',enc:'A256GCM'}).setIssuedAt().setExpirationTime('7d').encrypt(key());}
export async function readSession(){const cookieStore=await cookies();const value=cookieStore.get(COOKIE)?.value;if(!value)return null;try{const {payload}=await jwtDecrypt(value,key());return payload as unknown as GithubSession;}catch{return null;}}
export async function setSession(response:NextResponse,session:GithubSession,secure:boolean){response.cookies.set(COOKIE,await sealSession(session),{httpOnly:true,sameSite:'lax',secure,path:'/',maxAge:60*60*24*7});}
export async function getUserToken(){const session=await readSession();if(!session)return null;if(session.expiresAt>Date.now()+60_000)return session.token;if(!session.refreshToken)return null;const id=process.env.GITHUB_APP_CLIENT_ID,secret=process.env.GITHUB_APP_CLIENT_SECRET;if(!id||!secret)return null;const response=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:id,client_secret:secret,grant_type:'refresh_token',refresh_token:session.refreshToken}),cache:'no-store'});if(!response.ok)return null;const result=await response.json();if(!result.access_token)return null;session.token=result.access_token;session.refreshToken=result.refresh_token;session.expiresAt=Date.now()+Number(result.expires_in??28800)*1000;const cookieStore=await cookies();cookieStore.set(COOKIE,await sealSession(session),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/',maxAge:60*60*24*7});return session.token;}
export function pkce(){const verifier=randomBytes(32).toString('base64url');const challenge=createHash('sha256').update(verifier).digest('base64url');return {verifier,challenge};}
export function privateGraphName(userId:number,repository:string){const repoHash=createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0,12);return `engram_u${userId}_${repoHash}`;}
