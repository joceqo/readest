import envConfig, { isTauriAppPlatform } from '@/services/environment';

/**
 * Disk-cache for in-process TTS engine weights.
 *
 * The Kokoro-via-transformers.js cache lives in IndexedDB which the browser
 * can evict under storage pressure — and IndexedDB is wiped entirely when
 * the user clears site data or uses a fresh profile. Once a model has been
 * downloaded once the user reasonably expects the engine to work offline,
 * so on Tauri we mirror the bytes to `$APPDATA/Readest/models/<engine>/`
 * via the standard AppService FS plugin. Subsequent loads read straight
 * from disk regardless of IndexedDB state.
 *
 * On non-Tauri (pure web), we fall back to a plain `fetch` and let the
 * browser HTTP cache amortise repeat loads.
 */
const MODELS_DIR = 'models';

const sidecarPath = (engine: string, filename: string) =>
  `${MODELS_DIR}/${engine}/${filename}`;

const sidecarDir = (engine: string) => `${MODELS_DIR}/${engine}`;

export interface ModelFetchProgress {
  /** Path of the file being fetched, relative to the engine directory. */
  filename: string;
  /** Bytes received so far. May be 0 when the source doesn't expose a body reader. */
  loaded: number;
  /** Total bytes when the source reports Content-Length, otherwise null. */
  total: number | null;
  /** True once the file is fully written (to disk on Tauri, into memory on web). */
  done: boolean;
}

export type ModelFetchProgressCallback = (progress: ModelFetchProgress) => void;

const readFromDisk = async (
  engine: string,
  filename: string,
): Promise<Uint8Array | null> => {
  if (!isTauriAppPlatform()) return null;
  try {
    const appService = await envConfig.getAppService();
    const path = sidecarPath(engine, filename);
    if (!(await appService.exists(path, 'Data'))) return null;
    const buf = (await appService.readFile(path, 'Data', 'binary')) as ArrayBuffer;
    return new Uint8Array(buf);
  } catch (err) {
    // A corrupt or partially-written cache entry shouldn't break TTS — fall
    // through to a fresh network fetch and let the writer overwrite the
    // bad bytes. We log so the user can investigate if it persists.
    console.warn(`[modelCache] readFromDisk(${engine}/${filename}) failed:`, err);
    return null;
  }
};

const writeToDisk = async (
  engine: string,
  filename: string,
  bytes: Uint8Array,
): Promise<void> => {
  if (!isTauriAppPlatform()) return;
  try {
    const appService = await envConfig.getAppService();
    if (!(await appService.exists(sidecarDir(engine), 'Data'))) {
      await appService.createDir(sidecarDir(engine), 'Data', true);
    }
    // Copy into a fresh ArrayBuffer to detach from any pooled buffer the
    // network/streamed source returned. AppService.writeFile takes
    // ArrayBuffer; SharedArrayBuffer is rejected by some FS plugins.
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    await appService.writeFile(sidecarPath(engine, filename), 'Data', copy);
  } catch (err) {
    console.warn(`[modelCache] writeToDisk(${engine}/${filename}) failed:`, err);
  }
};

const fetchWithProgress = async (
  url: string,
  filename: string,
  onProgress?: ModelFetchProgressCallback,
): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? Number(contentLength) : null;

  // If the response has no readable body (HTTP/3 in some environments,
  // certain CDN responses), bail out to the simpler arrayBuffer path.
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    onProgress?.({ filename, loaded: buf.byteLength, total, done: true });
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.({ filename, loaded, total, done: false });
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress?.({ filename, loaded, total, done: true });
  return out;
};

/**
 * Resolve a model file as raw bytes, preferring an on-disk Tauri copy and
 * falling back to a network fetch. After a successful download, the bytes
 * are mirrored to `$APPDATA/Readest/models/<engine>/<filename>` so the
 * next load is offline-safe.
 *
 * @param engine — short id (e.g. "supertonic-3", "kokoro-82m"); also the
 *                 sidecar subdirectory.
 * @param filename — relative path inside the engine dir.
 * @param url — canonical download URL (typically HuggingFace `resolve/main/...`).
 * @param onProgress — fires while bytes are being received from the network.
 *                     Not fired for disk-cache hits.
 */
