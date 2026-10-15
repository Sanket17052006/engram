import { coreRequest } from '@/lib/core-api';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const nodeId = new URL(request.url).searchParams.get('nodeId');
  const query = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
  return coreRequest(`/v1/graph/explore${query}`);
}
