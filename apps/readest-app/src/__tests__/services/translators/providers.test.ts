import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock environment module
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: vi.fn(() => false),
  getAPIBaseUrl: vi.fn(() => 'https://api.example.com'),
}));

vi.mock('@/utils/misc', () => ({
  stubTranslation: (s: string) => s,
}));

vi.mock('@/utils/lang', () => ({
  normalizeToShortLang: vi.fn((lang: string) => {
    const map: Record<string, string> = {
      'en-US': 'en',
      'fr-FR': 'fr',
      'zh-CN': 'zh',
      AUTO: 'auto',
      en: 'en',
      fr: 'fr',
      de: 'de',
      zh: 'zh',
      auto: 'auto',
    };
    return map[lang] ?? lang;
  }),
  normalizeToFullLang: vi.fn((lang: string) => {
    const map: Record<string, string> = {
      en: 'en',
      fr: 'fr',
      de: 'de',
      zh: 'zh-Hans',
      auto: 'auto',
    };
    return map[lang] ?? lang;
  }),
}));

// Mock Tauri HTTP plugin
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

// Stub Supabase so importing the full providers registry (which pulls in
// deepl.ts → @/utils/access → @/utils/supabase) doesn't instantiate a real
// GoTrueClient on every `vi.resetModules()` round. Without this, each test
// that dynamically imports the registry logs a "Multiple GoTrueClient
// instances" warning from the real Supabase client.
vi.mock('@/utils/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    from: vi.fn(),
  },
}));

// Stub the settings store so the ollama translator can read its baseUrl/model
// without a real zustand store. Tests override the returned state when they
// need different values.
const mockSettingsState = {
  settings: {
    aiSettings: {
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'llama3.2',
    },
  },
};
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: {
    getState: () => mockSettingsState,
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Google Translate Provider
// ---------------------------------------------------------------------------
describe('googleProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array for empty input', async () => {
    const { googleProvider } = await import('@/services/translators/providers/google');
    const result = await googleProvider.translate([], 'en', 'fr');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('translates text array', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [[['Bonjour', 'Hello']]],
    });

    const { googleProvider } = await import('@/services/translators/providers/google');
    const result = await googleProvider.translate(['Hello'], 'en', 'fr');
    expect(result).toEqual(['Bonjour']);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('preserves empty strings in input', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [[['translated', 'original']]],
    });

    const { googleProvider } = await import('@/services/translators/providers/google');
    const result = await googleProvider.translate(['', 'Hello'], 'en', 'fr');
    expect(result[0]).toBe('');
    expect(result[1]).toBe('translated');
  });

  it('throws on non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    const { googleProvider } = await import('@/services/translators/providers/google');
    await expect(googleProvider.translate(['Hello'], 'en', 'fr')).rejects.toThrow(
      'Translation failed with status 500',
    );
  });

  it('falls back to original text when response format is unexpected', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const { googleProvider } = await import('@/services/translators/providers/google');
    const result = await googleProvider.translate(['Hello'], 'en', 'fr');
    expect(result).toEqual(['Hello']);
  });

  it('has correct provider metadata', async () => {
    const { googleProvider } = await import('@/services/translators/providers/google');
    expect(googleProvider.name).toBe('google');
    expect(googleProvider.label).toBe('Google Translate');
  });
});

