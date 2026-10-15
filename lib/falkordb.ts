type FalkorGraph = { query: (query: string, options?: { params?: Record<string, unknown> }) => Promise<unknown> };

export function isFalkorConfigured() {
  return Boolean(process.env.FALKORDB_URL && process.env.ENGRAM_CORE_URL && process.env.ENGRAM_INTERNAL_API_KEY);
}

/** All FalkorDB driver connections now live in the private Python core. */
export async function getGraph(name: string) {
  return {
    query: async (query: string, options?: { params?: Record<string, unknown> }) => {
      const base = process.env.ENGRAM_CORE_URL?.replace(/\/$/, '');
      const key = process.env.ENGRAM_INTERNAL_API_KEY;
      if (!base || !key) throw new Error('The private FastAPI graph service is not configured.');
      const response = await fetch(`${base}/internal/graph/query`, {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(60_000),
        headers: { 'Content-Type': 'application/json', 'X-Engram-Core-Key': key },
        body: JSON.stringify({ graphName: name, query, params: options?.params ?? {} }),
      });
      const result = await response.json().catch(() => ({})) as { detail?: string; error?: string };
      if (!response.ok) throw new Error(result.detail ?? result.error ?? `FastAPI graph request failed (${response.status}).`);
      return result;
    },
  } satisfies FalkorGraph;
}
