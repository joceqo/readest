import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the translation cache so each test starts from a clean slate.
const cacheStore = new Map<string, string>();
vi.mock('@/services/translators/cache', () => ({
  getFromCache: vi.fn(async (text: string, src: string, tgt: string, prov: string) => {
    return cacheStore.get(`${prov}:${src}:${tgt}:${text}`) ?? null;
  }),
  storeInCache: vi.fn(
    async (text: string, translation: string, src: string, tgt: string, prov: string) => {
      cacheStore.set(`${prov}:${src}:${tgt}:${text}`, translation);
    },
  ),
}));

import { translateSection } from '@/services/translation/sectionTranslator';
import type { TranslationProvider } from '@/services/translators/types';

const parseHtml = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

const makeMockProvider = (
  fn: (texts: string[]) => string[],
  name = 'mock',
): TranslationProvider & { translate: ReturnType<typeof vi.fn> } => ({
  name: name as TranslationProvider['name'],
  label: 'Mock',
  authRequired: false,
  translate: vi.fn(async (texts: string[]) => fn(texts)),
});

describe('translateSection', () => {
  beforeEach(() => {
    cacheStore.clear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('replaces text in each translation unit with the provider output', async () => {
    const doc = parseHtml(`
      <html><body>
        <p>Hello world</p>
        <p>Second paragraph</p>
      </body></html>
    `);
    const provider = makeMockProvider((texts) =>
      texts.map((t) => (t === 'Hello world' ? 'Bonjour le monde' : 'Deuxième paragraphe')),
    );

    const result = await translateSection({
      sourceDoc: doc,
      sourceLang: 'en',
      targetLang: 'fr',
      provider,
    });

    expect(result.unitCount).toBe(2);
    expect(result.cacheHitCount).toBe(0);
    expect(result.fetchedCount).toBe(2);
    expect(result.xhtml).toContain('Bonjour le monde');
    expect(result.xhtml).toContain('Deuxième paragraphe');
    expect(result.xhtml).not.toContain('Hello world');
    expect(result.xhtml).not.toContain('Second paragraph');
  });

  it('serves cache hits and only fetches uncached', async () => {
    cacheStore.set('mock:en:fr:Cached line', 'Ligne en cache');
    const doc = parseHtml(`
      <html><body>
        <p>Cached line</p>
        <p>Uncached line</p>
      </body></html>
    `);
    const provider = makeMockProvider((texts) => texts.map((t) => `[fr] ${t}`));

    const result = await translateSection({
      sourceDoc: doc,
      sourceLang: 'en',
      targetLang: 'fr',
      provider,
    });

    expect(result.cacheHitCount).toBe(1);
    expect(result.fetchedCount).toBe(1);
    // Provider was called once, with only the uncached batch
    expect(provider.translate).toHaveBeenCalledOnce();
    expect(provider.translate.mock.calls[0]![0]).toEqual(['Uncached line']);
    expect(result.xhtml).toContain('Ligne en cache');
    expect(result.xhtml).toContain('[fr] Uncached line');
  });

  it('dedupes identical strings across the section (one API call for repeats)', async () => {
    const doc = parseHtml(`
      <html><body>
        <h2>Chapter title</h2>
        <p>First</p>
        <h2>Chapter title</h2>
        <p>Second</p>
      </body></html>
    `);
    const provider = makeMockProvider((texts) => texts.map((t) => `[fr] ${t}`));

    const result = await translateSection({
      sourceDoc: doc,
      sourceLang: 'en',
      targetLang: 'fr',
      provider,
    });

    // 4 elements but 3 unique strings ("Chapter title", "First", "Second")
    expect(result.unitCount).toBe(4);
    expect(result.fetchedCount).toBe(3);
    expect(provider.translate.mock.calls.flatMap((c) => c[0])).toEqual(
      expect.arrayContaining(['Chapter title', 'First', 'Second']),
    );
    expect(result.xhtml.match(/\[fr\] Chapter title/g)?.length).toBe(2);
  });

  it('batches according to chunkSize', async () => {
    const doc = parseHtml(`
      <html><body>
        <p>A</p><p>B</p><p>C</p><p>D</p><p>E</p><p>F</p><p>G</p>
      </body></html>
    `);
    const provider = makeMockProvider((texts) => texts.map((t) => `[fr] ${t}`));

    await translateSection({
      sourceDoc: doc,
      sourceLang: 'en',
      targetLang: 'fr',
      provider,
      chunkSize: 3,
    });

    // 7 unique texts, chunkSize=3 → calls of size 3, 3, 1
    expect(provider.translate.mock.calls.map((c) => c[0].length)).toEqual([3, 3, 1]);
  });

  it('loses inline emphasis inside a unit but preserves outer structure', async () => {
    const doc = parseHtml(`
      <html><body>
        <p>Hello <em>world</em>!</p>
        <p>Done</p>
      </body></html>
    `);
    const provider = makeMockProvider((texts) =>
      texts.map((t) => (t.includes('Hello') ? 'Bonjour le monde !' : 'Fini')),
    );

    const result = await translateSection({
      sourceDoc: doc,
      sourceLang: 'en',
      targetLang: 'fr',
      provider,
    });

    // <em> inside the translated <p> goes away (v1 limitation), but the
    // surrounding <p>...</p> structure remains.
    expect(result.xhtml).toContain('Bonjour le monde !');
    expect(result.xhtml).not.toContain('<em>');
    expect(result.xhtml).toContain('Fini');
  });

  it('falls back to source text when provider throws on a chunk', async () => {
    const doc = parseHtml(`
      <html><body>
        <p>Keeps going</p>
        <p>Also keeps going</p>
      </body></html>
    `);
    const provider = makeMockProvider(() => {
      throw new Error('upstream down');
    });

    const result = await translateSection({
      sourceDoc: doc,
      sourceLang: 'en',
      targetLang: 'fr',
      provider,
    });

    expect(result.fetchedCount).toBe(0);
    // Source text remains because translation failed.
    expect(result.xhtml).toContain('Keeps going');
    expect(result.xhtml).toContain('Also keeps going');
  });

  it('skips pre/code/math content', async () => {
    const doc = parseHtml(`
      <html><body>
        <p>Translate me</p>
        <pre>do not translate</pre>
        <code>also not</code>
      </body></html>
    `);
    const provider = makeMockProvider((texts) => texts.map((t) => `[fr] ${t}`));

    const result = await translateSection({
      sourceDoc: doc,
      sourceLang: 'en',
      targetLang: 'fr',
      provider,
    });

    expect(result.xhtml).toContain('[fr] Translate me');
    expect(result.xhtml).toContain('do not translate');
    expect(result.xhtml).toContain('also not');
    // Only the <p> was offered to the provider.
    expect(provider.translate.mock.calls[0]![0]).toEqual(['Translate me']);
  });

  it('throws when sourceDoc has no <body>', async () => {
    const doc = new DOMParser().parseFromString('<root />', 'text/xml');
    const provider = makeMockProvider((t) => t);
    await expect(
      translateSection({
        sourceDoc: doc,
        sourceLang: 'en',
        targetLang: 'fr',
        provider,
      }),
    ).rejects.toThrow(/no <body>/);
  });
});
