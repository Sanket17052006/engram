import { readSession } from '@/lib/github-session';
import { getLlmConfiguration } from '@/lib/llm';
import { privateJson } from '@/lib/private-response';

export async function GET() {
  const session = await readSession();
  const llm = getLlmConfiguration();
  return privateJson({
    appConfigured: Boolean(process.env.GITHUB_APP_SLUG && process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET),
    databaseConfigured: Boolean(process.env.FALKORDB_URL),
    coreConfigured: Boolean(process.env.ENGRAM_CORE_URL && process.env.ENGRAM_INTERNAL_API_KEY),
    llmConfigured: llm.configured,
    llmProvider: llm.provider,
    llmModel: llm.model,
    connected: Boolean(session?.installationId),
    authenticated: Boolean(session),
    user: session ? { id: session.id, login: session.login, avatar: session.avatar } : null,
    selectedRepo: session?.selectedRepo ?? null,
  });
}
