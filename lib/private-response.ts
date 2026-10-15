import { NextResponse } from 'next/server';

/** Repository and session scoped API data must never be stored by shared caches. */
export function privateJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
