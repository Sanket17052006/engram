type FalkorGraph = { query: (query: string, options?: { params?: Record<string, unknown> }) => Promise<unknown> };
type FalkorConnection = { selectGraph: (name: string) => FalkorGraph };
let connection: Promise<FalkorConnection> | undefined;

export function isFalkorConfigured() { return Boolean(process.env.FALKORDB_URL); }

export async function getGraph(name = process.env.FALKORDB_GRAPH || 'engram_company') {
  const url = process.env.FALKORDB_URL;
  if (!url) throw new Error('FALKORDB_URL is not configured');
  connection ??= import('falkordb').then(({ FalkorDB }) => FalkorDB.connect({ url })) as Promise<FalkorConnection>;
  return (await connection).selectGraph(name);
}