// ---------------------------------------------------------------------------
// Yandex Translate Provider
// ---------------------------------------------------------------------------
describe('yandexProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array for empty input', async () => {
    const { yandexProvider } = await import('@/services/translators/providers/yandex');
    const result = await yandexProvider.translate([], 'en', 'fr');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('translates text using yandexgpt service', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        translations: ['Bonjour'],
      }),
    });

    const { yandexProvider } = await import('@/services/translators/providers/yandex');
    const result = await yandexProvider.translate(['Hello'], 'en', 'fr');
    expect(result).toEqual(['Bonjour']);

    // Verify request format
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://translate.toil.cc/v2/translate/');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.service).toBe('yandexgpt');
    expect(body.lang).toBe('en-fr');
  });

  it('uses "en" when source language is AUTO', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        translations: ['Bonjour'],
      }),
    });

    const { yandexProvider } = await import('@/services/translators/providers/yandex');
    await yandexProvider.translate(['Hello'], 'AUTO', 'fr');

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.lang).toBe('en-fr');
  });

  it('throws on non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'rate limited' }),
    });

    const { yandexProvider } = await import('@/services/translators/providers/yandex');
    await expect(yandexProvider.translate(['Hello'], 'en', 'fr')).rejects.toThrow(
      'yandexgpt failed with status 429',
    );
  });

  it('falls back to original text when translations array is missing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const { yandexProvider } = await import('@/services/translators/providers/yandex');
    const result = await yandexProvider.translate(['Hello'], 'en', 'fr');
    expect(result).toEqual(['Hello']);
  });

  it('has correct provider metadata', async () => {
    const { yandexProvider } = await import('@/services/translators/providers/yandex');
    expect(yandexProvider.name).toBe('yandex');
    expect(yandexProvider.label).toBe('Yandex Translate');
    expect(yandexProvider.authRequired).toBe(false);
  });

  it('translates multiple texts in parallel', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        translations: ['Translated'],
      }),
    });

    const { yandexProvider } = await import('@/services/translators/providers/yandex');
    const result = await yandexProvider.translate(['Hello', 'World'], 'en', 'fr');
    expect(result).toEqual(['Translated', 'Translated']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Azure Translator Provider
// ---------------------------------------------------------------------------
describe('azureProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Suppress expected error noise from token fetch failure tests.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Reset the module-level token cache between tests by re-importing
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Helper: mock fetch to handle token + translation in sequence */
  function mockTokenAndTranslation(translationResponse: unknown) {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'mock-token',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => translationResponse,
      });
  }

  it('returns empty array for empty input', async () => {
    const { azureProvider } = await import('@/services/translators/providers/azure');
    const result = await azureProvider.translate([], 'en', 'fr');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('translates text with token authentication', async () => {
    mockTokenAndTranslation([{ translations: [{ text: 'Bonjour' }] }]);

    const { azureProvider } = await import('@/services/translators/providers/azure');
    const result = await azureProvider.translate(['Hello'], 'en', 'fr');
    expect(result).toEqual(['Bonjour']);
  });

  it('preserves empty strings', async () => {
    mockTokenAndTranslation([{ translations: [{ text: 'Monde' }] }]);

    const { azureProvider } = await import('@/services/translators/providers/azure');
    const result = await azureProvider.translate(['', 'World'], 'en', 'fr');
    expect(result[0]).toBe('');
    expect(result[1]).toBe('Monde');
  });

  it('throws when token fetch fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
    });

    const { azureProvider } = await import('@/services/translators/providers/azure');
    await expect(azureProvider.translate(['Hello'], 'en', 'fr')).rejects.toThrow(
      'Failed to get auth token: 403',
    );
  });

  it('throws when translation request fails', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'token',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

    const { azureProvider } = await import('@/services/translators/providers/azure');
    await expect(azureProvider.translate(['Hello'], 'en', 'fr')).rejects.toThrow(
      'Translation failed with status 500',
    );
  });

  it('falls back to original text when response format is unexpected', async () => {
    mockTokenAndTranslation([]);

    const { azureProvider } = await import('@/services/translators/providers/azure');
    const result = await azureProvider.translate(['Hello'], 'en', 'fr');
    expect(result).toEqual(['Hello']);
  });

  it('has correct provider metadata', async () => {
    const { azureProvider } = await import('@/services/translators/providers/azure');
    expect(azureProvider.name).toBe('azure');
    expect(azureProvider.label).toBe('Azure Translator');
  });
});

