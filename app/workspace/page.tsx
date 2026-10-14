import { redirect } from 'next/navigation';
import { readSession } from '@/lib/github-session';
export default async function Page(){const session=await readSession();redirect(session?.selectedRepo?'/workspace/connected':'/setup/github')}
