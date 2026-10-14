import { NextResponse } from 'next/server';
export async function GET(request:Request){
  const url=new URL(request.url);const response=NextResponse.redirect(new URL('/workspace',url.origin));
  response.cookies.set('engram_onboarding_done','1',{httpOnly:true,sameSite:'lax',secure:url.protocol==='https:',path:'/',maxAge:60*60*24*365});
  return response;
}
