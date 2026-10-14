import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.ENGRAM_E2E_URL ?? 'http://localhost:3100';
async function getJson(path, init) {
  const response = await fetch(new URL(path, baseUrl), init);
  const data = await response.json();
  return { response, data };
}

test('GitHub status reports configured services without exposing credentials', async () => {
  const { response, data } = await getJson('/api/github/status', { cache: 'no-store' });
  assert.equal(response.status, 200);
  assert.equal(data.databaseConfigured, true);
  assert.equal(data.appConfigured, true);
  assert.equal(data.authenticated, false);
  assert.equal('token' in data, false);
  assert.equal('clientSecret' in data, false);
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
  const sync = await fetch(new URL('/api/github/sync', baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repository: 'internetarchive/openlibrary' }),
  });
  assert.equal(sync.status, 401);
});

test('graph-backed questions validate input and run against FalkorDB', async () => {
  const empty = await fetch(new URL('/api/openlibrary/ask', baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '   ' }),
  });
  assert.equal(empty.status, 400);

  for (const prompt of ['Who should review PR #442?', 'Who knows OAuth?', 'What decision explains OAuth?', 'What changed around OAuth?']) {
    const { response, data } = await getJson('/api/openlibrary/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }),
    });
    assert.equal(response.status, 200, `${prompt}: ${data.error ?? 'request failed'}`);
    assert.equal(data.source, 'falkordb');
    assert.ok(data.cypher.includes('MATCH'));
    assert.equal(typeof data.answer, 'string');
  }
});

test('graph explorer returns graph-shaped results', async () => {
  const { response, data } = await getJson('/api/graph/explore?workspace=openlibrary', { cache: 'no-store' });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(data.nodes));
  assert.ok(Array.isArray(data.edges));
  if (data.nodes.length) {
    assert.ok(data.nodes.some((node) => Object.keys(node.properties ?? {}).length > 0), 'graph nodes should expose source attributes');
  }
  if (data.edges.length) {
    assert.ok(data.edges.some((edge) => Object.keys(edge.properties ?? {}).length > 0), 'graph relationships should expose context attributes');
  }
});
