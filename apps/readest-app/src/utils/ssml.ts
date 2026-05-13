import { TTSMark } from '@/services/tts/types';
import { code6392to6391, inferLangFromScript, isSameLang, isValidLang } from './lang';

const cleanTextContent = (text: string) =>
  text.replace(/\r\n/g, '  ').replace(/\r/g, ' ').replace(/\n/g, ' ').trimStart();

export const genSSML = (lang: string, text: string, voice: string, rate: number) => {
  const cleanedText = text.replace(/^<break\b[^>]*>/i, '');
  return `
    <speak version="1.0" xml:lang="${lang}">
      <voice name="${voice}">
        <prosody rate="${rate}" >
            ${cleanedText}
        </prosody>
      </voice>
    </speak>
  `;
};

export const genSSMLRaw = (text: string) => {
  return `
    <speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="-1"/>${text}</speak>
  `;
};

export const parseSSMLLang = (ssml: string, primaryLang?: string): string => {
  let lang = 'en';
  const match = ssml.match(/xml:lang\s*=\s*"([^"]+)"/);
  if (match && match[1]) {
    const parts = match[1].split('-');
    lang =
      parts.length > 1
        ? `${parts[0]!.toLowerCase()}-${parts[1]!.toUpperCase()}`
        : parts[0]!.toLowerCase();

    lang = code6392to6391(lang) || lang;
    if (!isValidLang(lang)) {
      lang = 'en';
    }
  }
  primaryLang = code6392to6391(primaryLang?.toLowerCase() || '') || primaryLang;
  if (lang === 'en' && primaryLang && !isSameLang(lang, primaryLang)) {
    lang = primaryLang.split('-')[0]!.toLowerCase();
  }
  const textWithoutLangTags = ssml.replace(/<lang[^>]*>.*?<\/lang>/gs, '');
  return inferLangFromScript(textWithoutLangTags, lang);
};

const isValidMark = (mark: string) => {
  const trimmed = mark.trim();
  if (!trimmed || trimmed.length === 0) {
    return false;
  }
  if (/^[\p{P}\p{S}]+$/u.test(trimmed)) {
    return false;
  }
  return true;
};

export const parseSSMLMarks = (ssml: string, primaryLang?: string) => {
  const defaultLang = parseSSMLLang(ssml, primaryLang) || 'en';
  ssml = ssml.replace(/<speak[^>]*>/i, '').replace(/<\/speak>/i, '');

  let plainText = '';
  const marks: TTSMark[] = [];

  let activeMark: string | null = null;
  let currentLang = defaultLang;
  const langStack: string[] = [];

  const tagRegex = /<(\/?)(\w+)([^>]*)>|([^<]+)/g;

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(ssml)) !== null) {
    if (match[4]) {
      const rawText = match[4];
      const text = cleanTextContent(rawText);
      if (text && activeMark && isValidMark(text)) {
        const offset = plainText.length;
        plainText += text;
        marks.push({
          offset,
          name: activeMark,
          text,
          language: inferLangFromScript(text, currentLang) || currentLang,
        });
      } else {
        plainText += cleanTextContent(rawText);
      }
    } else {
      const isEnd = match[1] === '/';
      const tagName = match[2];
      const attr = match[3];

      if (tagName === 'mark' && !isEnd) {
        const nameMatch = attr?.match(/name="([^"]+)"/);
        if (nameMatch) {
          activeMark = nameMatch[1]!;
        }
      } else if (tagName === 'lang') {
        if (!isEnd) {
          langStack.push(currentLang);
          const langMatch = attr?.match(/xml:lang="([^"]+)"/);
          if (langMatch) {
            currentLang = langMatch[1]!;
          }
        } else {
          currentLang = langStack.pop() ?? defaultLang;
        }
      }
    }
  }

  return { plainText, marks };
};

