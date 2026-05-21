import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TranslatedArtifactStore,
  TranslationManifest,
} from '@/services/translation/translatedArtifactStore';
import type { BaseDir, FileSystem } from '@/types/system';

/**
 * Minimal in-memory FileSystem stub for tests. Only the methods used by
 * TranslatedArtifactStore are implemented; everything else throws so a
 * regression that adds a new call surfaces immediately.
 */
const makeFsStub = (): FileSystem & { __dump(): Record<string, string> } => {
  const data = new Map<string, string>();
  const dirs = new Set<string>(['']);
  const key = (path: string, base: BaseDir) => `${base}:${path}`;
  const fs: FileSystem = {
    resolvePath: vi.fn(),
    getURL: vi.fn(),
    getBlobURL: vi.fn(),
    getImageURL: vi.fn(),
    openFile: vi.fn(),
    copyFile: vi.fn(),
    readFile: vi.fn(async (path, base, mode) => {
      const k = key(path, base);
      if (!data.has(k)) throw new Error(`ENOENT ${k}`);
      if (mode === 'binary') {
        return new TextEncoder().encode(data.get(k)!).buffer as ArrayBuffer;
      }
      return data.get(k)!;
    }),
    writeFile: vi.fn(async (path, base, content) => {
      if (typeof content !== 'string') {
        throw new Error('fs stub only handles string content');
      }
      data.set(key(path, base), content);
    }),
    removeFile: vi.fn(async (path, base) => {
      data.delete(key(path, base));
    }),
    readDir: vi.fn(),
    createDir: vi.fn(async (path, base) => {
      dirs.add(key(path, base));
    }),
    removeDir: vi.fn(async (path, base) => {
      const prefix = key(path, base);
      for (const k of Array.from(data.keys())) {
        if (k === prefix || k.startsWith(`${prefix}/`)) data.delete(k);
      }
      for (const d of Array.from(dirs)) {
        if (d === prefix || d.startsWith(`${prefix}/`)) dirs.delete(d);
      }
    }),
    exists: vi.fn(async (path, base) => {
      const k = key(path, base);
      if (data.has(k) || dirs.has(k)) return true;
      // Treat any key prefix as a directory presence too — the store calls
      // exists() on dir paths it just created.
      for (const k2 of data.keys()) {
        if (k2.startsWith(`${k}/`)) return true;
      }
      return false;
    }),
    stats: vi.fn(),
    getPrefix: vi.fn(),
  };
  return Object.assign(fs, { __dump: () => Object.fromEntries(data) });
};

const KEY = { sourceBookHash: 'abc123', provider: 'mock', lang: 'fr' };

describe('TranslatedArtifactStore', () => {
  let fs: ReturnType<typeof makeFsStub>;
  let store: TranslatedArtifactStore;

  beforeEach(() => {
    fs = makeFsStub();
    store = new TranslatedArtifactStore(fs);
  });

  it('writes a section and creates a manifest with the new section recorded', async () => {
    await store.writeSection(KEY, 0, '<html><body>translated 0</body></html>', 32);

    const manifest = await store.readManifest(KEY);
    expect(manifest).toMatchObject<Partial<TranslationManifest>>({
      sourceBookHash: 'abc123',
      provider: 'mock',
      lang: 'fr',
      sectionCount: 32,
      completedSections: [0],
    });
    expect(manifest!.createdAt).toBeGreaterThan(0);
    expect(manifest!.updatedAt).toBe(manifest!.createdAt);

    const xhtml = await store.readSection(KEY, 0);
    expect(xhtml).toBe('<html><body>translated 0</body></html>');
  });

  it('appends subsequent sections to completedSections (sorted)', async () => {
    await store.writeSection(KEY, 2, 's2', 32);
    await store.writeSection(KEY, 0, 's0', 32);
    await store.writeSection(KEY, 1, 's1', 32);

    const manifest = await store.readManifest(KEY);
    expect(manifest!.completedSections).toEqual([0, 1, 2]);
  });

  it('does not duplicate an already-completed section index', async () => {
    await store.writeSection(KEY, 0, 'first', 10);
    await store.writeSection(KEY, 0, 'overwrite', 10);

    const manifest = await store.readManifest(KEY);
    expect(manifest!.completedSections).toEqual([0]);
    expect(await store.readSection(KEY, 0)).toBe('overwrite');
  });

  it('returns null for unknown sections and missing manifests', async () => {
    expect(await store.readManifest(KEY)).toBeNull();
    expect(await store.readSection(KEY, 0)).toBeNull();
    expect(await store.hasArtifact(KEY)).toBe(false);
    expect(await store.hasSection(KEY, 0)).toBe(false);
  });

  it('reports hasArtifact / hasSection correctly after a write', async () => {
    await store.writeSection(KEY, 3, 'x', 10);
    expect(await store.hasArtifact(KEY)).toBe(true);
    expect(await store.hasSection(KEY, 3)).toBe(true);
    expect(await store.hasSection(KEY, 4)).toBe(false);
  });

  it('invalidate() removes everything for the (book, provider, lang) tuple', async () => {
    await store.writeSection(KEY, 0, 's0', 5);
    await store.writeSection(KEY, 1, 's1', 5);

    await store.invalidate(KEY);

    expect(await store.readManifest(KEY)).toBeNull();
    expect(await store.readSection(KEY, 0)).toBeNull();
    expect(await store.readSection(KEY, 1)).toBeNull();
  });

  it('invalidate() is idempotent when no artifact exists', async () => {
    await expect(store.invalidate(KEY)).resolves.toBeUndefined();
  });

  it('invalidate() does NOT touch sibling (provider, lang) tuples for the same book', async () => {
    const FR = { ...KEY, lang: 'fr' };
    const DE = { ...KEY, lang: 'de' };
    await store.writeSection(FR, 0, 'french-0', 5);
    await store.writeSection(DE, 0, 'german-0', 5);

    await store.invalidate(FR);

    expect(await store.readSection(FR, 0)).toBeNull();
    expect(await store.readSection(DE, 0)).toBe('german-0');
  });

  it('markStale flips the manifest flag without removing files', async () => {
    await store.writeSection(KEY, 0, 'content', 5);
    await store.markStale(KEY);

    const manifest = await store.readManifest(KEY);
    expect(manifest!.stale).toBe(true);
    // Files still readable
    expect(await store.readSection(KEY, 0)).toBe('content');
  });

  it('markStale is a no-op when no manifest exists', async () => {
    await expect(store.markStale(KEY)).resolves.toBeUndefined();
    expect(await store.readManifest(KEY)).toBeNull();
  });

  it('keeps separate manifests for different providers', async () => {
    const deepl = { ...KEY, provider: 'deepl' };
    const google = { ...KEY, provider: 'google' };
    await store.writeSection(deepl, 0, 'deepl0', 5);
    await store.writeSection(google, 1, 'google1', 5);

    expect((await store.readManifest(deepl))!.completedSections).toEqual([0]);
    expect((await store.readManifest(google))!.completedSections).toEqual([1]);
  });
});
