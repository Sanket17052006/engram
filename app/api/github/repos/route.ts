import { installationToken, githubApi } from '@/lib/github-app';
import { readSession } from '@/lib/github-session';
import { privateJson } from '@/lib/private-response';
type Repo = { id:number; name:string; full_name:string; description:string|null; private:boolean; default_branch:string; html_url:string; updated_at:string; language:string|null; stargazers_count:number };
export async function GET() {
  try {
    const session=await readSession();if(!session)return privateJson({error:'Sign in with GitHub first.'},{status:401});
    if(!session.installationId)return privateJson({error:'Install Engram on your GitHub account and grant repository access first.'},{status:409});
    const token = await installationToken(session.installationId);
    const repositories:Repo[]=[];let total=0;
    for(let page=1;repositories.length<500;page++){
      const result = await githubApi<{ total_count:number; repositories:Repo[] }>(`/installation/repositories?per_page=100&page=${page}`, token);
      total=result.total_count;repositories.push(...result.repositories);if(result.repositories.length<100||repositories.length>=total)break;
    }
    return privateJson({ repositories:repositories.slice(0,500), total });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GitHub repositories could not be loaded.';
    return privateJson({ error:message }, { status:message.includes('not configured') || message.includes('not connected') ? 401 : 503 });
  }
}