export const findSSMLMark = (charIndex: number, marks: TTSMark[]) => {
  let left = 0;
  let right = marks.length - 1;
  let result: TTSMark | null = null;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const mark = marks[mid]!;

    if (mark.offset <= charIndex) {
      result = mark;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return result;
};

export const filterSSMLWithLang = (
  ssml: string,
  targetLang: string,
  primaryLang?: string,
): string => {
  const mainLang = parseSSMLLang(ssml, primaryLang);

  // Normalize target language
  const normalizedTarget = code6392to6391(targetLang.toLowerCase()) || targetLang.toLowerCase();

  // Check if target matches main language
  if (isSameLang(normalizedTarget, mainLang)) {
    // Remove all <lang> blocks that don't match the main language
    return ssml.replace(/<lang\s+xml:lang="([^"]+)"[^>]*>.*?<\/lang>/gs, (match, langAttr) => {
      const blockLang = code6392to6391(langAttr.toLowerCase()) || langAttr.toLowerCase();
      // If the lang block matches the main language, keep it as is
      if (isSameLang(blockLang, mainLang)) {
        return match;
      }
      // Otherwise remove the entire block
      return '';
    });
  }

  // Check if target matches any <lang> block
  const langBlocks: Array<{ match: string; lang: string; content: string }> = [];
  const langBlockRegex = /<lang\s+xml:lang="([^"]+)"[^>]*>(.*?)<\/lang>/gs;
  let match: RegExpExecArray | null;

  const tempRegex = new RegExp(langBlockRegex.source, langBlockRegex.flags);
  while ((match = tempRegex.exec(ssml)) !== null) {
    const blockLang = code6392to6391(match[1]!.toLowerCase()) || match[1]!.toLowerCase();
    if (isSameLang(blockLang, normalizedTarget)) {
      langBlocks.push({
        match: match[0]!,
        lang: match[1]!,
        content: match[2]!,
      });
    }
  }

  if (langBlocks.length > 0) {
    const speakOpenMatch = ssml.match(/<speak[^>]*>/i);
    const speakCloseMatch = ssml.match(/<\/speak>/i);

    if (!speakOpenMatch || !speakCloseMatch) {
      return ssml;
    }

    // Walk the SSML linearly so that `<mark>` tags that live OUTSIDE the
    // `<lang>` blocks survive — Readest's generator emits structure like
    // `<mark name="0"/>Source text<lang xml:lang="fr">Translation</lang>`,
    // where the mark tags the start of the segment for both source and
    // translation. Rebuilding from just the matching lang blocks (the
    // previous behaviour) dropped every such mark, so parseSSMLMarks
    // returned 0 entries and TTSController fast-forwarded past the chunk.
    //
    // Rule:
    //   - keep every `<mark .../>` (positions stay stable across langs)
    //   - keep matching `<lang xml:lang="target">…</lang>` blocks intact
    //   - drop non-matching lang blocks and their inner content
    //   - drop loose text outside any lang block (that's the untranslated
    //     source text we don't want the TTS to read)
    const tokenRegex = /<mark\s[^>]*\/>|<lang\s+xml:lang="([^"]+)"[^>]*>(?:.|\n)*?<\/lang>/g;
    const innerMarkRegex = /<mark\s+name="([^"]+)"\s*\/>/;
    // Match the opening `<lang …>` tag in a kept block, optionally followed
    // by whitespace, optionally followed by a `<mark .../>`. Used to detect
    // matching-lang blocks whose content STARTS with raw text rather than
    // a mark — those would lose their first sentence in parseSSMLMarks
    // because no activeMark is set when the text is encountered.
    const langOpenWithMarkRegex = /^(<lang\s+xml:lang="[^"]+"[^>]*>)\s*<mark\s/;
    const kept: string[] = [];
    let keptHasLang = false;
    // Track the most recent source-side mark name as we walk the SSML.
    // When we then keep a matching `<lang>` block whose first content is
    // raw text (no inner `<mark>`), we promote this name into the block
    // so that the first translated sentence isn't silently dropped by
    // parseSSMLMarks. The same name is also used as the top-level
    // synthetic when no matching-block mark was already present.
    let lastSourceMarkName: string | null = null;
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = tokenRegex.exec(ssml)) !== null) {
      const token = tokenMatch[0]!;
      if (token.startsWith('<mark')) {
        kept.push(token);
        const m = token.match(innerMarkRegex);
        if (m && m[1] && m[1] !== '-1') lastSourceMarkName = m[1];
        continue;
      }
      const blockLang =
        code6392to6391(tokenMatch[1]!.toLowerCase()) || tokenMatch[1]!.toLowerCase();
      if (isSameLang(blockLang, normalizedTarget)) {
        // If the matching block doesn't open with a `<mark>`, parseSSMLMarks
        // will encounter the first sentence's text before any activeMark
        // is set inside the block and silently drop it. Inject one here
        // using the most recent source-side mark name so the text is
        // attached to a valid mark name in foliate-js's #ranges.
        let toPush = token;
        if (!langOpenWithMarkRegex.test(token) && lastSourceMarkName) {
          toPush = token.replace(
            /^(<lang\s+xml:lang="[^"]+"[^>]*>)/,
            `$1<mark name="${lastSourceMarkName}"/>`,
          );
        }
        kept.push(toPush);
        keptHasLang = true;
      } else if (!lastSourceMarkName) {
        // Capture from inside the non-matching block too, so paragraphs
        // whose only marks live inside the source-language `<lang>` still
        // get a usable name.
        const inner = token.match(innerMarkRegex);
        if (inner && inner[1] && inner[1] !== '-1') {
          lastSourceMarkName = inner[1];
        }
      } else {
        // Non-matching block: update lastSourceMarkName from its LAST
        // inner mark so the next matching block (if any) inherits a name
        // closer to its position in document order.
        const allInner = [...token.matchAll(/<mark\s+name="([^"]+)"\s*\/>/g)];
        const lastInner = allInner[allInner.length - 1];
        if (lastInner && lastInner[1] && lastInner[1] !== '-1') {
          lastSourceMarkName = lastInner[1];
        }
      }
    }
    const firstDroppedMarkName = lastSourceMarkName;

    // Ensure every kept `<lang>` block has a `<mark>` BEFORE its first
    // text content. Without that, parseSSMLMarks walks past the opening
    // tag, encounters text with no active mark, and silently drops it —
    // which is why the first sentence of a translated paragraph used to
    // be skipped entirely (no mark → no dispatch → no audio, no
    // highlight). We rewrite each kept lang block so a synthetic mark is
    // injected right after the opening tag if the next thing inside is
    // text. The recycled source-side mark name (when available) ties the
    // synthetic mark back to a real foliate-js Range so the highlight
    // remap still works; otherwise we fall back to "-1" — the audio
    // still plays, just without a per-sentence highlight on that first
    // segment.
    const langOpenRegex = /^(<lang\s+xml:lang="[^"]+"[^>]*>)([\s\S]*)<\/lang>$/;
    const syntheticName = firstDroppedMarkName ?? '-1';
    const rewritten = kept.map((token) => {
      if (!token.startsWith('<lang')) return token;
      const match = token.match(langOpenRegex);
      if (!match) return token;
      const [, open, body] = match;
      // If the body already starts with a <mark>, no injection needed —
      // parseSSMLMarks will pick it up.
      if (/^\s*<mark\s/.test(body!)) return token;
      return `${open}<mark name="${syntheticName}"/>${body}</lang>`;
    });

    // If despite the per-lang-block injection above we still don't have
    // any mark at all (e.g. an edge case where the lang regex didn't
    // match), fall back to the old top-level synthetic mark so the chunk
    // isn't skipped entirely. The `<mark>` literal anywhere inside the
    // kept tokens — including nested inside lang blocks — counts.
    const keptHasMark = rewritten.some((t) => /<mark\s/.test(t));
    if (keptHasLang && !keptHasMark) {
      rewritten.unshift(`<mark name="${syntheticName}"/>`);
    }

    return `${speakOpenMatch[0]}${rewritten.join('')}${speakCloseMatch[0]}`;
  }

  return ssml;
};
