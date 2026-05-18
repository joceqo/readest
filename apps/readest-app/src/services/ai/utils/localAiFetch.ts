/**
 * Local AI servers (Ollama, LM Studio) are called from http(s) page origins.
 * Tauri's WebKit often rejects plain `fetch` to localhost ("Load failed");
 * the HTTP plugin uses the native stack and succeeds.
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';

export function localAiFetch(input: string, init?: RequestInit): Promise<Response> {
  const impl = isTauriAppPlatform() ? tauriFetch : globalThis.fetch.bind(globalThis);
  return impl(input, init);
}
