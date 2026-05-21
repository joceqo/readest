import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BookDoc, SectionItem } from '@/libs/document';
import { createTranslatedBookDoc } from '@/libs/translatedBookDoc';
import { TranslatedArtifactStore } from '@/services/translation/translatedArtifactStore';
import type { BaseDir, FileSystem } from '@/types/system';

// Reuses the same in-memory FS stub shape as
// __tests__/services/translation/translatedArtifactStore.test.ts so the
// store's behavior is exercised end-to-end (not mocked).
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
      if (!data.has(key)) throw new Error(`ENOENT ${key}`);
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

const makeSourceSection = (label: string): SectionItem => {
  const createDoc = vi.fn(async () => {
    const dom = new DOMParser().parseFromString(
      `<html><body><p>SOURCE-${label}</p></body></html>`,
      'text/html',
    );
    return dom;
  });
  return {
    id: `s-${label}`,
    cfi: `/6/${label}`,
    size: 100,
    linear: 'yes',
    createDocument: createDoc,
  };
};

const makeSourceBookDoc = (
  sectionLabels: string[],
): BookDoc & {
  __spy: { sections: ReturnType<typeof makeSourceSection>[] };
} => {
  const sections = sectionLabels.map((l) => makeSourceSection(l));
  return {
    metadata: { title: 'Test Book', author: 'Author', language: 'en' },
    rendition: { layout: 'reflowable' },
    dir: 'ltr',
    toc: [{ id: 0, label: 'Cover', href: 's-A', index: 0 }],
    sections,
    transformTarget: new EventTarget(),
    splitTOCHref: vi.fn((href: string) => [href, 0]),
    getCover: vi.fn(async () => null),
    __spy: { sections },
  };
};

const KEY = { sourceBookHash: 'BOOK', provider: 'mock', lang: 'fr' };

describe('createTranslatedBookDoc', () => {
  let fs: FileSystem;
  let store: TranslatedArtifactStore;

  beforeEach(() => {
    fs = makeFsStub();
    store = new TranslatedArtifactStore(fs);
  });

  it('passes through metadata, rendition, dir, toc, and spine length', () => {
    const source = makeSourceBookDoc(['A', 'B', 'C']);
    const translated = createTranslatedBookDoc({ source, key: KEY, store });

    expect(translated.metadata).toEqual(source.metadata);
    expect(translated.rendition).toEqual(source.rendition);
    expect(translated.dir).toBe(source.dir);
    expect(translated.toc).toEqual(source.toc);
    expect(translated.sections.length).toBe(3);
    expect(translated.transformTarget).toBe(source.transformTarget);
  });

  it('section.createDocument() returns artifact content when cached', async () => {
    const source = makeSourceBookDoc(['A']);
    await store.writeSection(KEY, 0, '<html><body><p>TRANSLATED</p></body></html>', 1);

    const translated = createTranslatedBookDoc({ source, key: KEY, store });
    const doc = await translated.sections[0]!.createDocument();

    expect(doc.querySelector('p')?.textContent).toBe('TRANSLATED');
    // Source createDocument MUST NOT be invoked when cached
    expect(source.__spy.sections[0]!.createDocument).not.toHaveBeenCalled();
  });

  it('falls back to source when no cache + no translateMissing', async () => {
    const source = makeSourceBookDoc(['A']);
    const translated = createTranslatedBookDoc({ source, key: KEY, store });
    const doc = await translated.sections[0]!.createDocument();

    expect(doc.querySelector('p')?.textContent).toBe('SOURCE-A');
    expect(source.__spy.sections[0]!.createDocument).toHaveBeenCalledOnce();
  });

  it('calls translateMissing on cache miss and persists the result', async () => {
    const source = makeSourceBookDoc(['A', 'B']);
    const translateMissing = vi.fn(async (sourceDoc: Document, idx: number) => {
      const text = sourceDoc.querySelector('p')?.textContent ?? '';
      return `<html><body><p>FR:${text}:idx=${idx}</p></body></html>`;
    });
    const translated = createTranslatedBookDoc({
      source,
      key: KEY,
      store,
      translateMissing,
    });

    const doc0 = await translated.sections[0]!.createDocument();
    expect(doc0.querySelector('p')?.textContent).toBe('FR:SOURCE-A:idx=0');

    // Persisted: a second call should hit the store, NOT translateMissing
    const doc0Again = await translated.sections[0]!.createDocument();
    expect(doc0Again.querySelector('p')?.textContent).toBe('FR:SOURCE-A:idx=0');
    expect(translateMissing).toHaveBeenCalledOnce();

    // Manifest reflects the completed section
    const manifest = await store.readManifest(KEY);
    expect(manifest!.completedSections).toEqual([0]);
    expect(manifest!.sectionCount).toBe(2);

    // The other section is still untranslated until requested
    expect(await store.hasSection(KEY, 1)).toBe(false);
  });

  it('serves source when translateMissing throws', async () => {
    const source = makeSourceBookDoc(['A']);
    const translateMissing = vi.fn(async () => {
      throw new Error('upstream down');
    });
    const translated = createTranslatedBookDoc({
      source,
      key: KEY,
      store,
      translateMissing,
    });

    const doc = await translated.sections[0]!.createDocument();
    expect(doc.querySelector('p')?.textContent).toBe('SOURCE-A');
    // Failure should NOT have written anything to the store
    expect(await store.hasSection(KEY, 0)).toBe(false);
  });

  it('still returns the parsed translated doc when persist write fails', async () => {
    const source = makeSourceBookDoc(['A']);
    // Sabotage writeFile to make persistence fail
    (fs.writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));
    const translateMissing = vi.fn(async () => '<html><body><p>STILL FR</p></body></html>');

    const translated = createTranslatedBookDoc({
      source,
      key: KEY,
      store,
      translateMissing,
    });

    const doc = await translated.sections[0]!.createDocument();
    expect(doc.querySelector('p')?.textContent).toBe('STILL FR');
  });

  it('preserves the source SectionItem fields (id, cfi, size, linear)', () => {
    const source = makeSourceBookDoc(['A', 'B']);
    const translated = createTranslatedBookDoc({ source, key: KEY, store });

    expect(translated.sections[0]!.id).toBe('s-A');
    expect(translated.sections[0]!.cfi).toBe('/6/A');
    expect(translated.sections[0]!.size).toBe(100);
    expect(translated.sections[0]!.linear).toBe('yes');
    expect(translated.sections[1]!.id).toBe('s-B');
  });

  it('splitTOCHref + getCover delegate to source', async () => {
    const source = makeSourceBookDoc(['A']);
    const translated = createTranslatedBookDoc({ source, key: KEY, store });

    translated.splitTOCHref('foo.xhtml#bar');
    expect(source.splitTOCHref).toHaveBeenCalledWith('foo.xhtml#bar');

    await translated.getCover();
    expect(source.getCover).toHaveBeenCalled();
  });
});
