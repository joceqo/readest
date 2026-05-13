import type { AppService } from '@/types/system';
import { CacheEntry, getAllCacheEntries, importCacheEntries } from './cache';

const SIDECAR_DIR = 'translations';
const SIDECAR_FILE = 'translations/cache.json';
const SIDECAR_VERSION = 1;

interface SidecarPayload {
  version: number;
  savedAt: number;
  entries: CacheEntry[];
}

/**
 * Read the on-disk translation cache (Tauri only). Returns an empty array
 * if the file is missing or unreadable — callers should treat that as
 * "nothing to restore" rather than a hard error.
 */
const loadFromFile = async (appService: AppService): Promise<CacheEntry[]> => {
  try {
    if (!(await appService.exists(SIDECAR_FILE, 'Data'))) return [];
    const raw = (await appService.readFile(SIDECAR_FILE, 'Data', 'text')) as string;
    const parsed = JSON.parse(raw) as Partial<SidecarPayload>;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (e): e is CacheEntry =>
        !!e &&
        typeof e.key === 'string' &&
        typeof e.translation === 'string' &&
        typeof e.originalText === 'string' &&
        typeof e.sourceLang === 'string' &&
        typeof e.targetLang === 'string' &&
        typeof e.provider === 'string' &&
        typeof e.timestamp === 'number',
    );
  } catch (err) {
    console.warn('translations sidecar: load failed', err);
    return [];
  }
};

/**
 * Dump the full IndexedDB cache to the sidecar JSON file. Cheap enough
 * for typical book sizes (a heavily-translated book is ~hundreds of KB).
 * Caller controls cadence — we don't write on every translation.
 */
export const snapshotToFile = async (appService: AppService): Promise<number> => {
  const entries = await getAllCacheEntries();
  const payload: SidecarPayload = {
    version: SIDECAR_VERSION,
    savedAt: Date.now(),
    entries,
  };
  try {
    if (!(await appService.exists(SIDECAR_DIR, 'Data'))) {
      await appService.createDir(SIDECAR_DIR, 'Data', true);
    }
    await appService.writeFile(SIDECAR_FILE, 'Data', JSON.stringify(payload));
    return entries.length;
  } catch (err) {
    console.warn('translations sidecar: snapshot failed', err);
    return 0;
  }
};

/**
 * Wipe the on-disk sidecar (does not touch the IndexedDB cache). Useful
 * for a future "Reset" button in Local LLM settings.
 */
export const clearSidecarFile = async (appService: AppService): Promise<void> => {
  try {
    if (await appService.exists(SIDECAR_FILE, 'Data')) {
      await appService.deleteFile(SIDECAR_FILE, 'Data');
    }
  } catch (err) {
    console.warn('translations sidecar: clear failed', err);
  }
};

interface PersistenceHandle {
  /** Manually flush the current cache to disk. */
  flush: () => Promise<void>;
  /** Stop the snapshot interval and unsubscribe lifecycle listeners. */
  stop: () => void;
}

/**
 * Set up Tauri-side persistence:
 *   1. Load the sidecar at boot and merge any missing entries into the
 *      IndexedDB cache (existing entries win — IDB is the source of truth
 *      when both have a row for the same key).
 *   2. Periodically snapshot the full cache to disk so it survives an
 *      IndexedDB wipe. Also flushes on visibilitychange→hidden and on
 *      beforeunload.
 *
 * Returns a `stop()` callback so the caller can tear the persistence down
 * (used by the hook unmount).
 */
export const initTauriCachePersistence = async (
  appService: AppService,
  options: { snapshotIntervalMs?: number } = {},
): Promise<PersistenceHandle> => {
  // Default: snapshot every 5 minutes. Most translation sessions are
  // bursty (open a book, translate a chapter, idle), so a coarse cadence
  // is fine and the lifecycle flushes catch the tail.
  const intervalMs = options.snapshotIntervalMs ?? 5 * 60 * 1000;

  const restored = await loadFromFile(appService);
  if (restored.length > 0) {
    const imported = await importCacheEntries(restored);
    if (imported > 0) {
      console.log(`translations sidecar: restored ${imported} entries from disk`);
    }
  }

  let flushPending = false;
  const flush = async () => {
    if (flushPending) return;
    flushPending = true;
    try {
      await snapshotToFile(appService);
    } finally {
      flushPending = false;
    }
  };

  const intervalId = window.setInterval(flush, intervalMs);

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void flush();
  };
  const onBeforeUnload = () => void flush();

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('beforeunload', onBeforeUnload);

  return {
    flush,
    stop: () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
    },
  };
};
