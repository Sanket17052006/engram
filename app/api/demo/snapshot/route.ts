import { demoJson, guestRateLimited, normalizedPublicRepository, requestIp } from '@/lib/demo-api';
import { isFalkorConfigured } from '@/lib/falkordb';
import { readPublicSnapshot } from '@/lib/public-importer';
import { checkGuestReadRateLimit } from '@/lib/public-github';
export const runtime='nodejs';
export async function GET(request:Request){
  const checked=normalizedPublicRepository(new URL(request.url).searchParams.get('repository'));
  if(checked.response)return checked.response;
  const limit=checkGuestReadRateLimit(requestIp(request));if(!limit.allowed)return guestRateLimited(limit.retryAfterSeconds);
  if(!isFalkorConfigured())return demoJson({error:'The public demo graph is not configured.'},503);
  try{const snapshot=await readPublicSnapshot(checked.repository!);return snapshot?demoJson({...snapshot,source:'falkordb-cache',public:true}):demoJson({error:'No public repository graph is cached yet.'},404)}
  catch{return demoJson({error:'Could not read the public repository graph.'},503)}
}
