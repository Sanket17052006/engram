export const MODEL_PROVIDERS = [
  { id: 'openai', label: 'OpenAI', needsKey: true, hint: 'OpenAI API' },
  { id: 'anthropic', label: 'Anthropic', needsKey: true, hint: 'Anthropic API' },
  { id: 'gemini', label: 'Google Gemini', needsKey: true, hint: 'Gemini API' },
  { id: 'groq', label: 'Groq', needsKey: true, hint: 'OpenAI-compatible' },
  { id: 'openrouter', label: 'OpenRouter', needsKey: true, hint: 'OpenAI-compatible' },
  { id: 'together', label: 'Together AI', needsKey: true, hint: 'OpenAI-compatible' },
  { id: 'deepseek', label: 'DeepSeek', needsKey: true, hint: 'OpenAI-compatible' },
  { id: 'ollama', label: 'Ollama', needsKey: false, hint: 'Local endpoint' },
] as const;

export type ModelProvider = typeof MODEL_PROVIDERS[number]['id'];
export type UserModelConfig = { provider: ModelProvider; model: string; apiKey?: string };
const STORAGE_KEY = 'engram.model-config.v1';

export function readUserModelConfig(): UserModelConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<UserModelConfig>;
    const provider = MODEL_PROVIDERS.find(item => item.id === value.provider);
    if (!provider || typeof value.model !== 'string' || !value.model.trim()) return null;
    if (provider.needsKey && (typeof value.apiKey !== 'string' || !value.apiKey)) return null;
    return { provider: provider.id, model: value.model.trim(), ...(provider.needsKey ? { apiKey: value.apiKey } : {}) };
  } catch { return null; }
}

export function saveUserModelConfig(value: UserModelConfig | null) {
  if (typeof window === 'undefined') return;
  if (!value) window.sessionStorage.removeItem(STORAGE_KEY);
  else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}
