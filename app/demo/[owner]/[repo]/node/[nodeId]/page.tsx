import { RepositoryNodePage } from '@/components/repository-node';
type Params={owner:string;repo:string;nodeId:string};
export default async function Page({params}:{params:Promise<Params>}){const {owner,repo,nodeId}=await params;return <RepositoryNodePage nodeId={nodeId} guestRepository={`${owner}/${repo}`}/>}
