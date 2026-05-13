/**
 * Map a source-side `Range` (the one foliate-js's TTS returns from
 * `setMark()`) onto the matching translated `<font class="target-inner">`
 * sibling produced by the translation observer.
 *
 * Why this exists: `packages/foliate-js/tts.js` builds its mark ranges
 * from a textWalker over the original document, so `setMark(name)` always
 * returns a Range over the source text. When the user has TTS set to
 * "Read aloud: Translated", the audio plays the French text but the
 * highlight would otherwise land on the English sibling above it. We
 * re-anchor the Range to the translation sibling here so the existing
 * CFI → Overlayer pipeline draws the highlight on the spoken text.
 *
 * The translation observer (src/app/reader/hooks/useTextTranslation.ts)
 * produces this DOM shape:
 *
 *   <p class="translation-source" ...>
 *     Original English text…
 *     <font class="translation-target" lang="fr">
 *       <font class="translation-target translation-target-block">
 *         <font class="translation-target target-inner …">
 *           Texte traduit…
 *         </font>
 *       </font>
 *     </font>
 *   </p>
 *
 * Both the source and the translated text live inside the same paragraph
 * element. We walk up to that element and pick the `target-inner` wrapper
 * that holds the actual translated text.
 *
 * Returns `null` whenever the lookup can't be completed — caller falls
 * back to the original source range so non-translated paragraphs and
 * non-translation flows keep their existing behaviour.
 */
export const findTranslatedRange = (sourceRange: Range): Range | null => {
  const startNode = sourceRange.startContainer;
  const startElement =
    startNode.nodeType === Node.ELEMENT_NODE ? (startNode as Element) : startNode.parentElement;
  if (!startElement) return null;

  // If the range is already inside the translated wrapper, foliate-js's
  // own textWalker already picked the right sub-range (e.g. per-sentence
  // inside the French paragraph). Replacing it with the whole
  // `.target-inner` would broaden a sentence-level highlight into a
  // paragraph-level one, which is what was happening before. Leave it
  // alone — the caller will keep the source-side range.
  if (startElement.closest('.target-inner')) return null;

  const sourceParagraph = startElement.closest('.translation-source');
  if (!sourceParagraph) return null;

  // The translation observer nests multiple `.translation-target` wrappers
  // — we want the innermost one (`.target-inner`) since that holds the
  // actual text content with no inner wrappers.
  const targetInner = sourceParagraph.querySelector('.target-inner');
  if (!targetInner || !targetInner.textContent?.trim()) return null;

  const doc = targetInner.ownerDocument;
  if (!doc) return null;

  const range = doc.createRange();
  range.selectNodeContents(targetInner);
  return range;
};
