import { describe, test, expect, vi, beforeEach } from 'vitest';

// Stub the Tauri HTTP plugin: importing the real module pulls in Tauri
// runtime globals that aren't available under jsdom. The client falls back
// to window.fetch on non-Tauri platforms, so the stub is never actually
// called — but it has to resolve to keep the import graph clean.
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => false,
}));

import { KyutaiTTSClient } from '@/services/tts/KyutaiTTSClient';
import { useSettingsStore } from '@/store/settingsStore';
import type { SystemSettings } from '@/types/settings';
import { DEFAULT_KYUTAI_SETTINGS } from '@/services/tts/kyutaiSettings';

const setKyutaiBaseUrl = (baseUrl: string) => {
  const current = useSettingsStore.getState().settings;
  useSettingsStore.setState({
    settings: {
      ...current,
      kyutaiSettings: { ...DEFAULT_KYUTAI_SETTINGS, baseUrl },
    } as SystemSettings,
  });
};

describe('KyutaiTTSClient', () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: {} as SystemSettings });
    vi.restoreAllMocks();
  });

  test('init() health-checks the URL from the settings store', async () => {
    setKyutaiBaseUrl('http://server-a:8000');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new KyutaiTTSClient();
    const ok = await client.init();

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://server-a:8000/health');
  });

  test('re-reads baseUrl from the store on each health check (no caching)', async () => {
    setKyutaiBaseUrl('http://server-a:8000');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new KyutaiTTSClient();
    await client.init();
    expect(fetchMock.mock.calls[0]![0]).toBe('http://server-a:8000/health');

    // User edits the URL in the Settings panel after the client was init'd.
    // The next health probe must hit the new server, not the cached one.
    setKyutaiBaseUrl('http://server-b:8000');
    client.initialized = false;
    await client.init();

    expect(fetchMock.mock.calls.at(-1)![0]).toBe('http://server-b:8000/health');
  });

  test('falls back to the default baseUrl when settings are empty', async () => {
    useSettingsStore.setState({ settings: {} as SystemSettings });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new KyutaiTTSClient();
    await client.init();

    expect(fetchMock.mock.calls[0]![0]).toBe(`${DEFAULT_KYUTAI_SETTINGS.baseUrl}/health`);
  });

  test('getAllVoices() always returns the full voice catalogue', async () => {
    const client = new KyutaiTTSClient();
    const voices = await client.getAllVoices();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices.every((v) => v.id.startsWith('kyutai-'))).toBe(true);
  });
});
