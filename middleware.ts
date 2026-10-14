import { NextRequest, NextResponse } from 'next/server';
export function middleware(request:NextRequest){
  if(request.cookies.get('engram_onboarding_done')?.value==='1')return NextResponse.next();
  return NextResponse.redirect(new URL('/setup/github',request.url));
}
export const config={matcher:['/workspace/:path*']};
