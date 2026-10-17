import { RepairGraph } from '@/components/repair-graph';

export default async function Page({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  return <RepairGraph workspaceId={id} runId={runId} />;
}
