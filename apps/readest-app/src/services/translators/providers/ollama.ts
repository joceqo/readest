import { stubTranslation as _ } from '@/utils/misc';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { normalizeToFullLang } from '@/utils/lang';
import { useSettingsStore } from '@/store/settingsStore';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import { TranslationProvider } from '../types';

const SYSTEM_PROMPT = (sourceLang: string, targetLang: string) =>
  `You are a professional translator. Translate the user's text from ${sourceLang} to ${targetLang}.\n` +
  'Output ONLY the translated text. Do not wrap it in quotes. ' +
  'Do not add explanations, commentary, or markdown. Preserve line breaks and inline formatting where possible.';

const getConfig = () => {
  // Reuse the AI Assistant's Ollama config so the user only configures the
  // server URL + model in one place (the LocalLLM settings panel writes to
  // the same fields). Accessed via getState() so the latest values are used
  // on every call without needing a hook.
  const state = useSettingsStore.getState();
  const aiSettings = state.settings?.aiSettings ?? DEFAULT_AI_SETTINGS;
  return {
    baseUrl: (aiSettings.ollamaBaseUrl || DEFAULT_AI_SETTINGS.ollamaBaseUrl).replace(/\/+$/, ''),
    // Empty string preserved so resolveModel() knows to auto-discover from
    // the server. The default fallback ('llama3.2') is applied only if the
    // server doesn't expose any model listing either.
    configuredModel: aiSettings.ollamaModel,
  };
};

// Cache the auto-detected model per base URL so we don't hit /v1/models or
// /api/tags before every line of every translation. TTL is short enough
// that swapping the loaded model in LM Studio without restarting Readest
// still gets picked up within ~30s.
const MODEL_DETECT_TTL_MS = 30 * 1000;
const detectedModelCache = new Map<string, { model: string; fetchedAt: number }>();

const detectServedModel = async (baseUrl: string): Promise<string | null> => {
  const cached = detectedModelCache.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAt < MODEL_DETECT_TTL_MS) {
    return cached.model || null;
  }
  // Inside Tauri's WebKit webview, plain `fetch` to a localhost server
  // fails with "Load failed" (the macOS WebKit CORS/CSP path rejects the
  // request even though the POST to /v1/chat/completions works through
  // the Tauri HTTP plugin). Route auto-detect through tauriFetch on
  // Tauri so the dropdown can actually populate.
  const detectFetch = isTauriAppPlatform() ? tauriFetch : window.fetch;
  // Try OpenAI-standard /v1/models first (works for LM Studio, vLLM,
  // llama.cpp's openai-compat mode, and many others). Then fall back to
  // Ollama's /api/tags. We pick the first model in the response.
  try {
    const v1url = `${baseUrl}/v1/models`;
    const v1 = await detectFetch(v1url).catch((err) => {
      console.warn('[ollamaProvider] /v1/models fetch threw:', err?.message ?? err);
      return null;
    });
    if (v1) {
      console.warn('[ollamaProvider] /v1/models status:', v1.status);
      if (v1.ok) {
        const data = await v1.json();
        const first: string | undefined = data?.data?.[0]?.id;
        console.warn('[ollamaProvider] /v1/models picked:', first, 'count:', data?.data?.length);
        if (first) {
          detectedModelCache.set(baseUrl, { model: first, fetchedAt: Date.now() });
          return first;
        }
      }
    }
    const tagsUrl = `${baseUrl}/api/tags`;
    const tags = await fetch(tagsUrl).catch((err) => {
      console.warn('[ollamaProvider] /api/tags fetch threw:', err?.message ?? err);
      return null;
    });
    if (tags) {
      console.warn('[ollamaProvider] /api/tags status:', tags.status);
      if (tags.ok) {
        const data = await tags.json();
        const first: string | undefined = data?.models?.[0]?.name;
        console.warn('[ollamaProvider] /api/tags picked:', first, 'count:', data?.models?.length);
        if (first) {
          detectedModelCache.set(baseUrl, { model: first, fetchedAt: Date.now() });
          return first;
        }
      }
    }
  } catch (err) {
    console.warn('[ollamaProvider] detectServedModel threw:', err);
  }
  detectedModelCache.set(baseUrl, { model: '', fetchedAt: Date.now() });
  return null;
};

const resolveModel = async (baseUrl: string, configuredModel: string): Promise<string> => {
  if (configuredModel) return configuredModel;
  const detected = await detectServedModel(baseUrl);
  if (detected) return detected;
  // Last resort: the legacy Ollama default. The user will get an error
  // back from the server if it doesn't have this model, which surfaces
  // the misconfiguration clearly.
  return DEFAULT_AI_SETTINGS.ollamaModel;
};

// Local LLMs often ignore "output only the translation" and wrap the answer
// in quotes or prefix it with "Sure! Here is the translation:" etc. We strip
// the most common offenders here so the cache and the rendered output stay
// clean. The cache layer keys on raw output, so cleaning before returning is
// what matters.
const cleanOutput = (raw: string): string => {
  let out = raw.trim();
  // Strip code fences if the model wrapped the answer in ```...```.
  out = out.replace(/^```[a-zA-Z]*\n?|\n?```$/g, '').trim();
  // Strip a single pair of wrapping quotes (straight or smart).
  const quotePairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['«', '»'],
  ];
  for (const [open, close] of quotePairs) {
    if (out.startsWith(open) && out.endsWith(close) && out.length >= 2) {
      out = out.slice(open.length, out.length - close.length).trim();
      break;
    }
  }
  return out;
};

async function translateOne(
  text: string,
  baseUrl: string,
  model: string,
  sourceLang: string,
  targetLang: string,
): Promise<string> {
  const fetchImpl = isTauriAppPlatform() ? tauriFetch : window.fetch;
  const url = `${baseUrl}/v1/chat/completions`;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT(sourceLang, targetLang) },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Translation failed with status ${response.status}`);
  }

  const data = await response.json();
  const content: unknown = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    return text;
  }
  const cleaned = cleanOutput(content);
  return cleaned.length > 0 ? cleaned : text;
}

export const ollamaProvider: TranslationProvider = {
  name: 'ollama',
  label: _('Local LLM'),
  authRequired: false,
  translate: async (texts: string[], sourceLang: string, targetLang: string): Promise<string[]> => {
    if (!texts.length) return [];

    const { baseUrl, configuredModel } = getConfig();
    const model = await resolveModel(baseUrl, configuredModel);
    console.warn(
      '[ollamaProvider] using baseUrl=',
      baseUrl,
      'model=',
      model,
      configuredModel ? '(configured)' : '(auto-detected)',
    );
    // Use full BCP-47-ish names ("English", "French") so the LLM gets a
    // language label it can actually reason about rather than a 2-letter
    // ISO code. normalizeToFullLang already returns names like
    // "English" / "French" / "zh-Hans" for known langs.
    const source = sourceLang === 'AUTO' ? 'the source language' : normalizeToFullLang(sourceLang);
    const target = normalizeToFullLang(targetLang);

    return Promise.all(
      texts.map(async (text) => {
        if (!text?.trim().length) return text;
        return translateOne(text, baseUrl, model, source, target);
      }),
    );
  },
};
