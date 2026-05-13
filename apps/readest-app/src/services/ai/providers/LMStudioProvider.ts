import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { AIProvider, AISettings, AIProviderName } from '../types';
import { aiLogger } from '../logger';
import { AI_TIMEOUTS } from '../utils/retry';

const DEFAULT_BASE = 'http://127.0.0.1:1234';

/**
 * LM Studio (or any other OpenAI-compatible local server) — uses the
 * `@ai-sdk/openai-compatible` generic provider pointed at the user's local
 * `/v1` endpoint. Works for chat and embeddings as long as the loaded
 * model exposes them.
 *
 * Mirrors the shape of OllamaProvider so the existing AI Assistant
 * features (chat, RAG) work without further wiring.
 */
export class LMStudioProvider implements AIProvider {
  id: AIProviderName = 'lmstudio';
  name = 'LM Studio (Local)';
  requiresAuth = false;

  private client;
  private settings: AISettings;

  constructor(settings: AISettings) {
    this.settings = settings;
    const baseUrl = (settings.lmstudioBaseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    this.client = createOpenAICompatible({
      name: 'lmstudio',
      // OpenAI-compat endpoints live under `/v1` (e.g. /v1/chat/completions).
      baseURL: `${baseUrl}/v1`,
      // LM Studio doesn't require an API key locally; the SDK still sends
      // an Authorization header so we provide a placeholder value to
      // satisfy strict OpenAI-style HTTP clients.
      apiKey: 'lm-studio',
    });
    aiLogger.provider.init('lmstudio', settings.lmstudioModel || 'unset');
  }

  getModel(): LanguageModel {
    return this.client(this.settings.lmstudioModel || 'gpt-4o-mini');
  }

  getEmbeddingModel(): EmbeddingModel {
    return this.client.textEmbeddingModel(
      this.settings.lmstudioEmbeddingModel || 'text-embedding-3-small',
    );
  }

  /**
   * LM Studio exposes `/v1/models` (OpenAI standard) once its Local Server
   * is started. We treat that endpoint's reachability as "available". If
   * the user has the app open but the server tab is off, this returns
   * false — that's the actionable signal.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_TIMEOUTS.OLLAMA_CONNECT);
      const base = (this.settings.lmstudioBaseUrl || DEFAULT_BASE).replace(/\/+$/, '');
      const response = await fetch(`${base}/v1/models`, { signal: controller.signal });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_TIMEOUTS.HEALTH_CHECK);
      const base = (this.settings.lmstudioBaseUrl || DEFAULT_BASE).replace(/\/+$/, '');
      const response = await fetch(`${base}/v1/models`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return false;
      const data = await response.json();
      const ids: string[] = (data?.data ?? []).map((m: { id: string }) => m.id).filter(Boolean);
      const chatId = this.settings.lmstudioModel ?? '';
      // Embedding model is optional — only required when the user has set
      // one, since LM Studio commonly loads only a chat model. A missing
      // embedding setting just means "embeddings not configured here", not
      // "unhealthy".
      const embeddingId = this.settings.lmstudioEmbeddingModel ?? '';
      const chatOk = chatId.length === 0 || ids.some((id) => id.includes(chatId.split(':')[0]!));
      const embeddingOk =
        embeddingId.length === 0 || ids.some((id) => id.includes(embeddingId.split(':')[0]!));
      return chatOk && embeddingOk;
    } catch (e) {
      aiLogger.provider.error('lmstudio', (e as Error).message);
      return false;
    }
  }
}
