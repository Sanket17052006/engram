import { NextResponse } from 'next/server';
export async function POST(request:Request){const response=NextResponse.redirect(new URL('/',request.url));for(const name of ['engram_github_session','engram_installation','engram_install_state','engram_oauth_state','engram_oauth_verifier','engram_onboarding_done'])response.cookies.delete(name);return response;}
