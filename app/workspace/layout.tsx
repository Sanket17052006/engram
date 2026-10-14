import { redirect } from 'next/navigation';
import { readSession } from '@/lib/github-session';

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession();
  if (!session?.selectedRepo) redirect('/setup/github');
  return children;
}
