/**
 * TranslationJobRunner — orchestrates creating a translated edition end to end.
 *
 * One `runJob` call:
 *   1. Registers a Book entry for the translated edition (deterministic
 *      hash via `buildTranslatedBookEntry`). Idempotent — re-running with
 *      the same source / provider / lang reuses the existing entry.
 *   2. Iterates the source book's spine sections. For each section:
 *      - If the artifact store already has it, skip.
 *      - Otherwise, calls `section.createDocument()` on the source, runs
 *        `translateSection` against it, and persists the result via
 *        `translatedArtifactStore.writeSection`.
 *      - Emits a progress event after each section so UI can drive a toast.
 *   3. Returns the resulting Book entry so callers can navigate to it.
 *
 * Cancellation: callers pass an AbortSignal. After each section we check
 * the signal and abort cleanly mid-job. Already-translated sections stay
 * persisted — restarting picks up where we left off.
 *
 * Concurrency: sections are translated **serially**. This keeps the
 * existing ollama / DeepL rate-limit knobs honest (the providers
 * themselves still chunk + concurrency-limit their internal API calls).
 * If we ever need to parallelize across sections, the loop here is the
 * only place to change.
 */

import type { BookDoc } from '@/libs/document';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';

import { translateSection } from '@/services/translation/sectionTranslator';
import { TranslatedArtifactStore } from '@/services/translation/translatedArtifactStore';
import { getTranslator, TranslatorName } from '@/services/translators';
import { buildTranslatedBookEntry, getTranslatedBookHash } from '@/utils/translatedBook';

export interface TranslationJobProgress {
  /** Index of the section that just completed (or was already cached). */
  sectionIndex: number;
  /** 1-based "done" counter (= sectionIndex + 1 after each step). */
  done: number;
  /** Total spine sections in the source book. */
  total: number;
  /** True if the section was served from the artifact store (no API call). */
  fromCache: boolean;
  /** True if the section was canceled before processing. */
  canceled?: boolean;
}

export interface TranslationJobOptions {
  /** The source book whose translation we're producing. */
  sourceBook: Book;
  /** Loaded BookDoc for the source. Pass an already-opened one to avoid
   *  re-loading the file inside the job. */
  sourceBookDoc: BookDoc;
  /** App service handle (gives us the artifact store + library hooks). */
  appService: AppService;
  /** Provider name (`'deepl' | 'google' | 'ollama'` etc.). */
  provider: TranslatorName;
  /** Target language code. */
  targetLang: string;
  /** Auth token, required by some providers (DeepL). */
  token?: string | null;
  /** Optional progress callback fired after each section. */
  onProgress?: (p: TranslationJobProgress) => void;
  /** Cancellation. The job aborts cleanly between sections. */
  signal?: AbortSignal;
  /**
   * Hook to register the translated Book entry in the library. Caller
   * provides this because the library state-management layer
   * (zustand store, persistence) lives outside the service layer; passing
   * it in keeps the runner unit-testable without spinning up the store.
   *
   * Implementations typically wrap libraryStore.updateBook so the new
   * entry is persisted + immediately reflected in the grid.
   */
  registerBookInLibrary: (book: Book) => Promise<void>;
}

export interface TranslationJobResult {
  /** The Book entry that represents the translated edition. */
  book: Book;
  /** Sections processed by this run (excluding skipped already-cached ones). */
  processedSections: number;
  /** Sections that were already in the artifact store and were skipped. */
  skippedSections: number;
  /** True if the job was canceled before all sections completed. */
  canceled: boolean;
}

/**
 * Run the job. Idempotent for the (sourceBook, provider, lang) tuple.
 * Re-invocations with the same key only translate sections that are not
 * yet cached, which lets users retry after a network failure / cancel
 * without losing progress.
 */
export const runTranslationJob = async (
  opts: TranslationJobOptions,
): Promise<TranslationJobResult> => {
  const {
    sourceBook,
    sourceBookDoc,
    appService,
    provider: providerName,
    targetLang,
    token = null,
    onProgress,
    signal,
    registerBookInLibrary,
  } = opts;

  const provider = getTranslator(providerName);
  if (!provider) {
    throw new Error(`[translationJobRunner] unknown provider: ${providerName}`);
  }

  // 1. Register the translated Book entry (idempotent — deterministic hash).
  //    Re-running with the same key reuses the existing entry; the library
  //    layer's updateBook handles dedup.
  const translatedBook = buildTranslatedBookEntry(sourceBook, providerName, targetLang);
  // Make sure the hash actually came out the way we expect — defensive
  // check, easier to catch a future refactor regression here than in the
  // reader.
  if (translatedBook.hash !== getTranslatedBookHash(sourceBook.hash, providerName, targetLang)) {
    throw new Error('[translationJobRunner] buildTranslatedBookEntry hash mismatch');
  }
  await registerBookInLibrary(translatedBook);

  // 2. Iterate sections, fill in any that aren't cached yet.
  const store = appService.getTranslatedArtifactStore() as TranslatedArtifactStore;
  const sectionCount = sourceBookDoc.sections.length;
  const sourceLang = sourceBook.primaryLanguage ?? 'AUTO';
  const key = {
    sourceBookHash: sourceBook.hash,
    provider: providerName,
    lang: targetLang,
  };

  let processedSections = 0;
  let skippedSections = 0;
  let canceled = false;

  for (let i = 0; i < sectionCount; i++) {
    if (signal?.aborted) {
      canceled = true;
      onProgress?.({
        sectionIndex: i,
        done: i,
        total: sectionCount,
        fromCache: false,
        canceled: true,
      });
      break;
    }

    if (await store.hasSection(key, i)) {
      skippedSections++;
      onProgress?.({
        sectionIndex: i,
        done: i + 1,
        total: sectionCount,
        fromCache: true,
      });
      continue;
    }

    const sourceDoc = await sourceBookDoc.sections[i]!.createDocument();
    const { xhtml } = await translateSection({
      sourceDoc,
      sourceLang,
      targetLang,
      provider,
      token,
    });
    await store.writeSection(key, i, xhtml, sectionCount);
    processedSections++;
    onProgress?.({
      sectionIndex: i,
      done: i + 1,
      total: sectionCount,
      fromCache: false,
    });
  }

  return {
    book: translatedBook,
    processedSections,
    skippedSections,
    canceled,
  };
};
