/**
 * Wraps a source `BookDoc` so it looks like a stand-alone "translated
 * edition" to foliate-view + the rest of the app.
 *
 * Why this exists: foliate-view doesn't know or care whether the document it
 * renders is an original or a translation — it just calls
 * `section.createDocument()` and walks the DOM. Replacing the original
 * `BookDoc` with one whose `createDocument()` returns translated XHTML
 * lets us reuse the entire reader pipeline (search, TTS, annotations,
 * highlights) without forking foliate. The translated edition has its
 * own book hash → its own config / annotations / progress, so
 * everything partitions cleanly without source-CFI bridging.
 *
 * Lazy backfill: a translated artifact may be partial (only sections the
 * user has read have been translated and persisted). When the user
 * navigates to a not-yet-translated section, `createDocument()` calls the
 * caller-supplied `translateMissing` to produce the XHTML, persists it via
 * the artifact store, and returns it. Subsequent reads of the same
 * section hit the store and are fast.
 *
 * If `translateMissing` is omitted, missing sections fall back to the
 * source document — useful for unit tests and read-only display when
 * the user hasn't authorized translation calls yet.
 */

import type { BookDoc, SectionItem } from '@/libs/document';

import {
  TranslatedArtifactKey,
  TranslatedArtifactStore,
} from '@/services/translation/translatedArtifactStore';

export interface CreateTranslatedBookDocOptions {
  /** The source book whose translated edition we're surfacing. */
  source: BookDoc;
  /** Identifies which (book, provider, lang) artifact to read from. */
  key: TranslatedArtifactKey;
  /** Persistence layer (typically `new TranslatedArtifactStore(appService.fs)`). */
  store: TranslatedArtifactStore;
  /**
   * Optional translator. When the artifact store has no entry for a
   * requested section, the wrapper calls this with the source Document
   * for that section and expects translated XHTML back. The wrapper
   * persists the XHTML to the store before parsing + returning it.
   *
   * Typically wired to `translateSection` from `sectionTranslator.ts`
   * with the provider + langs already bound:
   *
   *   translateMissing: async (doc) =>
   *     (await translateSection({ sourceDoc: doc, ...langs, provider })).xhtml
   */
  translateMissing?: (sourceDoc: Document, sectionIndex: number) => Promise<string>;
}

const parseXhtml = (xhtml: string): Document => {
  // `application/xhtml+xml` is strict and rejects malformed input — but it
  // also preserves the namespaces foliate-js expects. Falling back to
  // 'text/html' on parse errors keeps us lenient for older / hand-crafted
  // EPUB sources where the embedded XHTML isn't perfectly conformant.
  const xhtmlDoc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
  if (xhtmlDoc.querySelector('parsererror')) {
    return new DOMParser().parseFromString(xhtml, 'text/html');
  }
  return xhtmlDoc;
};

/**
 * Build a BookDoc whose sections lazily resolve to translated XHTML.
 * Returns a brand new object; the input `source` is not mutated.
 */
export const createTranslatedBookDoc = (opts: CreateTranslatedBookDocOptions): BookDoc => {
  const { source, key, store, translateMissing } = opts;

  const sectionCount = source.sections.length;

  const wrappedSections: SectionItem[] = source.sections.map((sourceSection, sectionIndex) => {
    const createDocument = async (): Promise<Document> => {
      // 1. Try the artifact store first — fast path for previously
      //    translated sections.
      const cached = await store.readSection(key, sectionIndex);
      if (cached) {
        return parseXhtml(cached);
      }

      // 2. No cached translation. If the caller passed a translator,
      //    use it to fill in this section now and persist the result.
      if (translateMissing) {
        const sourceDoc = await sourceSection.createDocument();
        let xhtml: string;
        try {
          xhtml = await translateMissing(sourceDoc, sectionIndex);
        } catch (err) {
          console.warn(
            `[translatedBookDoc] translateMissing failed for section ${sectionIndex}; serving source:`,
            err,
          );
          return sourceDoc;
        }
        // Best-effort persistence — failure shouldn't block the read.
        try {
          await store.writeSection(key, sectionIndex, xhtml, sectionCount);
        } catch (err) {
          console.warn(`[translatedBookDoc] failed to persist section ${sectionIndex}:`, err);
        }
        return parseXhtml(xhtml);
      }

      // 3. No translator and no cached artifact — the user is in
      //    read-only translated mode without a way to generate fresh
      //    content. Show the source so the reader keeps working.
      return sourceSection.createDocument();
    };

    return {
      ...sourceSection,
      createDocument,
    };
  });

  return {
    metadata: source.metadata,
    rendition: source.rendition,
    dir: source.dir,
    toc: source.toc,
    sections: wrappedSections,
    transformTarget: source.transformTarget,
    splitTOCHref: (href: string) => source.splitTOCHref(href),
    getCover: () => source.getCover(),
  };
};
