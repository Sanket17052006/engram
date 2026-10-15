import { privateGraphName } from '@/lib/github-session';

const API = 'https://api.github.com';

/** Reserved user id 0 keeps anonymous public graphs outside all GitHub account graphs. */
export function guestGraphName(repository: string) { return privateGraphName(0, repository); }

export class PublicGithubError extends Error {
  constructor(message: string, readonly status: number, readonly retryAt?: string, readonly rateLimited = false) {
    super(message);
    this.name = 'PublicGithubError';
  }
}

export type PublicRepository = {
  full_name: string;
  name: string;
  html_url: string;
  description: string | null;
  default_branch: string;
  private: boolean;
  fork?: boolean;
  parent?: PublicRepository;
};

const visibilityCache = new Map<string, { until: number; value: PublicRepository }>();

export function normalizeRepository(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let value = input.trim().replace(/^@/, '');
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return null;
      value = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    } catch {
      return null;
    }
  }
  const pieces = value.split('/');
  if (pieces.length !== 2 || pieces.some(piece => !/^[A-Za-z0-9_.-]{1,100}$/.test(piece) || piece === '.' || piece === '..')) return null;
  return `${pieces[0]}/${pieces[1]}`;
}

export async function githubPublicGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return response.json() as Promise<T>;
  const payload = await response.json().catch(() => ({})) as { message?: string };
  const message = payload.message ?? `GitHub returned ${response.status}.`;
  const rateLimited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || /rate limit|secondary rate/i.test(message)));
  const retryAfter = response.headers.get('retry-after');
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  const retryAt = retryAfter ? new Date(Date.now() + Number(retryAfter) * 1000).toISOString() : rateLimited && reset ? new Date(reset * 1000).toISOString() : undefined;
  throw new PublicGithubError(rateLimited ? 'GitHub public API rate limit reached.' : message, response.status, retryAt, rateLimited);
}

export async function requirePublicRepository(repository: string): Promise<PublicRepository> {
  const cached = visibilityCache.get(repository.toLowerCase());
  if (cached && cached.until > Date.now()) return cached.value;
  const [owner, name] = repository.split('/');
  const data = await githubPublicGet<PublicRepository>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  if (data.private) throw new PublicGithubError('Guest import is available for public repositories only. Sign in to connect a private repository.', 403);
  if (data.full_name.toLowerCase() !== repository.toLowerCase()) throw new PublicGithubError('Repository identity did not match the requested public repository.', 409);
  visibilityCache.set(repository.toLowerCase(), { until: Date.now() + 30_000, value: data });
  return data;
}

type WindowLimit = { attempts: Map<string, number[]>; windowMs: number; max: number };
const importLimit:WindowLimit={attempts:new Map(),windowMs:60*60*1000,max:3};
const guestReadLimit:WindowLimit={attempts:new Map(),windowMs:60*1000,max:120};
const guestChatLimit:WindowLimit={attempts:new Map(),windowMs:10*60*1000,max:8};
function takeGuestRequest(limit:WindowLimit,ip:string):{allowed:boolean;retryAfterSeconds:number}{
  const now=Date.now();
  if(limit.attempts.size>5000){for(const [key,items] of Array.from(limit.attempts.entries()))if(!items.some(timestamp=>now-timestamp<limit.windowMs))limit.attempts.delete(key)}
  const recent=(limit.attempts.get(ip)??[]).filter(timestamp=>now-timestamp<limit.windowMs);
  if(recent.length>=limit.max){limit.attempts.set(ip,recent);return{allowed:false,retryAfterSeconds:Math.max(1,Math.ceil((limit.windowMs-(now-recent[0]))/1000))}}
  recent.push(now);limit.attempts.set(ip,recent);return{allowed:true,retryAfterSeconds:0};
}
export function checkGuestImportRateLimit(ip:string){return takeGuestRequest(importLimit,ip)}
export function checkGuestReadRateLimit(ip:string){return takeGuestRequest(guestReadLimit,ip)}
export function checkGuestChatRateLimit(ip:string){return takeGuestRequest(guestChatLimit,ip)}
