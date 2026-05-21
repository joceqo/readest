/**
 * Persists translated section XHTML + a small manifest under each book's
 * storage directory. The layout mirrors how config / nav / cover files
 * already live next to a book (see `src/utils/book.ts` for the
 * `${book.hash}/...` convention).
 *
 *   Books/
 *     <sourceBookHash>/
 *       config.json            (existing)
 *       nav.json               (existing)
 *       cover.png              (existing)
 *       translations/
 *         <provider>-<lang>/
 *           manifest.json      (sections list, timestamps, source hash)
 *           section-0.xhtml    (translated XHTML for spine index 0)
 *           section-1.xhtml
 *           ...
 *
 * Storage is content-addressed by `(sourceBookHash, provider, lang)`. Two
 * translations of the same book by different providers or to different
 * languages live side by side and never overwrite each other.
 *
 * Invalidation rules (also documented in the plan):
 *   - Explicit Regenerate → call `invalidate()` then re-run section
 *     translation. Wipes the whole `<provider>-<lang>/` directory.
 *   - Source `metaHash` change (book file replaced) → caller marks the
 *     existing manifest as `stale: true`. We do NOT auto-delete because
 *     the user may still want to read the old translation.
 *   - Provider/lang config change → no invalidation. A new directory is
 *     created for the new tuple alongside any existing ones.
 */

import { FileSystem } from '@/types/system';

export interface TranslationManifest {
  /** Hash of the *source* book this artifact was generated from. */
  sourceBookHash: string;
  /** Target language code (e.g. "fr", "EN"). */
  lang: string;
  /** Provider name (e.g. "deepl", "google", "ollama"). */
  provider: string;
  /** Total number of spine sections in the source book. */
  sectionCount: number;
  /**
   * Sections whose translation has been generated and persisted, sorted
   * ascending. May be sparse (lazy backfill — only sections the user has
   * actually read get filled in).
   */
  completedSections: number[];
  /** Epoch millis. */
  createdAt: number;
  /** Epoch millis. Updated on every section write or manifest re-save. */
  updatedAt: number;
  /**
   * Set to true by the library layer when the source book's metaHash
   * changes (file replaced). Readers should warn the user that the
   * translation may be out of date.
   */
  stale?: boolean;
}

const translationDir = (sourceBookHash: string, provider: string, lang: string) =>
  `${sourceBookHash}/translations/${provider}-${lang}`;

const manifestPath = (sourceBookHash: string, provider: string, lang: string) =>
  `${translationDir(sourceBookHash, provider, lang)}/manifest.json`;

const sectionPath = (
  sourceBookHash: string,
  provider: string,
  lang: string,
  sectionIndex: number,
) => `${translationDir(sourceBookHash, provider, lang)}/section-${sectionIndex}.xhtml`;

export interface TranslatedArtifactKey {
  sourceBookHash: string;
  provider: string;
  lang: string;
}

/**
 * Wraps the platform `FileSystem` with translation-artifact-aware helpers.
 * One instance per app (or per test); construct with `new
 * TranslatedArtifactStore(appService.fs)`.
 */
export class TranslatedArtifactStore {
  constructor(private readonly fs: FileSystem) {}

  // ---- Manifest -----------------------------------------------------------

  async readManifest(key: TranslatedArtifactKey): Promise<TranslationManifest | null> {
    const path = manifestPath(key.sourceBookHash, key.provider, key.lang);
    try {
      if (!(await this.fs.exists(path, 'Books'))) return null;
      const raw = (await this.fs.readFile(path, 'Books', 'text')) as string;
      return JSON.parse(raw) as TranslationManifest;
    } catch (err) {
      // Corrupted manifest — treat as missing. Caller will rebuild.
      console.warn('[translatedArtifactStore] manifest read failed:', err);
      return null;
    }
  }

  async writeManifest(manifest: TranslationManifest): Promise<void> {
    const dir = translationDir(manifest.sourceBookHash, manifest.provider, manifest.lang);
    await this.fs.createDir(dir, 'Books', true);
    const path = manifestPath(manifest.sourceBookHash, manifest.provider, manifest.lang);
    await this.fs.writeFile(path, 'Books', JSON.stringify(manifest, null, 2));
  }

  // ---- Sections -----------------------------------------------------------

  async hasSection(key: TranslatedArtifactKey, sectionIndex: number): Promise<boolean> {
    return this.fs.exists(
      sectionPath(key.sourceBookHash, key.provider, key.lang, sectionIndex),
      'Books',
    );
  }

  async readSection(key: TranslatedArtifactKey, sectionIndex: number): Promise<string | null> {
    const path = sectionPath(key.sourceBookHash, key.provider, key.lang, sectionIndex);
    try {
      if (!(await this.fs.exists(path, 'Books'))) return null;
      return (await this.fs.readFile(path, 'Books', 'text')) as string;
    } catch (err) {
      console.warn('[translatedArtifactStore] section read failed:', err);
      return null;
    }
  }

  /**
   * Persist a translated section and atomically update the manifest's
   * `completedSections` list. Creates an initial manifest if none exists.
   * Callers pass `sectionCount` so the manifest can record the total even
   * before every section is translated (lazy backfill).
   */
  async writeSection(
    key: TranslatedArtifactKey,
    sectionIndex: number,
    xhtml: string,
    sectionCount: number,
  ): Promise<void> {
    const dir = translationDir(key.sourceBookHash, key.provider, key.lang);
    await this.fs.createDir(dir, 'Books', true);
    const path = sectionPath(key.sourceBookHash, key.provider, key.lang, sectionIndex);
    await this.fs.writeFile(path, 'Books', xhtml);

    let manifest = await this.readManifest(key);
    const now = Date.now();
    if (!manifest) {
      manifest = {
        sourceBookHash: key.sourceBookHash,
        lang: key.lang,
        provider: key.provider,
        sectionCount,
        completedSections: [],
        createdAt: now,
        updatedAt: now,
      };
    }
    if (!manifest.completedSections.includes(sectionIndex)) {
      manifest.completedSections = [...manifest.completedSections, sectionIndex].sort(
        (a, b) => a - b,
      );
    }
    // Trust the freshest caller-supplied count (in case it grew between
    // builds — should be rare but cheap to keep current).
    manifest.sectionCount = sectionCount;
    manifest.updatedAt = now;
    await this.writeManifest(manifest);
  }

  // ---- Bulk ---------------------------------------------------------------

  /** True if a manifest is on disk (sections may still be partial). */
  async hasArtifact(key: TranslatedArtifactKey): Promise<boolean> {
    return this.fs.exists(manifestPath(key.sourceBookHash, key.provider, key.lang), 'Books');
  }

  /**
   * Delete the entire `<provider>-<lang>/` directory for the given book.
   * Idempotent — silently succeeds if the directory is already gone.
   */
  async invalidate(key: TranslatedArtifactKey): Promise<void> {
    const dir = translationDir(key.sourceBookHash, key.provider, key.lang);
    if (!(await this.fs.exists(dir, 'Books'))) return;
    await this.fs.removeDir(dir, 'Books', true);
  }

  /**
   * Mark an existing manifest as stale (source book file changed). The
   * directory and translated sections stay on disk so the user can still
   * read them; the reader UI is expected to display a warning banner.
   */
  async markStale(key: TranslatedArtifactKey): Promise<void> {
    const manifest = await this.readManifest(key);
    if (!manifest) return;
    if (manifest.stale) return;
    await this.writeManifest({ ...manifest, stale: true, updatedAt: Date.now() });
  }
}
