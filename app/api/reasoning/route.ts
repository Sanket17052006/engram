import { NextResponse } from 'next/server';
import { answerFor } from '@/lib/agent';
export async function POST(request: Request) { const body = await request.json().catch(() => ({})); return NextResponse.json(answerFor(typeof body.prompt === 'string' ? body.prompt : 'Who should review PR #442?').reasoning); }
