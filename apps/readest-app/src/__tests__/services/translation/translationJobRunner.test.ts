import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BookDoc, SectionItem } from '@/libs/document';
import type { Book } from '@/types/book';
import type { AppService, BaseDir, FileSystem } from '@/types/system';
import { TranslatedArtifactStore } from '@/services/translation/translatedArtifactStore';
import { runTranslationJob } from '@/services/translation/translationJobRunner';

// Mock the provider registry so we can control translation output.
vi.mock('@/services/translators', () => ({
  getTranslator: vi.fn(),
}));

// Mock the cache to keep tests hermetic.
vi.mock('@/services/translators/cache', () => ({
  getFromCache: vi.fn(async () => null),
  storeInCache: vi.fn(async () => {}),
}));

import { getTranslator } from '@/services/translators';

const makeFsStub = (): FileSystem => {
  const data = new Map<string, string>();
  const dirs = new Set<string>(['']);
  const k = (path: string, base: BaseDir) => `${base}:${path}`;
  return {
    resolvePath: vi.fn(),
    getURL: vi.fn(),
    getBlobURL: vi.fn(),
    getImageURL: vi.fn(),
    openFile: vi.fn(),
    copyFile: vi.fn(),
    readFile: vi.fn(async (p, b) => {
      const key = k(p, b);
      if (!data.has(key)) throw new Error('ENOENT');
      return data.get(key)!;
    }),
    writeFile: vi.fn(async (p, b, c) => {
      data.set(k(p, b), c as string);
    }),
    removeFile: vi.fn(async (p, b) => {
      data.delete(k(p, b));
    }),
    readDir: vi.fn(),
    createDir: vi.fn(async (p, b) => {
      dirs.add(k(p, b));
    }),
    removeDir: vi.fn(async (p, b) => {
      const prefix = k(p, b);
      for (const key of Array.from(data.keys())) {
        if (key === prefix || key.startsWith(`${prefix}/`)) data.delete(key);
      }
    }),
    exists: vi.fn(async (p, b) => {
      const key = k(p, b);
      if (data.has(key) || dirs.has(key)) return true;
      for (const dk of data.keys()) if (dk.startsWith(`${key}/`)) return true;
      return false;
    }),
    stats: vi.fn(),
    getPrefix: vi.fn(),
  };
};

const makeAppService = (fs: FileSystem): AppService => {
  return {
    // Only the bits the job runner touches are implemented; the rest
    // throw if accidentally invoked.
    getTranslatedArtifactStore: () => new TranslatedArtifactStore(fs),
  } as unknown as AppService;
};

const makeSourceBook = (): Book => ({
  hash: 'src-1',
  metaHash: 'meta-1',
  format: 'EPUB',
  title: 'Linux in Action',
  author: 'David Clinton',
  createdAt: 0,
  updatedAt: 0,
  primaryLanguage: 'en',
});

const makeSection = (label: string): SectionItem => ({
  id: `s-${label}`,
  cfi: `/6/${label}`,
  size: 100,
  linear: 'yes',
  createDocument: vi.fn(async () =>
    new DOMParser().parseFromString(
      `<html><body><p>SOURCE-${label}</p></body></html>`,
      'text/html',
    ),
  ),
});

const makeSourceBookDoc = (sectionLabels: string[]): BookDoc => ({
  metadata: { title: 'Linux in Action', author: 'David Clinton', language: 'en' },
  rendition: { layout: 'reflowable' },
  dir: 'ltr',
  toc: [],
  sections: sectionLabels.map((l) => makeSection(l)),
  transformTarget: new EventTarget(),
  splitTOCHref: (href: string) => [href, 0],
  getCover: async () => null,
});

