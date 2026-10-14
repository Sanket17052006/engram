export type GraphNode = { id: string; label: string; type: string; properties: Record<string, unknown> };
export type GraphEdge = { id: string; source: string; target: string; type: string; since?: string };
export const nodes: GraphNode[] = [
  { id: 'pr-442', label: 'PR #442', type: 'PR', properties: { status: 'open', title: 'Refresh OAuth tokens safely', url: 'https://github.com/acme/api/pull/442' } },
  { id: 'maya-chen', label: 'Maya Chen', type: 'Person', properties: { role: 'Senior Engineer', expertise: ['OAuth', 'Authentication', 'API security'], reviews: 12 } },
  { id: 'auth-service', label: 'auth-service', type: 'Project', properties: { owner: 'Maya Chen', language: 'TypeScript' } },
  { id: 'oauth-flow', label: 'OAuth flow', type: 'Decision', properties: { summary: 'Use rotating refresh tokens with reuse detection.' } },
  { id: 'alex-kim', label: 'Alex Kim', type: 'Person', properties: { role: 'Platform Engineer', expertise: ['Testing', 'CI/CD'] } },
  { id: 'token-file', label: 'token-refresh.ts', type: 'File', properties: { path: 'src/auth/token-refresh.ts' } },
  { id: 'review-memory', label: '3 recent reviews', type: 'Episode', properties: { period: 'Last quarter', count: 3 } },
];
export const edges: GraphEdge[] = [
  { id:'e1',source:'pr-442',target:'token-file',type:'MODIFIES' }, { id:'e2',source:'token-file',target:'auth-service',type:'PART_OF' },
  { id:'e3',source:'maya-chen',target:'auth-service',type:'OWNS' }, { id:'e4',source:'maya-chen',target:'oauth-flow',type:'EXPERT_IN' },
  { id:'e5',source:'maya-chen',target:'review-memory',type:'REVIEWED' }, { id:'e6',source:'alex-kim',target:'auth-service',type:'CONTRIBUTED_TO' },
  { id:'e7',source:'pr-442',target:'oauth-flow',type:'RELATES_TO' }, { id:'e8',source:'alex-kim',target:'review-memory',type:'BACKUP_REVIEWER' },
];
export const reviewerCypher = `MATCH (pr:PR {number: $prNumber})-[:MODIFIES]->(f:File)<-[:OWNS]-(p:Person)\nOPTIONAL MATCH (p)-[r:REVIEWED]->(similar:PR)-[:MODIFIES]->(f)\nRETURN p.name, count(DISTINCT f) AS ownership,\n       count(DISTINCT r) AS reviewExperience\nORDER BY reviewExperience DESC\nLIMIT 5`;
export function answerFor(prompt: string) {
  const lower = prompt.toLowerCase();
  let answer = `I found ${nodes.length} connected records for “${prompt}”. Maya Chen has the strongest match based on ownership, related expertise, and recent activity.`;
  if (lower.includes('decision') || lower.includes('why')) answer = 'The OAuth flow uses rotating refresh tokens with reuse detection. This decision is connected to auth-service and the recent token refresh work in PR #442.';
  else if (lower.includes('own') || lower.includes('expert')) answer = 'Maya Chen owns auth-service and is the team’s strongest OAuth and authentication specialist. Alex Kim is a useful second contact for testing and CI.';
  else if (lower.includes('review') || lower.includes('442')) answer = 'Maya Chen is the best reviewer for PR #442. She owns the OAuth flow and reviewed 3 related changes this quarter. Alex Kim is a strong second reviewer for the test infrastructure.';
  return { answer, reasoning: { plainEnglish: 'PR #442 changes the OAuth token refresh flow. The graph links the changed file to auth-service, then follows ownership, expertise, and recent reviews to Maya Chen.', cypher: reviewerCypher, params: { prNumber: 442 }, subgraphNodes: nodes.slice(0, 6), subgraphEdges: edges.slice(0, 7), sources: [{ title:'PR #442', url:'https://github.com/acme/api/pull/442' },{ title:'OAuth flow review', url:'https://github.com/acme/api/tree/main/src/auth' },{ title:'Maya Chen expertise', url:'https://github.com/maya-chen' }] } };
}
