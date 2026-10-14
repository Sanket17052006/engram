import { createPrivateKey } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { cookies } from 'next/headers';

const API = 'https://api.github.com';
export class GithubApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAt?: string, readonly rateLimited = false) {
    super(message);
    this.name = 'GithubApiError';
  }
}
function retryAtFrom(response: Response, rateLimited: boolean) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const date = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(date)) return new Date(date).toISOString();
  }
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (rateLimited && Number.isFinite(reset) && reset > 0) return new Date(reset * 1000).toISOString();
  return rateLimited ? new Date(Date.now() + 60_000).toISOString() : undefined;
}
async function githubFetch(url: string, init: RequestInit) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(20_000) });
      if (response.ok) return response;
      const payload = await response.json().catch(() => ({})) as { message?: string };
      const message = payload.message ?? `GitHub API request failed (${response.status}).`;
      const isRateLimited = response.status === 429 || (response.status === 403 && (
        response.headers.get('x-ratelimit-remaining') === '0' || /rate limit|secondary rate/i.test(message)
      ));
      if (!isRateLimited && [408, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
        continue;
      }
      throw new GithubApiError(message, response.status, retryAtFrom(response, isRateLimited), isRateLimited);
    } catch (error) {
      if (error instanceof GithubApiError) throw error;
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('GitHub could not be reached after three attempts.');
}
export async function appJwt() {
  const appId = process.env.GITHUB_APP_ID;
  const pem = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!appId || !pem) throw new Error('GitHub App credentials are not configured');
  const rsaKey = createPrivateKey(pem);
  const pkcs8 = rsaKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const key = await importPKCS8(pkcs8, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuedAt(now - 30).setExpirationTime(now + 8 * 60).setIssuer(appId).sign(key);
}
export async function installationToken(installationId?: string) {
  const cookieStore = await cookies();
  const id = installationId ?? cookieStore.get('engram_installation')?.value;
  if (!id) throw new Error('GitHub is not connected');
  const jwt = await appJwt();
  const response = await githubFetch(`${API}/app/installations/${encodeURIComponent(id)}/access_tokens`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  return (await response.json() as { token: string }).token;
}
export async function githubApi<T>(path: string, token?: string): Promise<T> {
  const response = await githubFetch(`${API}${path}`, { headers: { ...(token?{Authorization:`Bearer ${token}`} : {}), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  return response.json() as Promise<T>;
}
export async function verifyInstallation(installationId:string){
  const jwt=await appJwt();const response=await fetch(`${API}/app/installations/${encodeURIComponent(installationId)}`,{headers:{Authorization:`Bearer ${jwt}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},cache:'no-store'});
  if(!response.ok)throw new Error(`GitHub installation verification failed (${response.status}).`);
  return response.json() as Promise<{account:{login:string;id:number};repository_selection:'all'|'selected'}>;
}
