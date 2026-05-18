'use client';

import { useEffect } from 'react';

const PLUGIN_NAME = 'ai-context-enricher';

function buildAiContextBlock(content: string, elements: Element[]): string {
  const el = elements[0];
  if (!el) return content;

  const lines: string[] = ['', '--- Extra context for AI ---'];

  lines.push(`URL: ${window.location.href}`);
  lines.push(`Route title: ${document.title}`);
  lines.push(`Viewport: ${window.innerWidth}x${window.innerHeight}`);

  const tag = el.tagName.toLowerCase();
  const fullAttrs = Array.from(el.attributes)
    .map((a) => `${a.name}="${a.value}"`)
    .join(' ');
  lines.push(`Element: <${tag}${fullAttrs ? ` ${fullAttrs}` : ''}>`);

  const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
  const ariaLabel = el.getAttribute('aria-label');
  const ariaDescribedBy = el.getAttribute('aria-describedby');
  lines.push(
    `A11y: role=${role}` +
      (ariaLabel ? ` aria-label="${ariaLabel}"` : '') +
      (ariaDescribedBy ? ` aria-describedby="${ariaDescribedBy}"` : ''),
  );

  const rect = el.getBoundingClientRect();
  const cs = window.getComputedStyle(el);
  lines.push(
    `Bounds: ${Math.round(rect.width)}x${Math.round(rect.height)} @ (${Math.round(rect.x)}, ${Math.round(rect.y)})`,
  );
  lines.push(
    `Computed: display=${cs.display} position=${cs.position} flex=${cs.flexDirection}/${cs.justifyContent}/${cs.alignItems} overflow=${cs.overflow}`,
  );

  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 400);
  if (text) lines.push(`Text: "${text}"`);

  const ancestry: string[] = [];
  let current: Element | null = el.parentElement;
  let depth = 0;
  while (current && depth < 8) {
    const t = current.tagName.toLowerCase();
    const id = current.id ? `#${current.id}` : '';
    const rawClass =
      typeof (current as HTMLElement).className === 'string'
        ? (current as HTMLElement).className
        : (current.getAttribute('class') ?? '');
    const cls =
      rawClass.trim() !== ''
        ? `.${rawClass.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`
        : '';
    ancestry.push(`${t}${id}${cls}`);
    current = current.parentElement;
    depth++;
  }
  if (ancestry.length) lines.push(`DOM ancestry: ${ancestry.join(' > ')}`);

  if (elements.length > 1) {
    lines.push(`Sibling selections (${elements.length - 1} more):`);
    elements.slice(1, 6).forEach((sib, i) => {
      lines.push(
        `  [${i + 1}] <${sib.tagName.toLowerCase()}> ${(sib.textContent ?? '').trim().slice(0, 80)}`,
      );
    });
  }

  return `${content}\n${lines.join('\n')}`;
}

/**
 * Dev-only: [react-grab](https://github.com/aidenybai/react-grab) with a clipboard plugin
 * that adds URL, layout, a11y, ancestry, and multi-select hints for AI workflows.
 */
export default function DevReactGrab() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;

    let cancelled = false;

    void import('react-grab').then(({ init, registerPlugin }) => {
      if (cancelled) return;

      init();
      registerPlugin({
        name: PLUGIN_NAME,
        hooks: {
          transformCopyContent: (copyContent, elements) => {
            try {
              return buildAiContextBlock(copyContent, elements);
            } catch {
              return copyContent;
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      void import('react-grab').then(({ unregisterPlugin }) => {
        unregisterPlugin(PLUGIN_NAME);
      });
    };
  }, []);

  return null;
}
