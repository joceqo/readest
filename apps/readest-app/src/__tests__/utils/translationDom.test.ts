import { describe, it, expect } from 'vitest';
import { findTranslatedRange } from '@/utils/translationDom';

const sourceText = 'I am incredibly grateful to Daniel Kleine…';
const translatedText = 'Je suis incroyablement reconnaissant envers Daniel Kleine…';

const buildTranslatedParagraph = (
  doc: Document,
  source = sourceText,
  translated = translatedText,
): { p: HTMLParagraphElement; sourceTextNode: Text } => {
  const p = doc.createElement('p');
  p.className = 'aligned-justify translation-source';

  const sourceTextNode = doc.createTextNode(source);
  p.appendChild(sourceTextNode);

  // Mirror the structure from useTextTranslation.ts: three nested
  // <font class="translation-target"> elements, the innermost has the
  // `target-inner` class and holds the translated text.
  const outer = doc.createElement('font');
  outer.className = 'translation-target';
  outer.setAttribute('lang', 'fr');

  const block = doc.createElement('font');
  block.className = 'translation-target translation-target-block';

  const inner = doc.createElement('font');
  inner.className = 'translation-target target-inner target-inner-theme-none';
  inner.appendChild(doc.createTextNode(translated));

  block.appendChild(inner);
  outer.appendChild(block);
  p.appendChild(outer);

  doc.body.appendChild(p);
  return { p, sourceTextNode };
};

describe('findTranslatedRange', () => {
  it('returns a Range over the .target-inner text when the source paragraph is translated', () => {
    const { sourceTextNode } = buildTranslatedParagraph(document);
    const source = document.createRange();
    source.setStart(sourceTextNode, 0);
    source.setEnd(sourceTextNode, sourceTextNode.length);

    const result = findTranslatedRange(source);
    expect(result).not.toBeNull();
    expect(result!.toString()).toBe(translatedText);
  });

  it('returns null when the source range has no .translation-source ancestor', () => {
    const p = document.createElement('p');
    const text = document.createTextNode('Plain paragraph, no translation observer pass');
    p.appendChild(text);
    document.body.appendChild(p);
    const source = document.createRange();
    source.setStart(text, 0);
    source.setEnd(text, text.length);

    expect(findTranslatedRange(source)).toBeNull();
  });

  it('returns null when the translation paragraph has no .target-inner descendant yet', () => {
    // Mid-translation snapshot — observer has set the .translation-source
    // class but the translation hasn't been inserted yet (or got removed).
    const p = document.createElement('p');
    p.className = 'translation-source';
    const text = document.createTextNode('Source text waiting for translation');
    p.appendChild(text);
    document.body.appendChild(p);
    const source = document.createRange();
    source.setStart(text, 0);
    source.setEnd(text, text.length);

    expect(findTranslatedRange(source)).toBeNull();
  });

  // Regression: foliate-js's textWalker traverses the inserted translation
  // siblings too, so setMark can return a Range that already lives inside
  // `.target-inner`. In that case we don't want to widen the highlight to
  // the entire paragraph — the source range is already pointing at the
  // correct per-sentence span of the translated text.
  it('returns null when the source range is already inside .target-inner', () => {
    const { p } = buildTranslatedParagraph(document);
    const inner = p.querySelector('.target-inner')!;
    const innerText = inner.firstChild as Text;
    const source = document.createRange();
    source.setStart(innerText, 0);
    source.setEnd(innerText, Math.min(20, innerText.length));

    expect(findTranslatedRange(source)).toBeNull();
  });

  it('returns null when .target-inner exists but is empty', () => {
    const p = document.createElement('p');
    p.className = 'translation-source';
    p.appendChild(document.createTextNode('Source text'));
    const inner = document.createElement('font');
    inner.className = 'target-inner';
    inner.textContent = '   '; // whitespace-only
    p.appendChild(inner);
    document.body.appendChild(p);
    const source = document.createRange();
    source.setStart(p.firstChild!, 0);
    source.setEnd(p.firstChild!, 11);

    expect(findTranslatedRange(source)).toBeNull();
  });
});
