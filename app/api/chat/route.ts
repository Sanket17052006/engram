import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getGraph, isFalkorConfigured } from '@/lib/falkordb';
import { privateGraphName, readSession } from '@/lib/github-session';
import { answerFromGraph } from '@/lib/llm';

type Row = Record<string, unknown>;
type Intent = 'reviewer-router' | 'expertise-finder' | 'decision-trace' | 'contributor-activity' | 'project-guide';

const reviewerCypher = `
MATCH (repo:Repository {fullName:$repo})-[:HAS_ITEM]->(target:WorkItem {kind:'PR',number:$number})
MATCH (target)-[:MODIFIES]->(file:File)<-[:MODIFIES]-(prior:WorkItem {kind:'PR'})<-[:HAS_ITEM]-(repo)
MATCH (reviewer:Contributor)-[:SUBMITTED]->(review:Review)-[:ON_PR]->(prior)
WHERE prior <> target AND reviewer.login <> target.author AND review.state <> 'DISMISSED'
WITH target,reviewer,count(DISTINCT file) AS sharedFiles,count(DISTINCT prior) AS relatedReviews,
     collect(DISTINCT file.path)[0..5] AS matchingFiles,
     collect(DISTINCT {title:prior.title,url:prior.url,number:prior.number})[0..3] AS evidence
RETURN target.title AS targetTitle,target.url AS targetUrl,reviewer.login AS login,
       sharedFiles,relatedReviews,matchingFiles,evidence
ORDER BY sharedFiles DESC,relatedReviews DESC,login ASC LIMIT 5`;

const expertiseCypher = `
MATCH (repo:Repository {fullName:$repo})-[:HAS_ITEM]->(item:WorkItem {kind:'PR'})
MATCH (person:Contributor)-[:SUBMITTED]->(review:Review)-[:ON_PR]->(item)
WHERE review.state <> 'DISMISSED'
OPTIONAL MATCH (item)-[:MODIFIES]->(file:File)
WITH person,item,file
WHERE $term = '' OR toLower(item.title) CONTAINS $term OR toLower(coalesce(item.body,'')) CONTAINS $term
   OR toLower(coalesce(file.path,'')) CONTAINS $term
WITH person,count(DISTINCT item) AS relevantReviews,
     collect(DISTINCT {title:item.title,url:item.url,number:item.number})[0..5] AS evidence,
     collect(DISTINCT file.path)[0..8] AS files
RETURN person.login AS login,relevantReviews,evidence,files
ORDER BY relevantReviews DESC,login ASC LIMIT 8`;

const searchCypher = `
MATCH (repo:Repository {fullName:$repo})-[:HAS_ITEM]->(item:WorkItem)
WHERE toLower(item.title) CONTAINS $term OR toLower(coalesce(item.body,'')) CONTAINS $term
   OR ($number > 0 AND item.number=$number)
OPTIONAL MATCH (person:Contributor)-[:OPENED]->(item)
OPTIONAL MATCH (item)-[:MODIFIES]->(file:File)
OPTIONAL MATCH (reviewer:Contributor)-[:SUBMITTED]->(:Review)-[:ON_PR]->(item)
RETURN item.title AS title,item.kind AS kind,item.number AS number,item.url AS url,
       item.state AS state,item.author AS author,collect(DISTINCT person.login) AS contributors,
       collect(DISTINCT file.path)[0..5] AS files,collect(DISTINCT reviewer.login)[0..5] AS reviewers
ORDER BY item.updatedAt DESC LIMIT 8`;

