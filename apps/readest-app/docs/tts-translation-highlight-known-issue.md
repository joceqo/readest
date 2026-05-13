# TTS + translation highlight — known issue

## What works

- **Translation provider for local LLMs** (Settings → Local LLM): Ollama and
  LM Studio via OpenAI-compatible `/v1/chat/completions`. URL auto-detect
  uses `tauriFetch` so the Tauri webview's CORS/CSP doesn't block the
  request. Model auto-discovery via `/v1/models` (LM Studio) with fallback
  to `/api/tags` (Ollama).
- **Local Kokoro TTS** (`KokoroTTSClient`): in-process via `kokoro-js`, no
  external server required. ~80MB model download on first use, cached.
- **LM Studio in the AI Assistant** (Settings → AI Assistant → Provider):
  uses `@ai-sdk/openai-compatible` so chat + embeddings flow through the
  same local server you already configured.
- **TTS reads the translated text** when `viewSettings.translationEnabled`
  is true and `viewSettings.ttsReadAloudText === 'translated'`. The SSML
  filter (`filterSSMLWithLang` in `src/utils/ssml.ts`) drops the source
  language's `<lang>` blocks and loose source text, keeping only the
  target-language content + its marks, with a synthetic leading mark
  injected when the target block opens with raw text. Audio plays every
  translated sentence, including the first one of each paragraph.
- **Translation cache** is persisted in IndexedDB and, on Tauri builds,
  mirrored to a JSON sidecar at `$APPDATA/Readest/translations/cache.json`
  so translations survive an IndexedDB wipe.

## What does not work yet

When the user picks "Read translated text", the audio is correct but the
**visual highlight overlay does not track the translated paragraph**. The
overlay either:

1. Stays on the **English source text** (foliate-js's default behaviour
   — its `setMark()` returns ranges over the source DOM), or
2. **Disappears entirely** if we try to redraw on the translated DOM.

The reverted state (currently shipped) is option 1 — the source highlight
is visible while the translated audio plays.

## Why it's hard — root cause

The translation observer (`src/app/reader/hooks/useTextTranslation.ts`)
appends the translated text as a DOM sibling inside the same paragraph
element:

```html
<p class="translation-source">
  Original English text…
  <font class="translation-target" lang="fr">
    <font class="translation-target translation-target-block">
      <font class="translation-target target-inner …"> Texte traduit… </font>
    </font>
  </font>
</p>
```

So the French text exists in the live DOM. The trouble is the highlight
pipeline:

1. **foliate-js builds marks from its own textWalker** during TTS init
   (`packages/foliate-js/tts.js` → `getFragmentWithMarks`). The walker
   visits text nodes in document order, so the **mapping mark-name →
   `Range`** is fixed at TTS init time. Marks for "English" segments
   refer to source-side ranges; marks for "French" segments (when
   textWalker traverses inside `<font class="target-inner">`) refer to
   ranges _inside_ the translation wrapper.
2. **The SSML chunks foliate-js emits don't always tag the first
   sentence inside a `<lang>` block.** That's the bug we worked around in
   `filterSSMLWithLang`: we inject a leading `<mark>` inside each kept
   `<lang>` block so `parseSSMLMarks` finds the first sentence and the
   TTS client iterates it. But the injected mark name is one we recycle
   from the dropped source side, so `setMark(name)` returns the
   **source-side range**, not a French range.
3. **`view.tts.setMark()` internally calls our highlight callback** with
   that source-side range. Our `#getHighlighter` then computes a CFI via
   `view.getCFI(index, range)`, resolves it back through
   `view.resolveCFI(cfi).anchor(doc)`, and adds an overlay via the
   `Overlayer`.
4. **CFI mapping for ranges inside `<font class="target-inner">` is
   unreliable.** That's our finding from the two attempts described
   below. When we hand the highlighter a range covering the
   `.target-inner` text, `getCFI` either throws or returns a CFI that
   `resolveCFI`/`anchor` can't materialise back into a usable range on
   the rendered iframe. The result: the `overlayer.add(...)` call never
   succeeds for the translated range.

## What we tried

Both attempts and why they regressed:

### Attempt 1 — redraw after foliate-js's setMark, inside `dispatchSpeakMark`

```ts
const sourceRange = this.view.tts?.setMark(mark.name);
// foliate-js has already drawn the source-side highlight here.
const translatedRange = findTranslatedRange(sourceRange);
if (translatedRange) {
  // Redraw on the translated range using the same overlayer + key.
  this.#getHighlighter()(translatedRange);
}
```

