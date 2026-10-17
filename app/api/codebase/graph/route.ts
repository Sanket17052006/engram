import { coreRequest } from '@/lib/core-api';

export const runtime = 'nodejs';

export async function GET() {
  return coreRequest('/v1/codebase/graph');
}
