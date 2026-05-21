/**
 * Section-level translator that produces a stand-alone translated XHTML
 * document from a source Document.
 *
 * Unlike `useTextTranslation`, which *appends* translation siblings into the
 * live DOM as the user reads, this module *replaces* text content in-place
 * and returns serialized XHTML. The output is meant to be persisted by
 * `translatedArtifactStore` and later opened as a stand-alone BookDoc
 * (`createTranslatedBookDoc`) — the user reads it like any other book, with
 * its own progress / annotations.
 *
 * Cache reuse: lookups go through the existing `getFromCache` / `storeInCache`
 * API, so any sentence translated by the bilingual overlay (or by a previous
 * artifact build) is a free hit here. The translation key is
 * `provider:sourceLang:targetLang:text` — exactly what the overlay populates.
 */

import { getFromCache, storeInCache } from '@/services/translators/cache';
import { TranslationProvider } from '@/services/translators/types';
import { walkTextNodes } from '@/utils/walk';

export interface TranslateSectionOptions {
  /**
   * Source document. Mutated in place — the caller should pass a fresh
   * Document (e.g. from `section.createDocument()`) and not share it.
   */
  sourceDoc: Document;
  /** Source language code (ISO 639-1 or BCP-47 short form), or "AUTO". */
  sourceLang: string;
  /** Target language code. */
  targetLang: string;
  /** Translation provider to call on cache miss. */
  provider: TranslationProvider;
  /** Auth token, required by some providers (e.g. DeepL). */
  token?: string | null;
  /** Texts batched per API call. Mirrors the overlay's `CHUNK = 5`. */
  chunkSize?: number;
  /**
   * Optional progress callback. Called once per *unique* translation that has
   * to be fetched from the network (cache hits don't trigger this).
   */
  onProgress?: (done: number, total: number) => void;
}

export interface TranslateSectionResult {
  /** Serialized XHTML of the translated document. */
  xhtml: string;
  /** Number of translation units found in the source. */
  unitCount: number;
  /** Number of those that were served from the local cache. */
  cacheHitCount: number;
  /** Number of new translations fetched from the provider. */
  fetchedCount: number;
}

const SKIP_TAGS = ['pre', 'code', 'math'];

const normalizeText = (raw: string): string =>
  raw
    .replace(/\r\n/g, ' ')
    .replace(/[\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Translate every "text-bearing element" in `sourceDoc` and replace its
 * content with the translation, then return the serialized XHTML.
 *
 * Selection of translation units is delegated to `walkTextNodes`, which is
 * the same selector the bilingual overlay uses. This guarantees parity:
 * units that get a French sibling in bilingual mode also get translated
 * here, and cache hits are 1:1.
 */
export const translateSection = async (
  opts: TranslateSectionOptions,
): Promise<TranslateSectionResult> => {
  const {
    sourceDoc,
    sourceLang,
    targetLang,
    provider,
    token = null,
    chunkSize = 5,
    onProgress,
  } = opts;

  if (!sourceDoc.body) {
    throw new Error('[sectionTranslator] sourceDoc has no <body> to walk');
  }

  // walkTextNodes returns only the outermost text-bearing element on each
  // branch (it stops descending once it pushes), so we won't double-process
  // <em> inside an already-captured <p>.
  const units = walkTextNodes(sourceDoc.body, SKIP_TAGS);

  // Build the per-unit work list with normalized text. Drop empty/whitespace.
  const tasks: { el: HTMLElement; text: string }[] = [];
  for (const el of units) {
    const text = normalizeText(el.textContent ?? '');
    if (text) tasks.push({ el, text });
  }

  // Dedupe: identical text strings should only be translated once even if
  // they appear in multiple elements (e.g. repeated headings, "Chapter X").
  const uniqueTexts = Array.from(new Set(tasks.map((t) => t.text)));

  // Cache lookup pass.
  const translations = new Map<string, string>();
  const uncached: string[] = [];
  await Promise.all(
    uniqueTexts.map(async (text) => {
      const hit = await getFromCache(text, sourceLang, targetLang, provider.name);
      if (hit) translations.set(text, hit);
      else uncached.push(text);
    }),
  );
  const cacheHitCount = translations.size;

  // Batch API calls for the uncached texts.
  let fetchedCount = 0;
  for (let i = 0; i < uncached.length; i += chunkSize) {
    const chunk = uncached.slice(i, i + chunkSize);
    let results: string[];
    try {
      results = await provider.translate(chunk, sourceLang, targetLang, token, false);
    } catch (err) {
      // Best-effort: drop this chunk, keep going. Untranslated text stays
      // as source — caller can detect via the result counts.
      console.warn(
        `[sectionTranslator] provider ${provider.name} failed on chunk (size ${chunk.length}):`,
        err,
      );
      continue;
    }
    for (let j = 0; j < chunk.length; j++) {
      const text = chunk[j]!;
      const translation = results[j] || text;
      translations.set(text, translation);
      fetchedCount++;
      // Don't await inside the loop; storeInCache returns Promise<void> but
      // the caller doesn't need to block on persistence. Errors are logged
      // by the cache layer itself.
      void storeInCache(text, translation, sourceLang, targetLang, provider.name);
      onProgress?.(fetchedCount, uncached.length);
    }
  }

  // Replace each unit's children with a single Text node containing the
  // translation. This loses inline emphasis (<em>, <strong>) inside the
  // unit — that's accepted v1 behavior; users who want inline emphasis can
  // switch to bilingual mode (the source overlay still works). Each unit
  // is processed exactly once because walkTextNodes already deduplicated
  // along ancestor chains.
  for (const { el, text } of tasks) {
    const translation = translations.get(text);
    if (!translation || translation === text) continue;
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(sourceDoc.createTextNode(translation));
  }

  const xhtml = new XMLSerializer().serializeToString(sourceDoc);

  return {
    xhtml,
    unitCount: tasks.length,
    cacheHitCount,
    fetchedCount,
  };
};
