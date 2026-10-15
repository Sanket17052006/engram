import { NextResponse } from 'next/server';
import { normalizeRepository, PublicGithubError, requirePublicRepository } from '@/lib/public-github';

export function demoJson(body:unknown,status=200){const response=NextResponse.json(body,{status});response.headers.set('Cache-Control','private, no-store, max-age=0');return response;}
export async function validatedPublicRepository(input:unknown){
  const repository=normalizeRepository(input);
  if(!repository) return {repository:null,response:demoJson({error:'Enter a GitHub public repository as owner/name or a GitHub URL.'},400)};
  try{const details=await requirePublicRepository(repository);return {repository:details.full_name,response:null};}
  catch(error){
    const status=error instanceof PublicGithubError?error.status:503;
    const message=error instanceof PublicGithubError?error.message:'Could not verify the repository with GitHub.';
    const response=demoJson({error:message,...(error instanceof PublicGithubError&&error.retryAt?{retryAt:error.retryAt}:{}),...(error instanceof PublicGithubError&&error.rateLimited?{rateLimited:true}:{})},status);
    if(error instanceof PublicGithubError&&error.retryAt)response.headers.set('Retry-After',String(Math.max(1,Math.ceil((Date.parse(error.retryAt)-Date.now())/1000))));
    return {repository:null,response};
  }
}
export function requestIp(request:Request){
  const forwarded=request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const real=request.headers.get('x-real-ip')?.trim();
  return (forwarded||real||'unknown').slice(0,80);
}

export function guestRateLimited(retryAfterSeconds:number){
  const response=demoJson({error:'Guest request limit reached. Please wait before trying again.',retryAfterSeconds,rateLimited:true},429);
  response.headers.set('Retry-After',String(retryAfterSeconds));
  return response;
}