describe('runTranslationJob', () => {
  beforeEach(() => {
    vi.mocked(getTranslator).mockReset();
  });

  it('registers a translated Book entry and translates all sections', async () => {
    vi.mocked(getTranslator).mockReturnValue({
      name: 'mock' as never,
      label: 'Mock',
      authRequired: false,
      translate: async (texts) => texts.map((t) => `[fr] ${t}`),
    });
    const fs = makeFsStub();
    const app = makeAppService(fs);
    const registerBookInLibrary = vi.fn<(book: Book) => Promise<void>>(async () => {});
    const onProgress = vi.fn();

    const result = await runTranslationJob({
      sourceBook: makeSourceBook(),
      sourceBookDoc: makeSourceBookDoc(['A', 'B', 'C']),
      appService: app,
      provider: 'mock' as never,
      targetLang: 'fr',
      registerBookInLibrary,
      onProgress,
    });

    expect(result.canceled).toBe(false);
    expect(result.processedSections).toBe(3);
    expect(result.skippedSections).toBe(0);
    expect(registerBookInLibrary).toHaveBeenCalledOnce();
    const registered = registerBookInLibrary.mock.calls[0]![0];
    expect(registered.translationOf).toBe('src-1');
    expect(registered.translationLang).toBe('fr');

    // Progress fires after each section, with total = sections.length
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls.map((c) => c[0].done)).toEqual([1, 2, 3]);
    expect(onProgress.mock.calls.every((c) => c[0].total === 3)).toBe(true);

    // Manifest reflects the work
    const store = new TranslatedArtifactStore(fs);
    const manifest = await store.readManifest({
      sourceBookHash: 'src-1',
      provider: 'mock',
      lang: 'fr',
    });
    expect(manifest!.completedSections).toEqual([0, 1, 2]);
  });

  it('skips sections that are already in the artifact store', async () => {
    vi.mocked(getTranslator).mockReturnValue({
      name: 'mock' as never,
      label: 'Mock',
      authRequired: false,
      translate: async (texts) => texts.map((t) => `[fr] ${t}`),
    });
    const fs = makeFsStub();
    const app = makeAppService(fs);

    // Pre-seed the store as if a previous job had translated section 0.
    const store = new TranslatedArtifactStore(fs);
    await store.writeSection(
      { sourceBookHash: 'src-1', provider: 'mock', lang: 'fr' },
      0,
      '<html><body><p>PRE-CACHED</p></body></html>',
      3,
    );

    const result = await runTranslationJob({
      sourceBook: makeSourceBook(),
      sourceBookDoc: makeSourceBookDoc(['A', 'B', 'C']),
      appService: app,
      provider: 'mock' as never,
      targetLang: 'fr',
      registerBookInLibrary: vi.fn(async () => {}),
    });

    expect(result.processedSections).toBe(2);
    expect(result.skippedSections).toBe(1);
  });

  it('aborts cleanly between sections when signal fires', async () => {
    vi.mocked(getTranslator).mockReturnValue({
      name: 'mock' as never,
      label: 'Mock',
      authRequired: false,
      translate: async (texts) => texts.map((t) => `[fr] ${t}`),
    });
    const fs = makeFsStub();
    const app = makeAppService(fs);
    const ac = new AbortController();
    const onProgress = vi.fn((p) => {
      // Cancel right after section 0 finishes
      if (p.done === 1) ac.abort();
    });

    const result = await runTranslationJob({
      sourceBook: makeSourceBook(),
      sourceBookDoc: makeSourceBookDoc(['A', 'B', 'C', 'D']),
      appService: app,
      provider: 'mock' as never,
      targetLang: 'fr',
      registerBookInLibrary: vi.fn(async () => {}),
      onProgress,
      signal: ac.signal,
    });

    expect(result.canceled).toBe(true);
    expect(result.processedSections).toBe(1);
    // Persisted progress survives the cancel — re-running picks up section 1.
    const store = new TranslatedArtifactStore(fs);
    const manifest = await store.readManifest({
      sourceBookHash: 'src-1',
      provider: 'mock',
      lang: 'fr',
    });
    expect(manifest!.completedSections).toEqual([0]);
  });

  it('throws when the provider name is unknown', async () => {
    vi.mocked(getTranslator).mockReturnValue(undefined);

    await expect(
      runTranslationJob({
        sourceBook: makeSourceBook(),
        sourceBookDoc: makeSourceBookDoc(['A']),
        appService: makeAppService(makeFsStub()),
        provider: 'nope' as never,
        targetLang: 'fr',
        registerBookInLibrary: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(/unknown provider/);
  });
});
