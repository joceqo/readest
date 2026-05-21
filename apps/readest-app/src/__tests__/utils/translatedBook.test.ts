import { describe, expect, it } from 'vitest';

import type { Book } from '@/types/book';
import {
  buildTranslatedBookEntry,
  getTranslatedBookHash,
  getTranslationSource,
  getTranslationsOf,
  isTranslatedEdition,
} from '@/utils/translatedBook';

const makeBook = (overrides: Partial<Book> = {}): Book => ({
  hash: 'abc1234',
  metaHash: 'meta01',
  format: 'EPUB',
  title: 'Linux in Action',
  author: 'David Clinton',
  createdAt: 1716000000_000,
  updatedAt: 1716000000_000,
  ...overrides,
});

describe('getTranslatedBookHash', () => {
  it('is deterministic across calls with the same inputs', () => {
    const h1 = getTranslatedBookHash('abc1234', 'deepl', 'fr');
    const h2 = getTranslatedBookHash('abc1234', 'deepl', 'fr');
    expect(h1).toBe(h2);
  });

  it('differs from the source hash', () => {
    const sourceHash = 'abc1234';
    expect(getTranslatedBookHash(sourceHash, 'deepl', 'fr')).not.toBe(sourceHash);
  });

  it('differs across provider, lang, and source', () => {
    const a = getTranslatedBookHash('abc1234', 'deepl', 'fr');
    const b = getTranslatedBookHash('abc1234', 'google', 'fr');
    const c = getTranslatedBookHash('abc1234', 'deepl', 'es');
    const d = getTranslatedBookHash('def5678', 'deepl', 'fr');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe('isTranslatedEdition', () => {
  it('returns true when all three translation fields are set', () => {
    const book = makeBook({
      translationOf: 'abc1234',
      translationLang: 'fr',
      translationProvider: 'deepl',
    });
    expect(isTranslatedEdition(book)).toBe(true);
  });

  it('returns false when any field is missing', () => {
    expect(isTranslatedEdition(makeBook())).toBe(false);
    expect(isTranslatedEdition(makeBook({ translationOf: 'abc1234', translationLang: 'fr' }))).toBe(
      false,
    );
    expect(
      isTranslatedEdition(makeBook({ translationOf: 'abc1234', translationProvider: 'deepl' })),
    ).toBe(false);
    expect(
      isTranslatedEdition(makeBook({ translationLang: 'fr', translationProvider: 'deepl' })),
    ).toBe(false);
  });
});

describe('buildTranslatedBookEntry', () => {
  it('produces a Book with translation fields set + deterministic hash', () => {
    const source = makeBook();
    const entry = buildTranslatedBookEntry(source, 'deepl', 'fr');

    expect(entry.hash).toBe(getTranslatedBookHash(source.hash, 'deepl', 'fr'));
    expect(entry.hash).not.toBe(source.hash);
    expect(entry.translationOf).toBe(source.hash);
    expect(entry.translationProvider).toBe('deepl');
    expect(entry.translationLang).toBe('fr');
    expect(entry.primaryLanguage).toBe('fr');
    expect(isTranslatedEdition(entry)).toBe(true);
  });

  it('shares metaHash, format, author, cover, and metadata with the source', () => {
    const source = makeBook({
      coverImageUrl: 'https://example/cover.png',
      metadata: { title: 'Linux in Action', author: 'David Clinton', language: 'en' },
    });
    const entry = buildTranslatedBookEntry(source, 'ollama', 'fr');

    expect(entry.metaHash).toBe(source.metaHash);
    expect(entry.format).toBe(source.format);
    expect(entry.author).toBe(source.author);
    expect(entry.coverImageUrl).toBe(source.coverImageUrl);
    expect(entry.metadata).toEqual(source.metadata);
  });

  it('does not copy url or filePath (translated editions reuse source storage)', () => {
    const source = makeBook({
      url: 'https://example/book.epub',
      filePath: '/local/book.epub',
    });
    const entry = buildTranslatedBookEntry(source, 'deepl', 'fr');

    expect(entry.url).toBeUndefined();
    expect(entry.filePath).toBeUndefined();
  });

  it('suffixes the title with the language tag for unambiguous grid display', () => {
    const source = makeBook({ title: 'Linux in Action' });
    const entry = buildTranslatedBookEntry(source, 'deepl', 'fr');
    expect(entry.title).toBe('Linux in Action — fr');
  });
});

describe('getTranslationsOf', () => {
  it('returns only translations of the given source, excluding deleted', () => {
    const source = makeBook({ hash: 'abc1234' });
    const otherSource = makeBook({ hash: 'def5678' });
    const t1 = buildTranslatedBookEntry(source, 'deepl', 'fr');
    const t2 = buildTranslatedBookEntry(source, 'google', 'fr');
    const t3 = buildTranslatedBookEntry(source, 'deepl', 'es');
    const t4 = buildTranslatedBookEntry(otherSource, 'deepl', 'fr');
    const t5: Book = { ...buildTranslatedBookEntry(source, 'deepl', 'de'), deletedAt: 1 };

    const library = [source, otherSource, t1, t2, t3, t4, t5];
    const result = getTranslationsOf(library, source.hash);

    expect(result).toEqual([t1, t2, t3]);
    expect(result).not.toContain(t4);
    expect(result).not.toContain(t5);
  });

  it('returns empty array when no translations exist', () => {
    const source = makeBook();
    expect(getTranslationsOf([source], source.hash)).toEqual([]);
  });
});

describe('getTranslationSource', () => {
  it('returns the source Book when present and not deleted', () => {
    const source = makeBook();
    const translation = buildTranslatedBookEntry(source, 'deepl', 'fr');
    expect(getTranslationSource([source, translation], translation)).toBe(source);
  });

  it('returns undefined for an orphan translation (source missing)', () => {
    const orphan = buildTranslatedBookEntry(makeBook({ hash: 'gone' }), 'deepl', 'fr');
    expect(getTranslationSource([], orphan)).toBeUndefined();
  });

  it('returns undefined when source exists but is deleted', () => {
    const source: Book = { ...makeBook(), deletedAt: 1 };
    const translation = buildTranslatedBookEntry(source, 'deepl', 'fr');
    expect(getTranslationSource([source, translation], translation)).toBeUndefined();
  });

  it('returns undefined for a non-translation Book', () => {
    const book = makeBook();
    expect(getTranslationSource([book], book)).toBeUndefined();
  });
});