const decisionCypher = `
MATCH (repo:Repository {fullName:$repo})-[:HAS_ITEM]->(item:WorkItem)
OPTIONAL MATCH (comment:Comment)-[:ON_ITEM]->(item)
WITH item,collect(DISTINCT {body:comment.body,url:comment.url,createdAt:comment.createdAt})[0..5] AS discussion
WHERE toLower(item.title) CONTAINS $term OR toLower(coalesce(item.body,'')) CONTAINS $term
   OR any(entry IN discussion WHERE toLower(coalesce(entry.body,'')) CONTAINS $term)
RETURN item.title AS title,item.kind AS kind,item.number AS number,item.state AS state,
       item.url AS url,item.updatedAt AS updatedAt,substring(coalesce(item.body,''),0,600) AS context,discussion
ORDER BY item.updatedAt DESC LIMIT 8`;

const contributorActivityCypher = `
MATCH (repo:Repository {fullName:$repo})-[:HAS_COMMIT]->(commit:Commit)
MATCH (person:Contributor)-[:AUTHORED]->(commit)
WHERE $term = '' OR toLower(commit.message) CONTAINS $term OR toLower(person.login) CONTAINS $term
WITH person,count(DISTINCT commit) AS commitsAuthored,max(commit.date) AS latestCommitAt,
     collect(DISTINCT {sha:commit.sha,message:commit.message,url:commit.url,date:commit.date})[0..5] AS evidence
RETURN person.login AS login,commitsAuthored,latestCommitAt,evidence
ORDER BY commitsAuthored DESC,latestCommitAt DESC,login ASC LIMIT 8`;

