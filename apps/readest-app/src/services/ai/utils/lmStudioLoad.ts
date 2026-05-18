import type { AISettings } from '../types';
import { localAiFetch } from './localAiFetch';
import { aiLogger } from '../logger';
import i18n from '@/i18n/i18n';
import { eventDispatcher } from '@/utils/event';

const DEFAULT_BASE = 'http://127.0.0.1:1234';

const LM_MSG = {
  listFail:
    'LM Studio: could not read the model list. Start the Local Server and confirm the URL under Settings → AI.',
  noneInstalled:
    'LM Studio: no models installed. Download at least one model in LM Studio, then try again.',
  noEmbeddingType:
    'LM Studio: no embedding models installed. Add an embedding model in LM Studio for indexing and search.',
  noLlmType:
    'LM Studio: no chat (LLM) models installed. Add a language model in LM Studio for the AI assistant.',
  embedNotFound:
    'LM Studio: the embedding model in Settings was not found. Pick a model from the list in LM Studio under Settings → AI.',
  chatNotFound:
    'LM Studio: the chat model in Settings was not found. Pick a model from the list in LM Studio under Settings → AI.',
} as const;

let lmStudioToastState: { key: string; at: number } = { key: '', at: 0 };
const TOAST_COOLDOWN_MS = 10_000;

function tr(messageKey: string): string {
  return i18n.t(messageKey);
}

function showLmStudioToast(
  dedupeKey: string,
  messageKey: string,
  type: 'warning' | 'error' = 'warning',
) {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (lmStudioToastState.key === dedupeKey && now - lmStudioToastState.at < TOAST_COOLDOWN_MS) {
    return;
  }
  lmStudioToastState = { key: dedupeKey, at: now };
  void eventDispatcher.dispatch('toast', {
    type,
    message: tr(messageKey),
    timeout: 8000,
  });
}

type NativeModel = {
  type: string;
  key: string;
  loaded_instances?: unknown[];
  variants?: string[];
};

function lmBase(settings: AISettings): string {
  return (settings.lmstudioBaseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

/** Map OpenAI-style `id` (from `/v1/models`) or short names to LM Studio native `key`. Exported for tests. */
export function pickNativeModel(configured: string, pool: NativeModel[]): NativeModel | null {
  const c = configured.trim();
  if (!c || pool.length === 0) return null;

  let m = pool.find((x) => x.key === c);
  if (m) return m;
  const cl = c.toLowerCase();
  m = pool.find((x) => x.key.toLowerCase() === cl);
  if (m) return m;

  m = pool.find((x) => (x.key.split('/').pop() ?? x.key) === c);
  if (m) return m;
  m = pool.find((x) => (x.key.split('/').pop() ?? x.key).toLowerCase() === cl);
  if (m) return m;

  for (const x of pool) {
    for (const v of x.variants ?? []) {
      if (v === c || v.split('@')[0] === c) return x;
    }
  }
  return null;
}

async function fetchNativeModels(base: string): Promise<NativeModel[] | null> {
  try {
    const res = await localAiFetch(`${base}/api/v1/models`);
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: NativeModel[] };
    return data.models ?? [];
  } catch {
    return null;
  }
}

async function loadModelIfUnloaded(base: string, key: string): Promise<void> {
  const models = await fetchNativeModels(base);
  if (!models) return;

  const entry = models.find((m) => m.key === key);
  if (!entry) return;
  if ((entry.loaded_instances?.length ?? 0) > 0) return;

  aiLogger.provider.lmStudioLoad(key);
  const loadRes = await localAiFetch(`${base}/api/v1/models/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: key }),
  });
  if (!loadRes.ok) {
    const txt = await loadRes.text();
    throw new Error(
      `LM Studio could not load "${key}" (${loadRes.status}). ${txt.slice(0, 500)}`.trim(),
    );
  }
}

export type LmStudioResolvedModels = {
  /** Pass to `LMStudioProvider.setEmbeddingModelIdOverride` so /v1/embeddings matches the loaded model. */
  embeddingModelId?: string;
  chatModelId?: string;
};

/**
 * If LM Studio's REST server is running but no model is loaded in GPU RAM,
 * POST /api/v1/models/load for the configured chat and/or embedding keys.
 *
 * When Settings has no embedding or chat model picked, uses the first installed
 * model of that type so auto-load still works with LM Studio's "no models loaded" state.
 *
 * @see https://lmstudio.ai/docs/developer/rest/load
 */
export async function ensureLMStudioModelsLoaded(
  settings: AISettings,
  intent: { chat?: boolean; embedding?: boolean } = {},
): Promise<LmStudioResolvedModels> {
  const out: LmStudioResolvedModels = {};
  if (settings.provider !== 'lmstudio') return out;

  const { chat = true, embedding = true } = intent;
  const base = lmBase(settings);

  const models = await fetchNativeModels(base);
  if (models === null) {
    showLmStudioToast('lmstudio-list-fail', LM_MSG.listFail);
    return out;
  }
  if (models.length === 0) {
    showLmStudioToast('lmstudio-none-installed', LM_MSG.noneInstalled);
    return out;
  }

  const embeddingPool = models.filter((x) => x.type === 'embedding');
  const llmPool = models.filter((x) => x.type === 'llm');

  if (embedding) {
    if (embeddingPool.length === 0) {
      showLmStudioToast('lmstudio-no-embed-type', LM_MSG.noEmbeddingType);
    } else {
      const configured = settings.lmstudioEmbeddingModel?.trim();
      let picked: NativeModel | null = null;
      if (configured) {
        picked = pickNativeModel(configured, embeddingPool);
        if (!picked) {
          showLmStudioToast('lmstudio-embed-mismatch', LM_MSG.embedNotFound);
        }
      } else {
        picked = embeddingPool[0]!;
      }
      if (picked) {
        if ((picked.loaded_instances?.length ?? 0) === 0) {
          await loadModelIfUnloaded(base, picked.key);
        }
        out.embeddingModelId = picked.key;
      }
    }
  }

  if (chat) {
    if (llmPool.length === 0) {
      showLmStudioToast('lmstudio-no-llm-type', LM_MSG.noLlmType);
    } else {
      const configured = settings.lmstudioModel?.trim();
      let picked: NativeModel | null = null;
      if (configured) {
        picked = pickNativeModel(configured, llmPool);
        if (!picked) {
          showLmStudioToast('lmstudio-chat-mismatch', LM_MSG.chatNotFound);
        }
      } else {
        picked = llmPool[0]!;
      }
      if (picked) {
        if ((picked.loaded_instances?.length ?? 0) === 0) {
          await loadModelIfUnloaded(base, picked.key);
        }
        out.chatModelId = picked.key;
      }
    }
  }

  return out;
}
