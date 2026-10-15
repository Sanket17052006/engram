import { guestCoreRequest } from '@/lib/core-api';
import { checkGuestReadRateLimit } from '@/lib/public-github';
import { guestRateLimited, requestIp, validatedPublicRepository } from '@/lib/demo-api';
export const runtime='nodejs';
export async function GET(request:Request){
  const url=new URL(request.url);const checked=await validatedPublicRepository(url.searchParams.get('repository'));
  if(checked.response)return checked.response;
  const limit=checkGuestReadRateLimit(requestIp(request));if(!limit.allowed)return guestRateLimited(limit.retryAfterSeconds);
  const nodeId=url.searchParams.get('nodeId');
  return guestCoreRequest(`/v1/guest/graph${nodeId?`?nodeId=${encodeURIComponent(nodeId)}`:''}`,checked.repository!);
}