function resultRows(result: unknown): Row[] {
  if (!result || typeof result !== 'object' || !('data' in result)) return [];
  const rows = (result as { data?: unknown }).data;
  return Array.isArray(rows) ? rows.filter((row): row is Row => Boolean(row) && typeof row === 'object') : [];
}
function intentFor(prompt: string): Intent {
  if (/\b(review|reviewer|code review)\b/i.test(prompt) && /#?\d{2,}/.test(prompt)) return 'reviewer-router';
  if (/\b(commit|commits|contribut(?:ed|or|ors|ions?)|recent(?:ly)? active)\b/i.test(prompt)) return 'contributor-activity';
  if (/\b(who knows|expert|expertise|owner|owns|specialist|help with)\b/i.test(prompt)) return 'expertise-finder';
  if (/\b(decision|decided|rationale|why did|why was|why do we)\b/i.test(prompt)) return 'decision-trace';
  return 'project-guide';
}
function cleanTerm(prompt: string) {
  return prompt.toLowerCase().replace(/#?\d{2,}/g, ' ').replace(/[^a-z0-9_./ -]/g, ' ')
    .replace(/\b(who|should|could|would|can|has|have|worked|work|on|issue|pr|review|reviewer|knows|know|about|the|a|an|in|for|with|find|show|me|this|that|expert|expertise|owner|owns|specialist|help|decision|decided|rationale|why|did|was|do|we|contributed|contributor|contributors|contribution|contributions|commit|commits|recent|recently|active|activity)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function makeAnswer(intent: Intent, rows: Row[], number: number, term: string) {
  if (intent === 'reviewer-router') {
    if (!rows.length) return `I couldn't find a reviewer in the imported history with overlapping file experience for PR #${number}. Try importing more recent repository activity or inspect the PR directly.`;
    const first = rows[0];
    return `For PR #${number} (“${String(first.targetTitle)}”), ${String(first.login)} is the strongest evidence-backed reviewer: they reviewed ${String(first.relatedReviews)} related PR(s) touching ${String(first.sharedFiles)} of the same files. The ranking uses review history and file overlap from this repository.`;
  }
  if (intent === 'expertise-finder') {
    if (!rows.length) return term ? `I found no review history matching “${term}” in the imported graph. Try a filename or a broader topic.` : 'There is not enough review history in the imported graph to rank expertise yet.';
    const best = rows.slice(0, 3).map(row => `${String(row.login)} (${String(row.relevantReviews)} relevant reviews)`).join(', ');
    return `The strongest contributors in the matching review history are ${best}. These are signals from recorded reviews and changed files, not a claim about someone’s full expertise.`;
  }
  if (intent === 'decision-trace') {
    if (!rows.length) return term ? `I found no discussion matching “${term}” in the imported graph. Try a related PR or issue number.` : 'No decision-related discussion was found in this imported activity window.';
    return `I found ${rows.length} repository record(s) with matching discussion. These are source discussions that may explain the rationale; Engram does not treat a merged PR alone as an approved architecture decision.`;
  }
  if (intent === 'contributor-activity') {
    if (!rows.length) return 'No contributor-to-commit activity was found in the imported graph. Refresh the repository or check that commit history access is enabled.';
    const active = rows.slice(0, 3).map(row => `${String(row.login)} (${String(row.commitsAuthored)} imported commits)`).join(', ');
    return `In the imported commit window, the most active matched contributors are ${active}. This reflects recent commit history, not a complete measure of expertise or contribution.`;
  }
  if (!rows.length) return 'No matching pull request or issue was found in the imported activity window. Try a PR or issue number, contributor, topic, or filename.';
  const contributors = Array.from(new Set(rows.flatMap(row => [row.author, ...(Array.isArray(row.contributors) ? row.contributors : [])]).filter(Boolean)));
  return `Found ${rows.length} related repository record(s)${contributors.length ? ` involving ${contributors.slice(0, 5).join(', ')}` : ''}. Open the evidence links or inspect the Cypher query to see how they connect.`;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 500) : '';
  if (!prompt) return NextResponse.json({ error: 'Ask a question about the connected repository.' }, { status: 400 });
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'Sign in with GitHub and select a repository first.' }, { status: 401 });
  if (!session.selectedRepo) return NextResponse.json({ error: 'Select a repository before asking a question.' }, { status: 409 });
  const repository = session.selectedRepo;
  const intent = intentFor(prompt);
  const term = cleanTerm(prompt);
  const number = Number(prompt.match(/#?(\d{2,})/)?.[1] ?? 0);
  if (intent === 'decision-trace' && !term) return NextResponse.json({ error: 'Add a topic or repository term to trace the related discussion.' }, { status: 400 });
  if (!isFalkorConfigured()) return NextResponse.json({ error: 'Graph-backed answers need FalkorDB. Start the local Docker service and try again.' }, { status: 503 });

  try {
    const graph = await getGraph(privateGraphName(session.id, repository));
    const cypher = intent === 'reviewer-router' ? reviewerCypher : intent === 'expertise-finder' ? expertiseCypher : intent === 'decision-trace' ? decisionCypher : intent === 'contributor-activity' ? contributorActivityCypher : searchCypher;
    const params = intent === 'reviewer-router' ? { repo: repository, number } : intent === 'expertise-finder' || intent === 'decision-trace' || intent === 'contributor-activity' ? { repo: repository, term } : { repo: repository, term, number };
    const rows = resultRows(await graph.query(cypher, { params }));

    let memories: Row[] = [];
    {
      memories = resultRows(await graph.query(`MATCH (repo:Repository {fullName:$repo})-[:HAS_MEMORY]->(episode:Episode)
        WHERE episode.userId=$userId AND episode.id <> $episodeId
        RETURN episode.question AS question,episode.answer AS answer,episode.agent AS agent,episode.createdAt AS createdAt
        ORDER BY episode.createdAt DESC LIMIT 8`, { params: { repo: repository, userId: String(session.id), episodeId: '' } }));
    }

    let answer = makeAnswer(intent, rows, number, term);
    const normalizedPrompt = prompt.toLowerCase();
    const relevantMemories = memories.filter((memory) => {
      const previousQuestion = String(memory.question ?? '').toLowerCase();
      return term ? previousQuestion.includes(term) || normalizedPrompt.split(/\s+/).some((word: string) => word.length > 4 && previousQuestion.includes(word)) : true;
    }).slice(0, 3);
    if (relevantMemories.length) answer += ` This connects to an earlier question in your workspace: “${String(relevantMemories[0].question).slice(0, 180)}”.`;
    const sources = intent === 'reviewer-router'
      ? rows.flatMap(row => [
          { title: `PR #${String(row.number ?? number)} · ${String(row.targetTitle ?? '')}`, url: String(row.targetUrl ?? ''), role: 'Target pull request' },
          ...(Array.isArray(row.evidence) ? row.evidence as Row[] : []).map(item => ({ title: `PR #${String(item.number ?? '')} · ${String(item.title ?? '')}`, url: String(item.url ?? ''), role: 'Related review history' })),
        ]).filter(source => source.url)
      : intent === 'contributor-activity'
        ? rows.flatMap(row => (Array.isArray(row.evidence) ? row.evidence as Row[] : []).map(item => ({ title: `${String(row.login)} · ${String(item.message ?? 'Commit')}`, url: String(item.url ?? ''), role: `Commit · ${String(item.date ?? '')}` }))).filter(source => source.url)
      : rows.flatMap(row => [
        { title: `#${String(row.number ?? '')} · ${String(row.title ?? row.login ?? 'Contributor')}`, url: String(row.url ?? ''), role: String(row.kind ?? 'Contributor evidence') },
        ...(Array.isArray(row.discussion) ? row.discussion as Row[] : []).map(item => ({ title: 'Related discussion', url: String(item.url ?? ''), role: 'Source comment' })),
      ]).filter(source => source.url);
    const generatedAnswer = await answerFromGraph({ prompt, repository, intent, rows, sources, memories: relevantMemories });
    const answerMode = generatedAnswer ? 'openai' : 'graph-template';
    if (generatedAnswer) answer = generatedAnswer;
    const agentName = intent === 'reviewer-router' ? 'Reviewer Router' : intent === 'expertise-finder' ? 'Expertise Finder' : intent === 'decision-trace' ? 'Decision Trace' : intent === 'contributor-activity' ? 'Contributor Activity' : 'Project Guide';
    const createdAt = new Date().toISOString();
    const episodeId = randomUUID();
    {
      await graph.query(`MERGE (repo:Repository {fullName:$repo})
        MERGE (retriever:Agent {id:'context-retriever'}) SET retriever.name='Context Retriever'
        MERGE (agent:Agent {id:$agentId}) SET agent.name=$agentName
        MERGE (retriever)-[handoff:HANDED_OFF_TO]->(agent) SET handoff.lastUsedAt=$createdAt,handoff.intent=$intent
        MERGE (episode:Episode {id:$episodeId}) SET episode.userId=$userId,episode.question=$question,
          episode.answer=$answer,episode.agent=$agentName,episode.intent=$intent,episode.createdAt=$createdAt,
          episode.evidenceCount=$evidenceCount,episode.repository=$repo
        MERGE (repo)-[memory:HAS_MEMORY]->(episode) SET memory.createdAt=$createdAt,memory.agent=$agentName
        MERGE (agent)-[authored:WROTE]->(episode) SET authored.createdAt=$createdAt,authored.evidenceCount=$evidenceCount`, { params: {
        repo: repository, agentId: intent, agentName,
        episodeId, userId: String(session.id), question: prompt, answer, intent, createdAt, evidenceCount: rows.length,
      } });
      await graph.query(`MATCH (repo:Repository {fullName:$repo})-[:HAS_MEMORY]->(episode:Episode)
        WHERE episode.userId=$userId WITH episode ORDER BY episode.createdAt DESC SKIP 100 DETACH DELETE episode`, { params: { repo: repository, userId: String(session.id) } });
    }
    return NextResponse.json({ source: 'falkordb', repository, prompt, intent, answer, answerMode, llmConfigured: Boolean(process.env.OPENAI_API_KEY), rows, sources, cypher, params, memory: { used: relevantMemories.length > 0, count: relevantMemories.length, recent: relevantMemories }, handoff: { from: 'Context Retriever', to: agentName }, episodeId });
  } catch (error) {
    console.error('Graph-backed question failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'FalkorDB query failed.' }, { status: 503 });
  }
}
