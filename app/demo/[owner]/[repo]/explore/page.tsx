import { RepositoryExplorer } from '@/components/repository-explorer';
type Params={owner:string;repo:string};
export default async function Page({params}:{params:Promise<Params>}){const {owner,repo}=await params;return <RepositoryExplorer guestRepository={`${owner}/${repo}`}/>}
