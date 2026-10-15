import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.ENGRAM_E2E_URL ?? 'http://localhost:3100';
async function getJson(path, init) {
  const response = await fetch(new URL(path, baseUrl), init);
  const data = await response.json();
  return { response, data };
}

test('GitHub setup is available to a first-time visitor', async () => {
  const response = await fetch(new URL('/setup/github', baseUrl), { cache: 'no-store' });
  assert.equal(response.status, 200);
});

test('GitHub status reports configured services without exposing credentials', async () => {
  const { response, data } = await getJson('/api/github/status', { cache: 'no-store' });
  assert.equal(response.status, 200);
  assert.equal(data.databaseConfigured, true);
  assert.equal(data.appConfigured, true);
  assert.equal(data.authenticated, false);
  assert.equal(typeof data.llmConfigured, 'boolean');
  assert.equal('token' in data, false);
  assert.equal('clientSecret' in data, false);
  assert.match(response.headers.get('cache-control') ?? '', /private, no-store/);
});

test('GitHub OAuth start uses state and PKCE with the configured callback', async () => {
  const response = await fetch(new URL('/api/github/auth/start', baseUrl), { redirect: 'manual' });
  assert.equal(response.status, 307);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.hostname, 'github.com');
  assert.equal(location.pathname, '/login/oauth/authorize');
  assert.ok(location.searchParams.get('state'));
  assert.ok(location.searchParams.get('code_challenge'));
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('redirect_uri'), `${baseUrl}/api/github/auth/callback`);
  assert.match(response.headers.get('set-cookie') ?? '', /engram_oauth_state=/);
});

test('repository endpoints require an authenticated GitHub session', async () => {
  const repos = await fetch(new URL('/api/github/repos', baseUrl));
  assert.equal(repos.status, 401);
  assert.match(repos.headers.get('cache-control') ?? '', /private, no-store/);
  const privateSnapshot = await fetch(new URL('/api/github/sync', baseUrl));
  assert.equal(privateSnapshot.status, 401);
  assert.match(privateSnapshot.headers.get('cache-control') ?? '', /private, no-store/);
  const sync = await fetch(new URL('/api/github/sync', baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repository: 'example-org/example-repository' }),
  });
  assert.equal(sync.status, 401);
  assert.match(sync.headers.get('cache-control') ?? '', /private, no-store/);
});

test('chat validates input and requires a selected GitHub repository', async () => {
  const empty = await fetch(new URL('/api/chat', baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '   ' }),
  });
  assert.equal(empty.status, 400);
  assert.match(empty.headers.get('cache-control') ?? '', /private, no-store/);
  const { response, data } = await getJson('/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Who should review PR #442?' }),
  });
  assert.equal(response.status, 401);
  assert.match(data.error, /sign in/i);
});

test('graph and node APIs require an authenticated selected repository', async () => {
  const graph = await fetch(new URL('/api/graph/explore', baseUrl), { cache: 'no-store' });
  assert.equal(graph.status, 401);
  assert.match(graph.headers.get('cache-control') ?? '', /private, no-store/);
  const node = await fetch(new URL('/api/node/1', baseUrl), { cache: 'no-store' });
  assert.equal(node.status, 401);
  assert.match(node.headers.get('cache-control') ?? '', /private, no-store/);
});

test('a signed-out visitor can enter the public repository demo', async () => {
  const page = await fetch(new URL('/demo', baseUrl), { cache: 'no-store' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /PUBLIC REPOSITORY EXPLORER/);
  assert.match(html, /Public repositories only/);
  assert.match(html, /No sign in/);
  const workspace = await fetch(new URL('/demo/vercel/next.js', baseUrl), { cache: 'no-store' });
  assert.equal(workspace.status, 200);
});

test('guest graph snapshots do not spend GitHub visibility-check quota', async () => {
  const { response, data } = await getJson('/api/demo/snapshot?repository=vercel%2Fnext.js', { cache: 'no-store' });
  assert.notEqual(response.status, 403);
  assert.doesNotMatch(data.error ?? '', /GitHub public API rate limit reached/i);
});

test('guest APIs validate public repository input without requiring a GitHub session', async () => {
  const snapshot = await fetch(new URL('/api/demo/snapshot?repository=invalid', baseUrl), { cache: 'no-store' });
  assert.equal(snapshot.status, 400);
  assert.match(snapshot.headers.get('cache-control') ?? '', /no-store/);
  const graph = await fetch(new URL('/api/demo/graph?repository=bad', baseUrl), { cache: 'no-store' });
  assert.equal(graph.status, 400);
  const node = await fetch(new URL('/api/demo/node/1?repository=bad', baseUrl), { cache: 'no-store' });
  assert.equal(node.status, 400);
  const importResponse = await fetch(new URL('/api/demo/import', baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repository: 'not-a-repository' }),
  });
  assert.equal(importResponse.status, 400);
  const emptyQuestion = await fetch(new URL('/api/demo/chat', baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repository: 'vercel/next.js', prompt: '  ' }),
  });
  assert.equal(emptyQuestion.status, 400);
});
