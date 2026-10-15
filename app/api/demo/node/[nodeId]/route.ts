import { guestCoreRequest } from '@/lib/core-api';
import { checkGuestReadRateLimit } from '@/lib/public-github';
import { guestRateLimited, normalizedPublicRepository, requestIp } from '@/lib/demo-api';
export const runtime='nodejs';
export async function GET(request:Request,{params}:{params:Promise<{nodeId:string}>}){
  const {nodeId}=await params;const checked=normalizedPublicRepository(new URL(request.url).searchParams.get('repository'));
  if(checked.response)return checked.response;
  const limit=checkGuestReadRateLimit(requestIp(request));if(!limit.allowed)return guestRateLimited(limit.retryAfterSeconds);
  return guestCoreRequest(`/v1/guest/node/${encodeURIComponent(nodeId)}`,checked.repository!);
}
