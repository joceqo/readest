import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriAppPlatform } from '@/services/environment';
import { useSettingsStore } from '@/store/settingsStore';

/**
 * Listens for the `open-settings` Tauri event emitted by the macOS app menu
 * ("Settings..." item with the standard Cmd+, accelerator) and opens the
 * in-app Settings dialog in the current window.
 *
 * Each window mounts its own listener because `useSettingsStore` is JS-scoped
 * per window — there is no shared zustand instance across native windows.
 */
export function useOpenSettingsMenu() {
  const setSettingsDialogOpen = useSettingsStore((s) => s.setSettingsDialogOpen);

  useEffect(() => {
    if (!isTauriAppPlatform()) return;

    console.warn('[useOpenSettingsMenu] subscribing to open-settings');
    const unlisten = getCurrentWindow().listen('open-settings', () => {
      console.warn('[useOpenSettingsMenu] received open-settings');
      setSettingsDialogOpen(true);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [setSettingsDialogOpen]);
}
