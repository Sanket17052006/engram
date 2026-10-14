import { RepositoryNodePage } from '@/components/repository-node';
export default async function Page({params}:{params:Promise<{nodeId:string}>}){
  const {nodeId}=await params;
  return <RepositoryNodePage nodeId={nodeId}/>;
}
