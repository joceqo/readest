/**
 * React wrapper around `runTranslationJob` that handles:
 *   - registering the translated Book entry through libraryStore.updateBooks
 *     (which dedupes by hash, so re-running is idempotent),
 *   - bridging the job's onProgress to eventDispatcher.dispatch('hint', …)
 *     so the existing toast / hint UI surfaces progress,
 *   - cancellation via AbortController,
 *   - lifecycle state (running / lastResult / error) for the calling
 *     component.
 *
 * Used by the reader's TranslationToggler — but it's bookKey-agnostic, so
 * a future library context-menu entry can call the same hook.
 */

import { useCallback, useRef, useState } from 'react';

import { useEnv } from '@/context/EnvContext';
import { useBookDataStore } from '@/store/bookDataStore';
import { useLibraryStore } from '@/store/libraryStore';
import { runTranslationJob } from '@/services/translation/translationJobRunner';
import {
  TranslationJobProgress,
  TranslationJobResult,
} from '@/services/translation/translationJobRunner';
import { TranslatorName } from '@/services/translators';
import { eventDispatcher } from '@/utils/event';

export interface UseTranslationJobOptions {
  /** bookKey for the SOURCE book whose translation we'll generate. */
  bookKey: string;
}

export interface StartJobArgs {
  provider: TranslatorName;
  targetLang: string;
  /** Optional auth token (DeepL etc.). */
  token?: string | null;
}

export const useTranslationJob = ({ bookKey }: UseTranslationJobOptions) => {
  const { envConfig, appService } = useEnv();
  const { getBookData } = useBookDataStore();
  const { updateBooks } = useLibraryStore();

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<TranslationJobProgress | null>(null);
  const [lastResult, setLastResult] = useState<TranslationJobResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = useCallback(
    async ({ provider, targetLang, token = null }: StartJobArgs) => {
      if (running) {
        console.warn('[useTranslationJob] already running, ignoring start()');
        return;
      }
      if (!appService) {
        throw new Error('[useTranslationJob] appService not ready');
      }

      const bookData = getBookData(bookKey);
      if (!bookData?.book || !bookData.bookDoc) {
        throw new Error('[useTranslationJob] source book is not loaded');
      }

      const ac = new AbortController();
      abortRef.current = ac;
      setRunning(true);
      setProgress(null);
      setError(null);

      // Lead with a single dispatch so the user sees acknowledgement
      // even before the first section completes (some books spend many
      // seconds in DOMParser before the first onProgress fires).
      eventDispatcher.dispatch('hint', {
        bookKey,
        message: `Translating ${bookData.book.title} → ${targetLang}…`,
      });

      try {
        const result = await runTranslationJob({
          sourceBook: bookData.book,
          sourceBookDoc: bookData.bookDoc,
          appService,
          provider,
          targetLang,
          token,
          signal: ac.signal,
          registerBookInLibrary: async (book) => {
            // updateBooks is the right call (not updateBook) because the
            // singular form is upsert-by-hash, and the plural form is
            // dedupe-and-merge — both produce the same result for our
            // case, but updateBooks is explicitly the "add or update"
            // path that already exists for batch imports.
            await updateBooks(envConfig, [book]);
          },
          onProgress: (p) => {
            setProgress(p);
            // Throttle the hint events: only every 5 sections + every
            // section that wasn't from cache. Avoids a flood of toasts
            // for a 200-section book that's mostly cached.
            const shouldHint = !p.fromCache || p.done === p.total || p.done % 5 === 0;
            if (shouldHint) {
              eventDispatcher.dispatch('hint', {
                bookKey,
                message: p.canceled
                  ? `Translation canceled at ${p.done}/${p.total}`
                  : `Translating… ${p.done}/${p.total}${p.fromCache ? ' (from cache)' : ''}`,
              });
            }
          },
        });
        setLastResult(result);
        if (result.canceled) {
          eventDispatcher.dispatch('hint', {
            bookKey,
            message: `Translation paused — ${result.processedSections} sections done, can resume later.`,
          });
        } else {
          eventDispatcher.dispatch('hint', {
            bookKey,
            message: `Translation ready — ${result.book.title}`,
          });
        }
        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        eventDispatcher.dispatch('hint', {
          bookKey,
          message: `Translation failed: ${e.message}`,
        });
        throw e;
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bookKey, running, appService],
  );

  return { start, cancel, running, progress, lastResult, error };
};
