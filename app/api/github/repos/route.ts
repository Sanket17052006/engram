import { NextResponse } from 'next/server';
import { installationToken, githubApi } from '@/lib/github-app';
type Repo = { id:number; name:string; full_name:string; description:string|null; private:boolean; default_branch:string; html_url:string; updated_at:string; language:string|null; stargazers_count:number };
export async function GET() {
  try {
    const token = await installationToken();
    const result = await githubApi<{ total_count:number; repositories:Repo[] }>('/installation/repositories?per_page=100', token);
    return NextResponse.json({ repositories:result.repositories, total:result.total_count });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GitHub repositories could not be loaded.';
    return NextResponse.json({ error:message }, { status:message.includes('not configured') || message.includes('not connected') ? 401 : 503 });
  }
}
