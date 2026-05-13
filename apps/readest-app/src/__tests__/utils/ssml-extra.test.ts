import { describe, it, expect } from 'vitest';
import { genSSMLRaw, findSSMLMark, filterSSMLWithLang } from '@/utils/ssml';
import { TTSMark } from '@/services/tts/types';

const ssmlWithLang = (lang: string, body: string) =>
  `<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">${body}</speak>`;

const makeMark = (offset: number, name: string, text: string, language = 'en'): TTSMark => ({
  offset,
  name,
  text,
  language,
});

describe('genSSMLRaw', () => {
  it('should wrap text in speak tags with mark name="-1"', () => {
    const result = genSSMLRaw('Hello world');
    expect(result).toContain('<speak');
    expect(result).toContain('</speak>');
    expect(result).toContain('<mark name="-1"/>');
    expect(result).toContain('Hello world');
  });

  it('should include xmlns and xml:lang attributes', () => {
    const result = genSSMLRaw('test');
    expect(result).toContain('xmlns="http://www.w3.org/2001/10/synthesis"');
    expect(result).toContain('xml:lang="en"');
  });

  it('should place mark before the text content', () => {
    const result = genSSMLRaw('Some text');
    const markIndex = result.indexOf('<mark name="-1"/>');
    const textIndex = result.indexOf('Some text');
    expect(markIndex).toBeLessThan(textIndex);
  });
});

describe('findSSMLMark', () => {
  it('should return null for empty marks array', () => {
    const result = findSSMLMark(5, []);
    expect(result).toBeNull();
  });

  it('should return the only mark when charIndex >= its offset', () => {
    const marks = [makeMark(0, '0', 'Hello')];
    const result = findSSMLMark(3, marks);
    expect(result).toEqual(marks[0]);
  });

  it('should return null when charIndex < first mark offset', () => {
    const marks = [makeMark(10, '0', 'Hello')];
    const result = findSSMLMark(5, marks);
    expect(result).toBeNull();
  });

  it('should find correct mark via binary search with multiple marks', () => {
    const marks = [
      makeMark(0, '0', 'Hello '),
      makeMark(6, '1', 'world '),
      makeMark(12, '2', 'foo '),
      makeMark(16, '3', 'bar'),
    ];

    // charIndex 7 is in the "world " segment (offset 6)
    const result = findSSMLMark(7, marks);
    expect(result).toEqual(marks[1]);

    // charIndex 12 exactly at "foo " start (offset 12)
    const result2 = findSSMLMark(12, marks);
    expect(result2).toEqual(marks[2]);

    // charIndex 0 exactly at first mark
    const result3 = findSSMLMark(0, marks);
    expect(result3).toEqual(marks[0]);
  });

  it('should return last mark when charIndex is beyond all marks', () => {
    const marks = [
      makeMark(0, '0', 'Hello '),
      makeMark(6, '1', 'world '),
      makeMark(12, '2', 'end'),
    ];
    const result = findSSMLMark(100, marks);
    expect(result).toEqual(marks[2]);
  });
});