`findTranslatedRange` in `src/utils/translationDom.ts` walks up to
`.translation-source` and returns a Range over the descendant
`.target-inner`. We expected the second `overlayer.add(HIGHLIGHT_KEY,
…)` call to replace the first one because of the shared key, but in
practice the user saw **both languages highlighted simultaneously**.
Two hypotheses for why:

- The two ranges live in different "primary content" sections from the
  `Overlayer`'s perspective and use separate SVG layers (one per
  iframe?), so they don't deduplicate by key.
- The `Overlayer`'s `remove`/`add` cycle isn't strictly synchronous, so
  the second call's `remove` actually clears the _second_ draw's overlay
  rather than the first.

### Attempt 2 — remap inside `#getHighlighter`

Push the `findTranslatedRange` call into the highlighter callback itself
so foliate-js's single `setMark → highlight` invocation paints on the
translated range from the start:

```ts
const effectiveRange = this.ttsTargetLang ? (findTranslatedRange(range) ?? range) : range;
const cfi = this.view.getCFI(index, effectiveRange);
const visibleRange = this.view.resolveCFI(cfi).anchor(doc);
overlayer?.remove(HIGHLIGHT_KEY);
overlayer?.add(HIGHLIGHT_KEY, visibleRange, Overlayer[style], { color });
```

This produced **no highlight at all**. The fall-back-on-failure variant
(try remapped, then source) didn't help — both candidates threw before
reaching `overlayer.add`. Our diagnosis: `getCFI` rejects ranges anchored
inside the `<font class="target-inner">` wrapper, so we never get a
`visibleRange` to draw.

Reverted to the original `#getHighlighter` (no remap). foliate-js draws
the source highlight, which is at least visible feedback for the reader.

## Promising directions for a real fix

1. **Bypass CFI for translated ranges.** The `Overlayer` ultimately needs
   a `Range` it can rect-test against the iframe's content. If we can
   skip the CFI roundtrip when the range already lives in the rendered
   document, we can call `overlayer.add(KEY, range, …)` directly. Needs
   reading the `Overlayer.add` implementation in
   `packages/foliate-js/overlayer.js` to confirm it accepts a raw Range
   in the same document.
2. **Inject `data-cfi`-ish attributes during the translation observer
   pass.** If foliate-js's CFI generator chokes on `<font>` wrappers but
   handles, say, `<span>` with no styling, we could swap the translation
   observer's emitted tags. Lower risk than touching foliate-js.
3. **Build a parallel "translated TTS" pipeline.** Walk the
   `.target-inner` content ourselves, segment by sentence, generate our
   own mark name → Range table, and drive the highlight from that
   instead of foliate-js's marks. Heavier — duplicates a lot of what
   foliate-js's TTS already does — but cleanly separates concerns.
4. **Patch `packages/foliate-js` upstream.** The submodule is
   readest-controlled (`https://github.com/readest/foliate-js`), so a
   small change to make `getCFI` work inside `<font>` could be carried
   in the fork.

## Files involved

| File                                         | Role                                                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/tts/TTSController.ts`          | Owns `#getHighlighter` (CFI roundtrip → overlay add) and `dispatchSpeakMark` (the per-mark entry point).                                                    |
| `src/utils/ssml.ts`                          | `filterSSMLWithLang` — strips source-language content and injects leading marks inside kept `<lang>` blocks so the first translated sentence is dispatched. |
| `src/utils/translationDom.ts`                | `findTranslatedRange(sourceRange)` — walks up to `.translation-source` and returns a Range over the descendant `.target-inner`.                             |
| `src/app/reader/hooks/useTextTranslation.ts` | Owns the DOM the translation observer creates.                                                                                                              |
| `packages/foliate-js/tts.js`                 | Generates marks via `textWalker`, exposes `setMark(name)` that returns a Range and calls the highlight callback.                                            |
| `packages/foliate-js/overlayer.js`           | `add(key, range, decoration, options)` — paints the SVG overlay.                                                                                            |

## Verification once a fix lands

1. Open a book, enable translation (LM Studio or Ollama), wait for the
   first chapter to translate.
2. Settings → Language → **Read Aloud Text = Translated**.
3. Press Play.
4. **Expected:** highlight tracks the spoken French sentence (or at
   least the spoken paragraph). Each chunk advances the highlight.
5. Toggle Read Aloud Text → Source. Highlight snaps back to the English
   source text on the next chunk.
6. Run `pnpm vitest run src/__tests__/utils/ssml*.test.ts
src/__tests__/utils/translationDom.test.ts
src/__tests__/services/tts-controller.test.ts` — all green.
