import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { isTauriAppPlatform } from '@/services/environment';
import { initTauriCachePersistence } from '@/services/translators/tauriCache';

/**
 * Tauri-only side effect: wire up persistent on-disk backup of the
 * translation cache. Restores any sidecar entries at mount, and snapshots
 * periodically + on lifecycle events so translations survive an IndexedDB
 * wipe (browser data clear, app reinstall, webview state reset).
 *
 * Web builds keep using IndexedDB only and pay no cost from this hook.
 */
export function useTranslationCachePersistence() {
  const { appService } = useEnv();

  useEffect(() => {
    if (!isTauriAppPlatform() || !appService) return;

    let stopped = false;
    let stop: (() => void) | null = null;

    void initTauriCachePersistence(appService).then((handle) => {
      if (stopped) {
        handle.stop();
        return;
      }
      stop = handle.stop;
    });

    return () => {
      stopped = true;
      stop?.();
    };
  }, [appService]);
}
