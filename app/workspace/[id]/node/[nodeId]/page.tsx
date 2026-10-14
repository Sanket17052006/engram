import { OpenLibraryNodePage } from '@/components/openlibrary-node';
export default function Page({params}:{params:{nodeId:string}}){return <OpenLibraryNodePage nodeId={params.nodeId}/>}
