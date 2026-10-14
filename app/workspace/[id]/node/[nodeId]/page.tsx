import { OpenLibraryNodePage } from '@/components/openlibrary-node';
export default async function Page({params}:{params:Promise<{nodeId:string}>}){
  const {nodeId}=await params;
  return <OpenLibraryNodePage nodeId={nodeId}/>;
}
