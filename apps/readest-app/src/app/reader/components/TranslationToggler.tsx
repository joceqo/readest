import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { FaChevronDown } from 'react-icons/fa';
import { MdCheck } from 'react-icons/md';
import { RiTranslateAi } from 'react-icons/ri';

import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useBookDataStore } from '@/store/bookDataStore';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { saveViewSettings } from '@/helpers/settings';
import { isTranslationAvailable } from '@/services/translators/utils';
import { TRANSLATOR_LANGS } from '@/services/constants';
import Button from '@/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const QUICK_TARGET_LANGS = ['en', 'fr'] as const;

const TranslationToggler = ({ bookKey }: { bookKey: string }) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { getBookData } = useBookDataStore();
  const { getViewSettings, setViewSettings, setHoveredBookKey, getView, getProgress } =
    useReaderStore();
  const iconSize10 = useResponsiveSize(10);

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

  const pickTargetLang = (lang: string) => {
    // Capture the user's current reading position before mutating the
    // translation settings. Changing target lang triggers
    // updateTranslation() in useTextTranslation, which removes every
    // .translation-target sibling from the DOM. The chapter collapses to
    // ~half its height, the current page index now maps to an empty
    // offset, and the reader lands on a blank page. We restore the
    // position via the saved CFI after the pipeline has reflowed.
    const savedCfi = getProgress(bookKey)?.location;

    saveViewSettings(envConfig, bookKey, 'translateTargetLang', lang, false, false);
    viewSettings.translateTargetLang = lang;
    setViewSettings(bookKey, { ...viewSettings });
    setTargetLang(lang);
    // Picking a language implies the user wants translation on.
    if (!translationEnabled) {
      setTranslationEnabled(true);
    }

    if (!savedCfi) return;
    // The translation observer removes siblings synchronously and schedules
    // re-translation asynchronously. Give the reflow + first translations a
    // moment, then navigate the renderer back to the CFI we captured.
    const restore = () => {
      const view = getView(bookKey);
      if (!view) return;
      try {
        const resolved = view.resolveNavigation(savedCfi);
        view.renderer.goTo?.(resolved);
      } catch (err) {
        console.warn('[TranslationToggler] failed to restore CFI after language change:', err);
      }
    };
    // First restore right after the layout has settled from the remove pass,
    // then a second one once the new translations have started landing,
    // because each pass changes the page height again.
    setTimeout(restore, 100);
    setTimeout(restore, 800);
  };

  const normalizedTarget = targetLang?.toLowerCase().split('-')[0] ?? '';

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
        {/* The shared DropdownMenuContent default styling relies on Tailwind
            tokens (bg-popover, text-popover-foreground) and tailwindcss-animate
            utilities that aren't configured in this project's tailwind.config,
            so the menu renders transparent / unanimated. Override every visible
            property explicitly with daisyUI tokens that ARE defined. */}
        <DropdownMenuContent
          align={window.innerWidth < 640 ? 'end' : 'center'}
          sideOffset={4}
          className='bg-base-100 text-base-content border-base-content/10 z-[100] min-w-[10rem] rounded-md border p-1 opacity-100 shadow-lg'
          style={{ backgroundColor: 'var(--fallback-b1, oklch(var(--b1)/1))' }}
        >
          {QUICK_TARGET_LANGS.map((lang) => {
            const selected = normalizedTarget === lang;
            return (
              <DropdownMenuItem
                key={lang}
                onSelect={() => pickTargetLang(lang)}
                className='hover:bg-base-200 focus:bg-base-200 text-base-content flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none'
              >
                <span className='flex w-4 items-center justify-center'>
                  {selected && <MdCheck className='size-3.5' />}
                </span>
                <span>{TRANSLATOR_LANGS[lang] ?? lang}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export default TranslationToggler;
