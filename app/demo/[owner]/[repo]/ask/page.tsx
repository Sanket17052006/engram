import { RepositoryWorkspace } from '@/components/repository-workspace';
type Params={owner:string;repo:string};
export default async function Page({params}:{params:Promise<Params>}){const {owner,repo}=await params;return <RepositoryWorkspace view="ask" guestRepository={`${owner}/${repo}`}/>}