// ---------------------------------------------------------------------------
// Ollama (Local LLM) Translator Provider
// ---------------------------------------------------------------------------
describe('ollamaProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockSettingsState.settings.aiSettings.ollamaBaseUrl = 'http://127.0.0.1:11434';
    mockSettingsState.settings.aiSettings.ollamaModel = 'llama3.2';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockOk = (content: string) => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content } }],
      }),
    });
  };

  it('returns empty array for empty input', async () => {
    const { ollamaProvider } = await import('@/services/translators/providers/ollama');
    const result = await ollamaProvider.translate([], 'en', 'fr');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('translates text via OpenAI-compatible chat completions', async () => {
    mockOk('Bonjour');

    const { ollamaProvider } = await import('@/services/translators/providers/ollama');
    const result = await ollamaProvider.translate(['Hello'], 'en', 'fr');
    expect(result).toEqual(['Bonjour']);

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.model).toBe('llama3.2');
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toBe('Hello');
  });

  it('preserves empty strings without hitting the network', async () => {
    mockOk('translated');

    const { ollamaProvider } = await import('@/services/translators/providers/ollama');
    const result = await ollamaProvider.translate(['', 'Hello'], 'en', 'fr');
    expect(result[0]).toBe('');
    expect(result[1]).toBe('translated');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws on non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });

    const { ollamaProvider } = await import('@/services/translators/providers/ollama');
    await expect(ollamaProvider.translate(['Hello'], 'en', 'fr')).rejects.toThrow(
      'Translation failed with status 500',
    );
  });

  it('uses the configured base URL and model from settings', async () => {
    mockSettingsState.settings.aiSettings.ollamaBaseUrl = 'http://lmstudio.local:1234';
    mockSettingsState.settings.aiSettings.ollamaModel = 'qwen2.5:7b';
    mockOk('Hallo');

    const { ollamaProvider } = await import('@/services/translators/providers/ollama');
    await ollamaProvider.translate(['Hello'], 'en', 'de');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://lmstudio.local:1234/v1/chat/completions');
    expect(JSON.parse(opts.body).model).toBe('qwen2.5:7b');
  });

  it('falls back to original text when response shape is unexpected', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: true }),
    });

    const { ollamaProvider } = await import('@/services/translators/providers/ollama');
    const result = await ollamaProvider.translate(['Hello'], 'en', 'fr');
    expect(result).toEqual(['Hello']);
  });

  it('strips wrapping quotes from model output', async () => {
    mockOk('"Bonjour"');

    const { ollamaProvider } = await import('@/services/translators/providers/ollama');
    const result = await ollamaProvider.translate(['Hello'], 'en', 'fr');
    expect(result).toEqual(['Bonjour']);
  });

  it('has correct provider metadata', async () => {
    const { ollamaProvider } = await import('@/services/translators/providers/ollama');
    expect(ollamaProvider.name).toBe('ollama');
    expect(ollamaProvider.label).toBe('Local LLM');
  });

  it('limits concurrent in-flight requests to LM Studio', async () => {
    // Build a fetch mock where every call returns a controllable Deferred.
    // This lets us count how many requests are *currently active* while the
    // semaphore decides whether to start the next one.
    const pending: { resolve: (v: unknown) => void }[] = [];
    mockFetch.mockImplementation(() => {
      let resolve!: (v: unknown) => void;
      const promise = new Promise<unknown>((res) => {
        resolve = res;
      });
      pending.push({ resolve });
      // The provider awaits `.json()` on the response, so wrap accordingly.
      return promise.then((content) => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content } }] }),
      }));
    });

    // Yield enough microtasks for the semaphore + fetch chain to settle. Each
    // released slot has to walk through several awaits (acquire resolve →
    // translateOne → fetch → response.json) before the next mockFetch is hit,
    // so we need more than 1–2 ticks.
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    const { ollamaProvider, MAX_CONCURRENT_LOCAL_REQUESTS } =
      await import('@/services/translators/providers/ollama');

    // Kick off many translations at once.
    const inputs = Array.from({ length: 8 }, (_, i) => `text-${i}`);
    const resultPromise = ollamaProvider.translate(inputs, 'en', 'fr');

    await settle();

    // Only MAX_CONCURRENT_LOCAL_REQUESTS calls should be in flight, not all 8.
    expect(pending.length).toBe(MAX_CONCURRENT_LOCAL_REQUESTS);

    // Drain: each time we resolve all currently in-flight requests, the
    // semaphore should admit exactly that many more (until inputs run out).
    let resolved = 0;
    while (resolved < inputs.length) {
      for (let i = resolved; i < pending.length; i++) {
        pending[i]!.resolve(`translated-${i}`);
      }
      resolved = pending.length;
      await settle();
    }

    const result = await resultPromise;
    expect(result).toEqual(inputs.map((_, i) => `translated-${i}`));
    // We must have fired exactly one fetch per input (no extras, no drops).
    expect(pending.length).toBe(inputs.length);
  });
});

// ---------------------------------------------------------------------------
// Provider registry — disabled providers stay visible but unselectable
// ---------------------------------------------------------------------------
describe('provider registry disabled handling', () => {
  // No `vi.resetModules()` here — these tests only inspect static provider
  // metadata, so resolving the registry once is enough. Resetting between
  // each test would re-evaluate the full import chain and churn module
  // state for no benefit.

  it('keeps yandex in getTranslators() so the UI can render it', async () => {
    const { getTranslators } = await import('@/services/translators/providers');
    const names = getTranslators().map((t) => t.name);
    expect(names).toContain('yandex');
  });

  it('exposes yandex as disabled so callers can grey it out', async () => {
    const { getTranslator } = await import('@/services/translators/providers');
    const yandex = getTranslator('yandex');
    expect(yandex).toBeDefined();
    expect(yandex!.disabled).toBe(true);
  });

  it('isTranslatorAvailable returns false for disabled providers', async () => {
    const { getTranslator, isTranslatorAvailable } =
      await import('@/services/translators/providers');
    const yandex = getTranslator('yandex')!;
    expect(isTranslatorAvailable(yandex, true)).toBe(false);
    expect(isTranslatorAvailable(yandex, false)).toBe(false);
  });

  it('isTranslatorAvailable returns false for authRequired without token', async () => {
    const { isTranslatorAvailable } = await import('@/services/translators/providers');
    const authed = { name: 'x', label: 'X', authRequired: true, translate: async () => [] };
    expect(isTranslatorAvailable(authed, false)).toBe(false);
    expect(isTranslatorAvailable(authed, true)).toBe(true);
  });

  it('isTranslatorAvailable returns false when quota is exceeded', async () => {
    const { isTranslatorAvailable } = await import('@/services/translators/providers');
    const exhausted = { name: 'x', label: 'X', quotaExceeded: true, translate: async () => [] };
    expect(isTranslatorAvailable(exhausted, true)).toBe(false);
  });

  it('getTranslatorDisplayLabel returns the plain label for healthy providers', async () => {
    const { getTranslator, getTranslatorDisplayLabel } =
      await import('@/services/translators/providers');
    const google = getTranslator('google')!;
    expect(getTranslatorDisplayLabel(google, true, (s) => s)).toBe('Google Translate');
  });
});