describe('filterSSMLWithLang', () => {
  it('should keep original when target matches main language', () => {
    const ssml = ssmlWithLang('en', '<mark name="0"/>Hello world');
    const result = filterSSMLWithLang(ssml, 'en');
    expect(result).toContain('Hello world');
  });

  it('should remove non-matching lang blocks when target matches main', () => {
    const ssml = ssmlWithLang(
      'en',
      '<mark name="0"/>Hello <lang xml:lang="fr"><mark name="1"/>Bonjour</lang> world',
    );
    const result = filterSSMLWithLang(ssml, 'en');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
    expect(result).not.toContain('Bonjour');
    expect(result).not.toContain('<lang');
  });

  it('should keep matching lang blocks when target matches main language', () => {
    const ssml = ssmlWithLang(
      'en',
      '<mark name="0"/>Hello <lang xml:lang="en"><mark name="1"/>English block</lang> world',
    );
    const result = filterSSMLWithLang(ssml, 'en');
    expect(result).toContain('English block');
  });

  it('should extract matching lang blocks when target is different from main', () => {
    const ssml = ssmlWithLang(
      'en',
      '<mark name="0"/>Hello <lang xml:lang="fr"><mark name="1"/>Bonjour</lang> world',
    );
    const result = filterSSMLWithLang(ssml, 'fr');
    expect(result).toContain('Bonjour');
    expect(result).toContain('<speak');
    expect(result).toContain('</speak>');
    // Should not contain the English text outside lang blocks
    expect(result).not.toContain('Hello');
    expect(result).not.toContain('world');
  });

  it('should return original when no matching blocks found', () => {
    const ssml = ssmlWithLang(
      'en',
      '<mark name="0"/>Hello <lang xml:lang="fr"><mark name="1"/>Bonjour</lang>',
    );
    const result = filterSSMLWithLang(ssml, 'de');
    // "de" doesn't match main lang "en" and no <lang xml:lang="de"> blocks exist
    expect(result).toBe(ssml);
  });

  it('should handle multiple lang blocks and extract all matching ones', () => {
    const ssml = ssmlWithLang(
      'en',
      '<mark name="0"/>Hello <lang xml:lang="fr"><mark name="1"/>Bonjour</lang> and <lang xml:lang="fr"><mark name="2"/>Au revoir</lang>',
    );
    const result = filterSSMLWithLang(ssml, 'fr');
    expect(result).toContain('Bonjour');
    expect(result).toContain('Au revoir');
  });

  // Regression: Readest's translation observer emits marks OUTSIDE the
  // `<lang>` block. Earlier behaviour rebuilt the filtered SSML from only
  // matching lang blocks, dropping every such mark — parseSSMLMarks then
  // saw 0 marks and the TTS controller skipped the chunk entirely.
  it('preserves marks that live outside the target lang block', () => {
    const ssml = ssmlWithLang(
      'en',
      '<mark name="0"/>Acknowledgments<lang xml:lang="fr">Remerciements</lang>',
    );
    const result = filterSSMLWithLang(ssml, 'fr');
    expect(result).toContain('<mark name="0"');
    expect(result).toContain('Remerciements');
    expect(result).not.toContain('Acknowledgments');
  });

  // Regression: when source-language `<lang>` blocks contain all the marks
  // and the matching target block has none, the filter must inject a
  // synthetic mark so TTSController doesn't fast-forward past the chunk.
  it('injects a synthetic mark when matching block has none', () => {
    const ssml = ssmlWithLang(
      'en',
      '<lang xml:lang="en"><mark name="0"/>Acknowledgments</lang><lang xml:lang="fr">Remerciements</lang>',
    );
    const result = filterSSMLWithLang(ssml, 'fr');
    expect(result).toContain('Remerciements');
    expect(result).not.toContain('Acknowledgments');
    // Must have at least one <mark> so parseSSMLMarks returns a non-empty
    // array and the chunk is actually spoken.
    expect(result).toMatch(/<mark\s+name="[^"]*"/);
  });

  // Regression: the synthetic mark must reuse the source-side mark name
  // (when available) so that foliate-js's setMark resolves it to a real
  // Range — that's what makes the highlight pipeline run on the
  // translated paragraph. Falling back to "-1" silently disables the
  // highlight (TTSController gates on `mark.name !== '-1'`).
  it('recycles the source-side mark name instead of "-1" when injecting', () => {
    const ssml = ssmlWithLang(
      'en',
      '<lang xml:lang="en"><mark name="42"/>Acknowledgments</lang><lang xml:lang="fr">Remerciements</lang>',
    );
    const result = filterSSMLWithLang(ssml, 'fr');
    expect(result).toContain('<mark name="42"');
    expect(result).not.toContain('<mark name="-1"');
  });

  // Regression: when a <lang> block starts with text (no leading inner
  // <mark>), parseSSMLMarks would silently drop that first text segment
  // — the user's symptom was "first French sentence is never read /
  // highlighted". The filter must inject a leading <mark> inside each
  // kept lang block so the first text gets attributed.
  it('injects a leading mark inside a kept lang block that starts with text', () => {
    const ssml = ssmlWithLang(
      'en',
      '<mark name="0"/><mark name="1"/><mark name="2"/><lang xml:lang="fr">First French sentence.<mark name="3"/>Second French sentence.</lang>',
    );
    const result = filterSSMLWithLang(ssml, 'fr');
    // The lang block must now start with a <mark> so parseSSMLMarks
    // picks up "First French sentence.".
    expect(result).toMatch(/<lang\s+xml:lang="fr">\s*<mark\s+name="[^"]+"\s*\/>/);
    // The original inner mark "3" should still be in place for the
    // second sentence.
    expect(result).toContain('<mark name="3"');
  });

  // Companion to the above: when the lang block already has an inner
  // leading mark, we should NOT inject another one (that would attach
  // the first sentence to a wrong mark name).
  it('does not double-up the mark when the lang block already has a leading mark', () => {
    const ssml = ssmlWithLang(
      'en',
      '<mark name="0"/><lang xml:lang="fr"><mark name="1"/>French text.</lang>',
    );
    const result = filterSSMLWithLang(ssml, 'fr');
    // Exactly one <mark> inside the lang block.
    const inside = result.match(/<lang\s+xml:lang="fr"[^>]*>([\s\S]*?)<\/lang>/);
    expect(inside).not.toBeNull();
    const innerMarks = (inside![1]!.match(/<mark\s/g) || []).length;
    expect(innerMarks).toBe(1);
  });
});
