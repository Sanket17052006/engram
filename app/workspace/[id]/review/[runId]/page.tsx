import { LocalRepairReview } from '@/components/local-repair-review';

export default async function Page({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  return <LocalRepairReview workspaceId={id} runId={runId} />;
}
