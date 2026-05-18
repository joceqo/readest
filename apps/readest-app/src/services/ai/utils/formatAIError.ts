import { APICallError } from 'ai';

function clip(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * Turns AI SDK / provider errors (often just `Bad Request`) into something
 * actionable: HTTP status, server JSON message, response snippet, URL.
 */
export function formatAIProviderError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const parts: string[] = [];
    if (error.statusCode != null) {
      parts.push(`HTTP ${error.statusCode}`);
    }
    if (error.message) {
      parts.push(error.message);
    }

    let detail = '';
    if (error.responseBody) {
      const raw = error.responseBody.trim();
      try {
        const j = JSON.parse(raw) as Record<string, unknown>;
        const errField = j['error'];
        if (typeof errField === 'string') {
          detail = errField;
        } else if (errField && typeof errField === 'object') {
          const o = errField as Record<string, unknown>;
          detail =
            (typeof o['message'] === 'string' ? o['message'] : '') ||
            (typeof o['error'] === 'string' ? o['error'] : '') ||
            '';
        }
        if (!detail && typeof j['message'] === 'string') {
          detail = j['message'];
        }
      } catch {
        detail = raw;
      }
    }
    if (detail) {
      parts.push(clip(detail, 500));
    }
    if (error.url) {
      parts.push(clip(error.url, 200));
    }
    const out = parts.filter(Boolean).join(' — ');
    return out || 'Unknown AI provider error';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