export const loadModelBytes = async (
  engine: string,
  filename: string,
  url: string,
  onProgress?: ModelFetchProgressCallback,
): Promise<Uint8Array> => {
  const cached = await readFromDisk(engine, filename);
  if (cached) return cached;
  const bytes = await fetchWithProgress(url, filename, onProgress);
  // Best-effort persist. Don't gate the return on disk write — the in-memory
  // bytes are still valid even if disk persistence fails.
  void writeToDisk(engine, filename, bytes);
  return bytes;
};

/**
 * Fetch and parse a JSON sidecar (configs, tokenizer indexers, voice
 * styles). Same disk-cache semantics as loadModelBytes — once a config has
 * been downloaded it survives offline.
 */
export const loadModelJson = async <T = unknown>(
  engine: string,
  filename: string,
  url: string,
): Promise<T> => {
  const bytes = await loadModelBytes(engine, filename, url);
  const text = new TextDecoder('utf-8').decode(bytes);
  return JSON.parse(text) as T;
};

/**
 * Intercept `globalThis.fetch` for a specific URL prefix and route those
 * requests through the disk cache. Used by engines whose loader we don't
 * own — Kokoro goes through transformers.js, which calls fetch() directly
 * against HuggingFace and caches the result in IndexedDB. IndexedDB can be
 * evicted under storage pressure, so without this layer the user loses TTS
 * the next time they open the app offline.
 *
 * Only requests whose URL starts with `urlPrefix` are intercepted; every
 * other fetch call passes through unchanged. The interceptor is installed
 * once and left in place — the matcher is precise enough to avoid
 * collisions, and removing it on cleanup would create races with in-flight
 * model loads.
 *
 * Returns the previous installer's removal function so callers can compose
 * if needed, but most call sites should just install once at engine init.
 */
export const installModelFetchInterceptor = (options: {
  /** Engine cache id, used as the subdirectory under $APPDATA/Readest/models/. */
  engine: string;
  /** URL prefix used to decide whether to intercept a given fetch. */
  urlPrefix: string;
  /** Optional rewriter that turns the request URL into a stable on-disk filename. */
  urlToFilename?: (url: string) => string;
}): (() => void) => {
  if (typeof globalThis === 'undefined' || typeof globalThis.fetch !== 'function') {
    return () => {};
  }
  const original = globalThis.fetch.bind(globalThis);
  const defaultMap = (url: string) =>
    // Strip the prefix and any query string so cache hits don't depend on
    // ?download=true / revision pinning that the loader may add.
    url.slice(options.urlPrefix.length).split('?')[0]!.replace(/^\/+/, '');

  const intercept = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (!url.startsWith(options.urlPrefix)) {
      return original(input as RequestInfo, init);
    }
    const filename = options.urlToFilename ? options.urlToFilename(url) : defaultMap(url);
    const cached = await readFromDisk(options.engine, filename);
    if (cached) {
      // Wrap as Blob to satisfy the BodyInit type — Response accepts
      // Uint8Array at runtime but the TS DOM lib types are stricter than
      // the spec on this. A Blob is zero-copy from the underlying buffer.
      return new Response(new Blob([cached as BlobPart]), {
        status: 200,
        headers: new Headers({
          'content-type': 'application/octet-stream',
          'content-length': String(cached.byteLength),
        }),
      });
    }
    const response = await original(input as RequestInfo, init);
    if (!response.ok || !response.body) return response;
    // Tee the body: one branch returns to the caller, the other writes to
    // disk. The simpler arrayBuffer() approach would force the loader to
    // wait for the full download before seeing any byte, which kills the
    // streaming progress UI inside transformers.js.
    const cloned = response.clone();
    void cloned.arrayBuffer().then((buf) => {
      writeToDisk(options.engine, filename, new Uint8Array(buf));
    });
    return response;
  };

  globalThis.fetch = intercept as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
};

/**
 * Quick existence check the UI can use to decide whether to show a
 * "first-use download" hint before the user triggers synthesis.
 */
export const isEngineCached = async (
  engine: string,
  filenames: string[],
): Promise<boolean> => {
  if (!isTauriAppPlatform()) return false;
  try {
    const appService = await envConfig.getAppService();
    for (const filename of filenames) {
      if (!(await appService.exists(sidecarPath(engine, filename), 'Data'))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};
