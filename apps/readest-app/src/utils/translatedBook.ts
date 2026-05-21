/**
 * Pure helpers for the "translated edition" Book entry model.
 *
 * A translated edition is a Book entry whose `translationOf`,
 * `translationLang`, and `translationProvider` are all set. Its `hash` is
 * derived deterministically from the source hash + lang + provider so that
 * re-running "Create translated edition" with the same parameters reuses
 * the existing entry — no duplicates.
 *
 * Nothing in this module mutates global state; library / store wiring lives
 * elsewhere. Keeping these as pure functions makes them trivial to test
 * and reusable from migration / sync paths.
 */

import { md5Fingerprint } from '@/utils/md5';
import type { Book } from '@/types/book';

/**
 * Build a stable hash for a translated edition Book entry. The hash must
 * be deterministic across runs and machines so that:
 *   - Library sync produces the same entry on every device.
 *   - Re-running "Create translated edition" with the same provider+lang
 *     on the same source book reuses (not duplicates) the existing entry.
 *   - The translated entry has a distinct hash from the source, so config
 *     / annotations / progress partition cleanly.
 *
 * Format: md5Fingerprint of `${sourceHash}::tr:${provider}:${lang}`.
 * Using md5Fingerprint matches the convention used for source book hashes
 * (see services/bookService.ts).
 */
export const getTranslatedBookHash = (sourceHash: string, provider: string, lang: string): string =>
  md5Fingerprint(`${sourceHash}::tr:${provider}:${lang}`);

/** True when this Book is a translated edition (has all three fields set). */
export const isTranslatedEdition = (book: Book): boolean =>
  !!book.translationOf && !!book.translationLang && !!book.translationProvider;

/**
 * Construct a fresh Book entry for a translated edition of `source`. The
 * caller is expected to persist this via `libraryStore.updateBook` and to
 * separately seed any per-book artifact (the translated XHTML files are
 * persisted by `translatedArtifactStore`, not in the Book row).
 *
 * Field choices:
 *   - `hash` is deterministic (see above).
 *   - `metaHash` mirrors the source so library "different versions of
 *     the same book" grouping continues to work — a French and English
 *     edition of the same book share metadata.
 *   - `title` is suffixed with the lang tag (e.g. "Linux in Action — fr")
 *     so the library grid is unambiguous when the entries are visible
 *     side by side. Phase 3b's grouping UI may suppress this in favor
 *     of a visual badge.
 *   - `format` is copied from the source. Translated content is still
 *     served from the source file plus the artifact store.
 *   - `url` / `filePath` are intentionally NOT copied — translated
 *     editions reuse the source file via the reader's lookup, not by
 *     duplicating storage.
 */
export const buildTranslatedBookEntry = (source: Book, provider: string, lang: string): Book => {
  const now = Date.now();
  const hash = getTranslatedBookHash(source.hash, provider, lang);
  return {
    hash,
    metaHash: source.metaHash,
    format: source.format,
    title: `${source.title} — ${lang}`,
    sourceTitle: source.sourceTitle,
    author: source.author,
    coverImageUrl: source.coverImageUrl,
    createdAt: now,
    updatedAt: now,
    primaryLanguage: lang,
    metadata: source.metadata,
    translationOf: source.hash,
    translationLang: lang,
    translationProvider: provider,
  };
};

/**
 * Find all translated editions in `library` that point at `sourceHash`.
 * Returns them in insertion order. Soft-deleted entries (deletedAt set)
 * are excluded so callers can use this directly for UI listings.
 */
export const getTranslationsOf = (library: Book[], sourceHash: string): Book[] =>
  library.filter((b) => !b.deletedAt && b.translationOf === sourceHash && isTranslatedEdition(b));

/**
 * For a translated edition, look up the source Book. Returns undefined if
 * the source is missing from the library (orphan translation — the source
 * was deleted but the artifact wasn't), letting callers decide how to
 * surface that (e.g. an "orphaned" badge in the library UI).
 */
export const getTranslationSource = (library: Book[], translation: Book): Book | undefined => {
  if (!translation.translationOf) return undefined;
  return library.find((b) => b.hash === translation.translationOf && !b.deletedAt);
};
