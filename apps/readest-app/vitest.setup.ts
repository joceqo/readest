// Node can expose a broken experimental `localStorage` (e.g. `--localstorage-file`),
// which makes `typeof localStorage !== 'undefined'` true but `getItem` unusable.
// Replace with a minimal in-memory Storage so unit tests behave.
if (typeof globalThis.localStorage !== 'undefined') {
  try {
    if (typeof globalThis.localStorage.getItem !== 'function') {
      throw new TypeError('localStorage.getItem not a function');
    }
    globalThis.localStorage.getItem('');
  } catch {
    const store: Record<string, string> = {};
    const memoryStorage: Storage = {
      get length() {
        return Object.keys(store).length;
      },
      clear() {
        for (const k of Object.keys(store)) delete store[k];
      },
      getItem(key: string) {
        return store[key] ?? null;
      },
      key(index: number) {
        return Object.keys(store)[index] ?? null;
      },
      removeItem(key: string) {
        delete store[key];
      },
      setItem(key: string, value: string) {
        store[key] = value;
      },
    };
    globalThis.localStorage = memoryStorage;
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'localStorage', {
        value: memoryStorage,
        configurable: true,
        writable: true,
      });
    }
  }
}

// matchMedia mock
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
