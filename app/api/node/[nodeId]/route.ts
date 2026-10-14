import { NextResponse } from 'next/server';
import { nodes, edges } from '@/lib/agent';
export async function GET(_request: Request, { params }: { params: { nodeId: string } }) { const node = nodes.find(n => n.id === params.nodeId); if (!node) return NextResponse.json({ error: 'Node not found' }, { status: 404 }); const connected = edges.filter(e => e.source === node.id || e.target === node.id); return NextResponse.json({ ...node, relationships: connected }); }
