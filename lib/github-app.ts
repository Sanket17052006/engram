import { createPrivateKey } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { cookies } from 'next/headers';

const API = 'https://api.github.com';
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
  const id = installationId ?? cookies().get('engram_installation')?.value;
  if (!id) throw new Error('GitHub is not connected');
  const jwt = await appJwt();
  const response = await fetch(`${API}/app/installations/${encodeURIComponent(id)}/access_tokens`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`GitHub could not issue an installation token (${response.status})`);
  return (await response.json() as { token: string }).token;
}
export async function githubApi<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status}) for ${path}`);
  return response.json() as Promise<T>;
}
