import { useCallback, useEffect, useRef, useState } from 'react';
import { FoliateView } from '@/types/view';
import { UseTranslatorOptions } from '@/services/translators';
import { useReaderStore } from '@/store/readerStore';
import { useTranslator } from '@/hooks/useTranslator';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import { walkTextNodes } from '@/utils/walk';
import { debounce } from '@/utils/debounce';
import { getLocale } from '@/utils/misc';

export function useTextTranslation(
  bookKey: string,
  view: FoliateView | HTMLElement | null,
  widthLineBreak = false,
  targetBlockClassName = 'translation-target-block',
) {
  const _ = useTranslation();
  const { getViewSettings, getProgress, setIsLoading } = useReaderStore();
  const viewSettings = getViewSettings(bookKey);
  const progress = getProgress(bookKey);

  const enabled = useRef(viewSettings?.translationEnabled);
  const [provider, setProvider] = useState(viewSettings?.translationProvider);
  const [targetLang, setTargetLang] = useState(viewSettings?.translateTargetLang);
  const showTranslateSourceRef = useRef(viewSettings?.showTranslateSource);
  // Tracks whether TTS is reading the translated text. When true, the current
  // section is translated eagerly (every paragraph, not just visible ones) so
  // the SSML extracted by foliate-js's TTS contains the French text instead of
  // the source. The prefetch of prev/next sections runs regardless — it only
  // warms the translation cache and is cheap once entries are cached.
  const ttsReadTranslatedRef = useRef(viewSettings?.ttsReadAloudText === 'translated');

  const { translate } = useTranslator({
    provider,
    targetLang: targetLang || getLocale(),
  } as UseTranslatorOptions);

  const translateRef = useRef(translate);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const translatedElements = useRef<HTMLElement[]>([]);
  const allTextNodes = useRef<HTMLElement[]>([]);
  const translationQueue = useRef<HTMLElement[]>([]);
  const activeTranslations = useRef(0);
  const MAX_CONCURRENT_TRANSLATIONS = 5;
  const pendingDOMUpdates = useRef<Array<() => void>>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cache-warming for adjacent sections: keyed by section index. Each entry
  // resolves once the section's text has been pushed through translateRef
  // (which calls storeInCache). When the user navigates to that section, the
  // intersection observer fires translateElement, hits the cache, and inserts
  // the translated DOM nearly instantly.
  const prefetchedSections = useRef<Set<number>>(new Set());
  const prefetchPending = useRef<number[]>([]);
  const prefetchInFlight = useRef(0);
  const MAX_CONCURRENT_PREFETCH = 1;

  const toggleTranslationVisibility = (visible: boolean) => {
    translatedElements.current.forEach((element) => {
      const translationTargets = element.querySelectorAll('.translation-target');
      translationTargets.forEach((target) => {
        if (visible) {
          target.classList.remove('hidden');
        } else {
          target.classList.add('hidden');
        }
      });
    });
  };

  useEffect(() => {
    translateRef.current = translate;
  }, [translate]);

  const hintInitialTranslating = () => {
    setIsLoading(bookKey, true);
    eventDispatcher.dispatch('hint', {
      bookKey,
      message: _('Translating...'),
    });
    hintTimerRef.current = setTimeout(() => {
      hintTimerRef.current = null;
      setIsLoading(bookKey, false);
    }, 2000);
  };

  const observeTextNodes = () => {
    if (!view || !enabled.current) return;

    const observer = createTranslationObserver();
    observerRef.current = observer;
    const nodes = walkTextNodes(view, ['pre', 'code', 'math']);
    console.log(
      'Observing text nodes for translation:',
      nodes.length,
      // nodes.map((n) => n.textContent),
    );
    allTextNodes.current = nodes;
    nodes.forEach((el) => observer.observe(el));

    // When TTS is reading the translated text, the SSML foliate-js extracts on
    // section init must already contain the French DOM siblings — otherwise it
    // reads English. Bypass the intersection observer and translate every
    // paragraph in the current section right away.
    if (ttsReadTranslatedRef.current) {
      nodes.forEach((el) => scheduleTranslation(el));
    }
  };

  // Walk an off-screen Document (returned by SectionItem.createDocument) the
  // same way walkTextNodes does, and push each text into translateRef. The
  // translate helper writes results into the shared translation cache, so
  // when the user actually navigates to the section the intersection observer
  // gets cache hits and renders translations without a network round-trip.
  const prefetchSection = async (idx: number) => {
    if (prefetchedSections.current.has(idx)) return;
    prefetchedSections.current.add(idx);
    if (!view || !('renderer' in view)) return;
    const fv = view as FoliateView;
    const section = fv.book?.sections?.[idx];
    if (!section?.createDocument) return;
    try {
      const doc = await section.createDocument();
      if (!doc?.body) return;
      const els = walkTextNodes(doc.body, ['pre', 'code', 'math']);
      const texts: string[] = [];
      for (const el of els) {
        const t = el.textContent?.replaceAll('\n', '').trim();
        if (t) texts.push(t);
      }
      if (!texts.length) return;
      const CHUNK = 5;
      for (let i = 0; i < texts.length; i += CHUNK) {
        if (!enabled.current) return;
        try {
          await translateRef.current(texts.slice(i, i + CHUNK));
        } catch {
          // Best-effort — one failed chunk shouldn't kill the rest of the
          // prefetch pass, and the live observer can still retry later.
        }
      }
    } catch {
      // createDocument may legitimately fail (e.g. broken EPUB section); drop
      // the marker so the next 'load' event can retry.
      prefetchedSections.current.delete(idx);
    }
  };

  const drainPrefetchQueue = () => {
    while (
      prefetchInFlight.current < MAX_CONCURRENT_PREFETCH &&
      prefetchPending.current.length > 0
    ) {
      const idx = prefetchPending.current.shift()!;
      prefetchInFlight.current++;
      prefetchSection(idx).finally(() => {
        prefetchInFlight.current--;
        drainPrefetchQueue();
      });
    }
  };

  const schedulePrefetchAroundCurrent = () => {
    if (!view || !enabled.current) return;
    if (!('renderer' in view)) return;
    const fv = view as FoliateView;
    const curr = fv.renderer?.primaryIndex;
    const total = fv.book?.sections?.length ?? 0;
    if (typeof curr !== 'number' || total === 0) return;
    for (const idx of [curr - 1, curr + 1]) {
      if (idx < 0 || idx >= total) continue;
      if (prefetchedSections.current.has(idx)) continue;
      if (prefetchPending.current.includes(idx)) continue;
      prefetchPending.current.push(idx);
    }
    drainPrefetchQueue();
  };

  const updateTranslation = () => {
    translationQueue.current = [];
    activeTranslations.current = 0;
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    pendingDOMUpdates.current = [];
    translatedElements.current.forEach((element) => {
      const translationTargets = element.querySelectorAll('.translation-target');
      translationTargets.forEach((target) => target.remove());
    });

    translatedElements.current = [];
    if (viewSettings?.translationEnabled && view) {
      recreateTranslationObserver();
    }
  };

  const createTranslationObserver = () => {
    const visibleElements = new Set<HTMLElement>();
    return new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleElements.add(entry.target as HTMLElement);
          } else {
            visibleElements.delete(entry.target as HTMLElement);
          }
        }

        if (visibleElements.size === 0) return;

        const nodes = allTextNodes.current;
        if (nodes.length === 0) return;

        let firstIdx = nodes.length;
        let lastIdx = -1;
        for (const el of visibleElements) {
          const idx = nodes.indexOf(el);
          if (idx !== -1) {
            if (idx < firstIdx) firstIdx = idx;
            if (idx > lastIdx) lastIdx = idx;
          }
        }

        if (lastIdx === -1) return;

        const startIdx = Math.max(0, firstIdx - 1);
        const endIdx = Math.min(nodes.length - 1, lastIdx + 2);

        for (let i = startIdx; i <= endIdx; i++) {
          const node = nodes[i];
          if (node) {
            scheduleTranslation(node);
          }
        }
      },
      { threshold: 0 },
    );
  };

  const scheduleTranslation = (el: HTMLElement) => {
    if (!enabled.current) return;
    if (el.classList.contains('translation-target')) return;
    if (el.querySelector('.translation-target')) return;
    if (translationQueue.current.indexOf(el) !== -1) return;
    translationQueue.current.push(el);
    drainTranslationQueue();
  };

  const drainTranslationQueue = () => {
    while (
      activeTranslations.current < MAX_CONCURRENT_TRANSLATIONS &&
      translationQueue.current.length > 0
    ) {
      const el = translationQueue.current.shift()!;
      if (el.querySelector('.translation-target') || !enabled.current) continue;
      activeTranslations.current++;
      translateElement(el).finally(() => {
        activeTranslations.current--;
        drainTranslationQueue();
      });
    }
    if (translationQueue.current.length === 0 && activeTranslations.current === 0) {
      setTimeout(() => {
        setIsLoading(bookKey, false);
      }, 500);
    }
  };

  const batchDOMUpdate = (update: () => void) => {
    pendingDOMUpdates.current.push(update);
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(() => {
        batchTimerRef.current = null;
        const updates = pendingDOMUpdates.current.splice(0);
        updates.forEach((fn) => fn());
      }, 50);
    }
  };

  const recreateTranslationObserver = () => {
    const observer = createTranslationObserver();
    observerRef.current?.disconnect();
    observerRef.current = observer;
    allTextNodes.current.forEach((el) => observer.observe(el));
  };

  const translateElement = async (el: HTMLElement) => {
    if (!enabled.current) return;
    const text = el.textContent?.replaceAll('\n', '').trim();
    if (!text) return;

    if (el.classList.contains('translation-target')) {
      return;
    }

    const updateSourceNodes = (element: HTMLElement) => {
      const hasDirectText = Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() !== '',
      );
      if (hasDirectText) {
        element.classList.add('translation-source');

        const textNodes = Array.from(element.childNodes).filter(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() !== '',
        );

        if (!element.hasAttribute('original-text-stored')) {
          element.setAttribute(
            'original-text-nodes',
            JSON.stringify(textNodes.map((node) => node.textContent)),
          );
          element.setAttribute('original-text-stored', 'true');
        }
      }
      const isSource = element.classList.contains('translation-source');
      if (isSource) {
        const textNodes = Array.from(element.childNodes).filter(
          (node) => node.nodeType === Node.TEXT_NODE,
        ) as Text[];

        if (showTranslateSourceRef.current) {
          const originalTexts = JSON.parse(element.getAttribute('original-text-nodes') || '[]');
          textNodes.forEach((textNode, index) => {
            if (originalTexts[index] !== undefined) {
              textNode.textContent = originalTexts[index];
            }
          });
        } else {
          textNodes.forEach((textNode) => {
            textNode.textContent = '';
          });
        }
      }
      for (const child of Array.from(element.childNodes)) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const node = child as HTMLElement;
        if (!node.classList.contains('translation-target')) {
          updateSourceNodes(node);
        }
      }
    };

    try {
      const translated = await translateRef.current([text]);
      const translatedText = translated[0];
      if (!translatedText || text === translatedText) return;

      const wrapper = document.createElement('font');
      wrapper.className = `translation-target ${!enabled.current ? 'hidden' : ''}`;
      wrapper.setAttribute('translation-element-mark', '1');
      wrapper.setAttribute('lang', targetLang || getLocale());
      if (widthLineBreak) {
        wrapper.appendChild(document.createElement('br'));
      }

      const blockWrapper = document.createElement('font');
      blockWrapper.className = `translation-target ${targetBlockClassName}`;

      const inner = document.createElement('font');
      inner.className = 'translation-target target-inner target-inner-theme-none';
      inner.textContent = translatedText;

      blockWrapper.appendChild(inner);
      wrapper.appendChild(blockWrapper);

      if (el.querySelector('.translation-target')) {
        return;
      }
      batchDOMUpdate(() => {
        if (!enabled.current || el.querySelector('.translation-target')) return;
        updateSourceNodes(el);
        el.appendChild(wrapper);
        translatedElements.current.push(el);
      });
    } catch (err) {
      console.warn('Translation failed:', err);
    }
  };

  const findNodeIndicesInRange = (range: Range, nodes: HTMLElement[]) => {
    const startContainer = range.startContainer;
    const endContainer = range.endContainer;

    let startIndex = -1;
    let endIndex = -1;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node === startContainer || node.contains(startContainer)) {
        if (startIndex === -1) startIndex = i;
      }
      if (node === endContainer || node.contains(endContainer)) {
        endIndex = i;
      }
    }
    if (startIndex !== -1 && endIndex === -1) {
      endIndex = startIndex;
    }

    return { startIndex, endIndex };
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const translateInRange = useCallback(
    debounce((range: Range) => {
      const nodes = allTextNodes.current;
      if (nodes.length === 0) {
        console.warn('No text nodes available for translation.');
        return;
      }
      const { startIndex, endIndex } = findNodeIndicesInRange(range, nodes);
      if (startIndex === -1) {
        console.log('Range not found in text nodes');
        return;
      }
      const beforeContext = 2;
      const afterContext = 5;
      const beforeStart = Math.max(0, startIndex - beforeContext);
      const afterEnd = Math.min(nodes.length - 1, endIndex + afterContext);
      for (let i = beforeStart; i <= afterEnd; i++) {
        const node = nodes[i];
        if (node) {
          scheduleTranslation(node);
        }
      }
    }, 500),
    [scheduleTranslation],
  );

  useEffect(() => {
    if (enabled.current && progress) {
      const { range } = progress;
      translateInRange(range);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);

  useEffect(() => {
    if (!viewSettings) return;

    const enabledChanged = enabled.current !== viewSettings.translationEnabled;
    const providerChanged = provider !== viewSettings.translationProvider;
    const targetLangChanged = targetLang !== viewSettings.translateTargetLang;
    const showTranslateSourceChanged =
      showTranslateSourceRef.current !== viewSettings.showTranslateSource;

    if (enabledChanged) {
      enabled.current = viewSettings.translationEnabled;
    }

    if (providerChanged) {
      setProvider(viewSettings.translationProvider);
    }

    if (targetLangChanged) {
      setTargetLang(viewSettings.translateTargetLang);
    }

    if (showTranslateSourceChanged) {
      showTranslateSourceRef.current = viewSettings.showTranslateSource;
    }

    // Keep the eager-translate gate in sync with the live setting so toggling
    // "Read Aloud Text → Translated" at runtime takes effect on the next
    // section load (and on the current one via the catch-up below).
    const nextTtsReadTranslated = viewSettings.ttsReadAloudText === 'translated';
    const ttsModeChanged = ttsReadTranslatedRef.current !== nextTtsReadTranslated;
    ttsReadTranslatedRef.current = nextTtsReadTranslated;

    if (enabledChanged) {
      toggleTranslationVisibility(viewSettings.translationEnabled);
      if (enabled.current) {
        observeTextNodes();
        schedulePrefetchAroundCurrent();
      }
    } else if (providerChanged || targetLangChanged || showTranslateSourceChanged) {
      updateTranslation();
      // Provider/target changes invalidate previous cache entries (different
      // cache key), so re-prefetch the adjacent sections.
      prefetchedSections.current.clear();
      schedulePrefetchAroundCurrent();
    } else if (ttsModeChanged && nextTtsReadTranslated && enabled.current) {
      // Catch up: user just flipped to translated TTS mid-section. Force the
      // current section's untranslated paragraphs through the queue.
      allTextNodes.current.forEach((el) => scheduleTranslation(el));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey, viewSettings, provider, targetLang]);

  useEffect(() => {
    if (!view || !enabled.current) return;

    if ('renderer' in view) {
      view.addEventListener('load', observeTextNodes);
      view.addEventListener('load', hintInitialTranslating);
      view.addEventListener('load', schedulePrefetchAroundCurrent);
      // Prime the prefetch for the very first chapter the reader opens to —
      // 'load' has already fired by the time this effect attaches.
      schedulePrefetchAroundCurrent();
    } else {
      observeTextNodes();
    }
    return () => {
      if ('renderer' in view) {
        view.removeEventListener('load', observeTextNodes);
        view.removeEventListener('load', hintInitialTranslating);
        view.removeEventListener('load', schedulePrefetchAroundCurrent);
      }
      observerRef.current?.disconnect();
      translatedElements.current = [];
      translationQueue.current = [];
      activeTranslations.current = 0;
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      if (hintTimerRef.current) {
        clearTimeout(hintTimerRef.current);
        hintTimerRef.current = null;
      }
      pendingDOMUpdates.current = [];
      prefetchedSections.current.clear();
      prefetchPending.current = [];
      prefetchInFlight.current = 0;
      setIsLoading(bookKey, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
}
