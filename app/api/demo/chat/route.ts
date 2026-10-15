import { guestCoreRequest } from '@/lib/core-api';
import { checkGuestChatRateLimit } from '@/lib/public-github';
import { demoJson, guestRateLimited, requestIp, validatedPublicRepository } from '@/lib/demo-api';
export const runtime='nodejs';
export async function POST(request:Request){
  const parsed=await request.json().catch(()=>null);
  const body=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};
  const prompt=typeof body.prompt==='string'?body.prompt.trim().slice(0,500):'';
  if(!prompt)return demoJson({error:'Ask a question about this public repository.'},400);
  const checked=await validatedPublicRepository(body.repository);
  if(checked.response)return checked.response;
  const limit=checkGuestChatRateLimit(requestIp(request));if(!limit.allowed)return guestRateLimited(limit.retryAfterSeconds);
  return guestCoreRequest('/v1/guest/chat',checked.repository!,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt})});
}
