import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
export async function GET(){return NextResponse.json({appConfigured:Boolean(process.env.GITHUB_APP_SLUG&&process.env.GITHUB_APP_ID&&process.env.GITHUB_APP_PRIVATE_KEY),databaseConfigured:Boolean(process.env.FALKORDB_URL),connected:Boolean(cookies().get('engram_installation')?.value)});}
