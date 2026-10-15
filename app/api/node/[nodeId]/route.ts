import { coreRequest } from '@/lib/core-api';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await params;
  return coreRequest(`/v1/node/${encodeURIComponent(nodeId)}`);
}
