import { isFalkorConfigured } from '@/lib/falkordb';
import { demoJson, requestIp, validatedPublicRepository } from '@/lib/demo-api';
import { checkGuestImportRateLimit, PublicGithubError, requirePublicRepository } from '@/lib/public-github';
import { importPublicRepository, readPublicSnapshot } from '@/lib/public-importer';

export const runtime='nodejs';
export const maxDuration=120;

export async function POST(request:Request){
  const parsed=await request.json().catch(()=>null);
  const body=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};
  const checked=await validatedPublicRepository(body.repository);
  if(checked.response)return checked.response;
  const repository=checked.repository!;
  if(!isFalkorConfigured())return demoJson({error:'The public demo graph is not configured. FalkorDB and the Python core must be running.'},503);
  const cached=await readPublicSnapshot(repository).catch(()=>null);
  const fresh=Boolean(cached&&Date.now()-Date.parse(cached.syncedAt)<5*60*1000);
  if(fresh&&!body.force)return demoJson({...cached,source:'falkordb-cache',public:true});
  const limit=checkGuestImportRateLimit(requestIp(request));
  if(!limit.allowed){const response=demoJson({error:'This network has reached its guest import limit. Try the cached graph or retry later.',retryAfterSeconds:limit.retryAfterSeconds,rateLimited:true},429);response.headers.set('Retry-After',String(limit.retryAfterSeconds));return response;}
  try{
    // Repeat the public visibility check immediately before import. Never use a signed-in installation token here.
    await requirePublicRepository(repository);
    const result=await importPublicRepository(repository);
    return demoJson({...result,source:'github-live',public:true});
  }catch(error){
    const message=error instanceof Error?error.message:'Public GitHub import failed.';
    const retryAt=typeof error==='object'&&error&&'retryAt'in error?String(error.retryAt):undefined;
    const rateLimited=typeof error==='object'&&error&&'rateLimited'in error&&Boolean(error.rateLimited);
    const status=error instanceof PublicGithubError?(error.rateLimited?429:error.status===403||error.status===404?error.status:503):rateLimited?429:503;
    return demoJson({error:message,...(retryAt?{retryAt}:{}),...(rateLimited?{rateLimited:true}:{})},status);
  }
}
