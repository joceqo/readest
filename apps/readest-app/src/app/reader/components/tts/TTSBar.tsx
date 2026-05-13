import clsx from 'clsx';
import {
  MdPlayArrow,
  MdOutlinePause,
  MdFastRewind,
  MdFastForward,
  MdSkipPrevious,
  MdSkipNext,
} from 'react-icons/md';
import { RiTranslateAi } from 'react-icons/ri';
import { Insets } from '@/types/misc';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { useTranslation } from '@/hooks/useTranslation';
import { saveViewSettings } from '@/helpers/settings';

type TTSReadAloudText = 'both' | 'translated' | 'source';
const TTS_READ_ALOUD_CYCLE: TTSReadAloudText[] = ['both', 'translated', 'source'];

const ttsReadAloudBadge = (value: TTSReadAloudText): string => {
  switch (value) {
    case 'translated':
      return 'TR';
    case 'source':
      return 'SRC';
    default:
      return 'BOTH';
  }
};

type TTSBarProps = {
  bookKey: string;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onBackward: (byMark: boolean) => void;
  onForward: (byMark: boolean) => void;
  gridInsets: Insets;
};

const TTSBar = ({
  bookKey,
  isPlaying,
  onTogglePlay,
  onBackward,
  onForward,
  gridInsets,
}: TTSBarProps) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { hoveredBookKey, setHoveredBookKey, getViewSettings, setViewSettings } = useReaderStore();
  const iconSize32 = useResponsiveSize(30);
  const iconSize48 = useResponsiveSize(36);

  const isVisible = hoveredBookKey !== bookKey;

  const viewSettings = getViewSettings(bookKey);
  const translationEnabled = !!viewSettings?.translationEnabled;
  const ttsReadAloudText = (viewSettings?.ttsReadAloudText ?? 'both') as TTSReadAloudText;

  const cycleTtsReadAloudText = () => {
    if (!viewSettings) return;
    const i = TTS_READ_ALOUD_CYCLE.indexOf(ttsReadAloudText);
    const next = TTS_READ_ALOUD_CYCLE[(i + 1) % TTS_READ_ALOUD_CYCLE.length]!;
    saveViewSettings(envConfig, bookKey, 'ttsReadAloudText', next, false, false);
    viewSettings.ttsReadAloudText = next;
    setViewSettings(bookKey, { ...viewSettings });
  };

  const ttsReadAloudLabel: Record<TTSReadAloudText, string> = {
    both: _('TTS reads both languages'),
    translated: _('TTS reads translated only'),
    source: _('TTS reads source only'),
  };

  return (
    <div
      className={clsx(
        'bg-base-100 absolute bottom-0 z-40',
        'inset-x-0 mx-auto flex w-full justify-center sm:w-fit',
        'transition-opacity duration-300',
        isVisible ? `pointer-events-auto opacity-100` : `pointer-events-none opacity-0`,
      )}
      style={{ paddingBottom: appService?.hasSafeAreaInset ? `${gridInsets.bottom * 0.33}px` : 0 }}
      onMouseEnter={() => !appService?.isMobile && setHoveredBookKey('')}
      onTouchStart={() => !appService?.isMobile && setHoveredBookKey('')}
    >
      <div className='text-base-content flex h-[52px] items-center space-x-2 px-2'>
        <button
          onClick={onBackward.bind(null, false)}
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={_('Previous Paragraph')}
          aria-label={_('Previous Paragraph')}
        >
          <MdFastRewind size={iconSize32} />
        </button>
        <button
          onClick={onBackward.bind(null, true)}
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={_('Previous Sentence')}
          aria-label={_('Previous Sentence')}
        >
          <MdSkipPrevious size={iconSize32} />
        </button>
        <button
          onClick={onTogglePlay}
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={isPlaying ? _('Pause') : _('Play')}
          aria-label={isPlaying ? _('Pause') : _('Play')}
        >
          {isPlaying ? <MdOutlinePause size={iconSize48} /> : <MdPlayArrow size={iconSize48} />}
        </button>
        <button
          onClick={onForward.bind(null, true)}
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={_('Next Sentence')}
          aria-label={_('Next Sentence')}
        >
          <MdSkipNext size={iconSize32} />
        </button>
        <button
          onClick={onForward.bind(null, false)}
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={_('Next Paragraph')}
          aria-label={_('Next Paragraph')}
        >
          <MdFastForward size={iconSize32} />
        </button>
        {translationEnabled && (
          <button
            onClick={cycleTtsReadAloudText}
            className='relative rounded-full p-1 transition-transform duration-200 hover:scale-105'
            title={ttsReadAloudLabel[ttsReadAloudText]}
            aria-label={ttsReadAloudLabel[ttsReadAloudText]}
          >
            <RiTranslateAi
              size={iconSize32}
              className={
                ttsReadAloudText === 'translated'
                  ? 'text-blue-500'
                  : ttsReadAloudText === 'source'
                    ? 'text-base-content/60'
                    : 'text-base-content'
              }
            />
            {/* Tiny mode badge so the current choice is readable at a glance.
                Placed bottom-right of the icon; uses bg-base-100 so the chip
                stays legible against any toolbar background. */}
            <span
              className={clsx(
                'absolute -bottom-0.5 -right-0.5',
                'rounded px-1 text-[9px] font-semibold leading-3',
                'bg-base-100 text-base-content/80',
              )}
            >
              {ttsReadAloudBadge(ttsReadAloudText)}
            </span>
          </button>
        )}
      </div>
    </div>
  );
};

export default TTSBar;
