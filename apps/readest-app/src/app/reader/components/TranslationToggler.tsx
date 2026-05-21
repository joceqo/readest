import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FaChevronDown } from 'react-icons/fa';
import { MdCheck } from 'react-icons/md';
import { RiTranslateAi } from 'react-icons/ri';

import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { useTranslationJob } from '@/app/reader/hooks/useTranslationJob';
import { saveViewSettings } from '@/helpers/settings';
import { navigateToReader } from '@/utils/nav';
import { isTranslationAvailable } from '@/services/translators/utils';
import { TRANSLATOR_LANGS } from '@/services/constants';
import { getTranslatedBookHash, getTranslationsOf } from '@/utils/translatedBook';
import type { TranslatorName } from '@/services/translators';
import Button from '@/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const QUICK_TARGET_LANGS = ['en', 'fr'] as const;

const dropdownItemClass =
  'hover:bg-base-200 focus:bg-base-200 text-base-content flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed';

const TranslationToggler = ({ bookKey }: { bookKey: string }) => {
  const _ = useTranslation();
  const router = useRouter();
  const { envConfig, appService } = useEnv();
  const { getBookData } = useBookDataStore();
  const { library } = useLibraryStore();
  const { getViewSettings, setViewSettings, setHoveredBookKey, getView, getProgress } =
    useReaderStore();
  const iconSize10 = useResponsiveSize(10);
  const { start: startJob, running: jobRunning } = useTranslationJob({ bookKey });

  const bookData = getBookData(bookKey);
  const viewSettings = getViewSettings(bookKey)!;
  const [translationEnabled, setTranslationEnabled] = useState(viewSettings.translationEnabled!);
  const [targetLang, setTargetLang] = useState(viewSettings.translateTargetLang);
  const [translationAvailable, setTranslationAvailable] = useState(
    isTranslationAvailable(bookData?.book, viewSettings.translateTargetLang),
  );

  useEffect(() => {
    if (translationEnabled === viewSettings.translationEnabled) return;
    if (appService?.isMobile) {
      setHoveredBookKey('');
    }
    saveViewSettings(envConfig, bookKey, 'translationEnabled', translationEnabled, true, false);
    viewSettings.translationEnabled = translationEnabled;
    setViewSettings(bookKey, { ...viewSettings });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationEnabled]);

  useEffect(() => {
    setTranslationEnabled(viewSettings.translationEnabled);
    setTargetLang(viewSettings.translateTargetLang);
    setTranslationAvailable(
      isTranslationAvailable(bookData?.book, viewSettings.translateTargetLang),
    );
  }, [bookData, viewSettings.translationEnabled, viewSettings.translateTargetLang]);

  /** Bilingual-overlay language pick (unchanged behavior from v0.11.4). */
  const pickBilingualLang = (lang: string) => {
    const savedCfi = getProgress(bookKey)?.location;
    saveViewSettings(envConfig, bookKey, 'translateTargetLang', lang, false, false);
    viewSettings.translateTargetLang = lang;
    setViewSettings(bookKey, { ...viewSettings });
    setTargetLang(lang);
    if (!translationEnabled) setTranslationEnabled(true);
    if (!savedCfi) return;
    // CFI snapshot + restore covers the bilingual-mode reflow. The
    // translated-edition path doesn't need this (it navigates to a
    // different bookKey instead of mutating in place).
    const restore = () => {
      const view = getView(bookKey);
      if (!view) return;
      try {
        view.renderer.goTo?.(view.resolveNavigation(savedCfi));
      } catch (err) {
        console.warn('[TranslationToggler] CFI restore failed:', err);
      }
    };
    setTimeout(restore, 100);
    setTimeout(restore, 800);
  };

  /** Open a previously-generated translated edition by navigating the
   *  router to its reader URL. The edition's own bookHash means the
   *  reader loads it through the readerStore's translatedOf path. */
  const openTranslatedEdition = (translatedHash: string) => {
    navigateToReader(router, [translatedHash]);
  };

  /** Kick off "Create translated edition" for the configured provider +
   *  target lang. Idempotent — re-running with the same params resumes
   *  the same artifact. */
  const generateTranslatedEdition = async (lang: string) => {
    const providerName = (viewSettings.translationProvider as TranslatorName) || 'google';
    try {
      const result = await startJob({ provider: providerName, targetLang: lang });
      if (result && !result.canceled) {
        openTranslatedEdition(result.book.hash);
      }
    } catch {
      // Hint event already surfaced the error.
    }
  };

  const normalizedTarget = targetLang?.toLowerCase().split('-')[0] ?? '';
  const sourceBookHash = bookData?.book?.hash;

  // Translated editions of THIS book, if we're currently reading the source.
  // (When we're reading a translated edition the dropdown's translation-edition
  //  section makes less sense; we hide it.)
  const translatedSiblings = sourceBookHash ? getTranslationsOf(library, sourceBookHash) : [];
  const isReadingTranslatedEdition = !!bookData?.book?.translationOf;

  // Sets of (provider, lang) we already have artifacts for — used to
  // disable Generate options for tuples that already exist.
  const existingTuples = new Set(
    translatedSiblings.map((b) => `${b.translationProvider}:${b.translationLang}`),
  );
  const configuredProvider = (viewSettings.translationProvider as string) || 'google';

  return (
    <div className='flex items-center'>
      <Button
        icon={
          <RiTranslateAi className={translationEnabled ? 'text-blue-500' : 'text-base-content'} />
        }
        disabled={!translationAvailable && !translationEnabled}
        onClick={() => setTranslationEnabled(!translationEnabled)}
        label={
          translationAvailable
            ? translationEnabled
              ? _('Disable Translation')
              : _('Enable Translation')
            : _('Translation Disabled')
        }
      ></Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type='button'
            aria-label={_('Translation Language')}
            title={_('Translation Language')}
            className={clsx('btn btn-ghost h-8 min-h-8 w-4 p-0', 'touch-target')}
          >
            <FaChevronDown size={iconSize10} className='text-base-content/60' />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={window.innerWidth < 640 ? 'end' : 'center'}
          sideOffset={4}
          className='bg-base-100 text-base-content border-base-content/10 z-[100] min-w-[14rem] rounded-md border p-1 opacity-100 shadow-lg'
          style={{ backgroundColor: 'var(--fallback-b1, oklch(var(--b1)/1))' }}
        >
          <div className='text-base-content/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide'>
            {_('Bilingual overlay')}
          </div>
          {QUICK_TARGET_LANGS.map((lang) => {
            const selected = normalizedTarget === lang;
            return (
              <DropdownMenuItem
                key={lang}
                onSelect={() => pickBilingualLang(lang)}
                className={dropdownItemClass}
              >
                <span className='flex w-4 items-center justify-center'>
                  {selected && <MdCheck className='size-3.5' />}
                </span>
                <span>{TRANSLATOR_LANGS[lang] ?? lang}</span>
              </DropdownMenuItem>
            );
          })}

          {!isReadingTranslatedEdition && sourceBookHash && (
            <>
              <DropdownMenuSeparator className='bg-base-content/10 my-1 h-px' />
              <div className='text-base-content/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide'>
                {_('Translated edition')}
              </div>

              {/* Existing translated editions — click to open */}
              {translatedSiblings.map((tr) => (
                <DropdownMenuItem
                  key={tr.hash}
                  onSelect={() => openTranslatedEdition(tr.hash)}
                  className={dropdownItemClass}
                >
                  <span className='flex w-4 items-center justify-center'>
                    <MdCheck className='size-3.5 opacity-0' />
                  </span>
                  <span className='truncate'>
                    {_('Open')}: {tr.translationLang} ({tr.translationProvider})
                  </span>
                </DropdownMenuItem>
              ))}

              {/* Generate entries — disabled when the (provider, lang) tuple
                  already exists, and when a job is in flight. */}
              {QUICK_TARGET_LANGS.map((lang) => {
                const tuple = `${configuredProvider}:${lang}`;
                const alreadyExists = existingTuples.has(tuple);
                if (alreadyExists) return null;
                return (
                  <DropdownMenuItem
                    key={`gen-${lang}`}
                    disabled={jobRunning}
                    onSelect={() => void generateTranslatedEdition(lang)}
                    className={dropdownItemClass}
                  >
                    <span className='flex w-4 items-center justify-center'>
                      <MdCheck className='size-3.5 opacity-0' />
                    </span>
                    <span>
                      {jobRunning
                        ? _('Generating…')
                        : `${_('Generate')} ${TRANSLATOR_LANGS[lang] ?? lang} (${configuredProvider})…`}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </>
          )}

          {isReadingTranslatedEdition && bookData?.book?.translationOf && (
            <>
              <DropdownMenuSeparator className='bg-base-content/10 my-1 h-px' />
              <DropdownMenuItem
                onSelect={() => openTranslatedEdition(bookData!.book!.translationOf!)}
                className={dropdownItemClass}
              >
                <span className='flex w-4 items-center justify-center'>
                  <MdCheck className='size-3.5 opacity-0' />
                </span>
                <span>{_('Open source edition')}</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

// `getTranslatedBookHash` re-exported here as a convenience for any caller
// that needs the same hash without pulling in the full util module.
export { getTranslatedBookHash };

export default TranslationToggler;
