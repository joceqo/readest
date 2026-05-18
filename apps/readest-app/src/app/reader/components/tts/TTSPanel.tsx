import clsx from 'clsx';
import { useState, ChangeEvent, useEffect, useLayoutEffect, useMemo } from 'react';
import {
  MdPlayCircle,
  MdPauseCircle,
  MdFastRewind,
  MdFastForward,
  MdAlarm,
  MdCheck,
} from 'react-icons/md';
import { TbChevronCompactDown, TbChevronCompactUp, TbChevronDown } from 'react-icons/tb';
import { RiVoiceAiFill } from 'react-icons/ri';
import { TTSVoicesGroup, TTSVoice } from '@/services/tts';
import ModalPortal from '@/components/ModalPortal';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { TranslationFunc, useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useDefaultIconSize, useResponsiveSize } from '@/hooks/useResponsiveSize';
import { getLanguageName } from '@/utils/lang';

type TTSPanelProps = {
  bookKey: string;
  ttsLang: string;
  isPlaying: boolean;
  timeoutOption: number;
  timeoutTimestamp: number;
  onTogglePlay: () => void;
  onBackward: () => void;
  onForward: () => void;
  onSetRate: (rate: number) => void;
  onGetVoices: (lang: string) => Promise<TTSVoicesGroup[]>;
  onSetVoice: (voice: string, lang: string) => void;
  onGetVoiceId: () => string;
  onSelectTimeout: (bookKey: string, value: number) => void;
  onToogleTTSBar: () => void;
  /** When TTS is running, reflects the controller voice id for accurate labeling */
  liveVoiceId?: string;
};

const getTTSTimeoutOptions = (_: TranslationFunc) => {
  return [
    {
      label: _('No Timeout'),
      value: 0,
    },
    {
      label: _('{{value}} minute', { value: 1 }),
      value: 60,
    },
    {
      label: _('{{value}} minutes', { value: 3 }),
      value: 180,
    },
    {
      label: _('{{value}} minutes', { value: 5 }),
      value: 300,
    },
    {
      label: _('{{value}} minutes', { value: 10 }),
      value: 600,
    },
    {
      label: _('{{value}} minutes', { value: 20 }),
      value: 1200,
    },
    {
      label: _('{{value}} minutes', { value: 30 }),
      value: 1800,
    },
    {
      label: _('{{value}} minutes', { value: 45 }),
      value: 2700,
    },
    {
      label: _('{{value}} hour', { value: 1 }),
      value: 3600,
    },
    {
      label: _('{{value}} hours', { value: 2 }),
      value: 7200,
    },
    {
      label: _('{{value}} hours', { value: 3 }),
      value: 10800,
    },
    {
      label: _('{{value}} hours', { value: 4 }),
      value: 14400,
    },
    {
      label: _('{{value}} hours', { value: 6 }),
      value: 21600,
    },
    {
      label: _('{{value}} hours', { value: 8 }),
      value: 28800,
    },
  ];
};

const getCountdownTime = (timeout: number) => {
  const now = Date.now();
  if (timeout > now) {
    const remainingTime = Math.floor((timeout - now) / 1000);
    const minutes = Math.floor(remainingTime / 3600) * 60 + Math.floor((remainingTime % 3600) / 60);
    const seconds = remainingTime % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  }
  return '';
};

/**
 * When the voice list has not loaded yet, infer a readable model + voice label from engine-specific ids.
 */
const parseRawVoiceIdForDisplay = (
  id: string,
  _t: TranslationFunc,
): { model: string; voice: string } => {
  if (!id) return { model: '', voice: '' };

  const edge = /^([a-z]{2}-[A-Z]{2})-(.+)$/i.exec(id);
  if (edge && /neural$/i.test(edge[2] ?? '')) {
    const tail = edge[2]!.replace(/neural$/i, '');
    const voice =
      tail
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .trim() || tail;
    return { model: _t('Edge TTS'), voice: `${voice} Neural`.trim() };
  }

  if (/^([A-Z]\d+)_([a-z]{2}(?:-[A-Z]{2})?)$/i.test(id)) {
    const m = /^([A-Z]\d+)_([a-z]{2}(?:-[A-Z]{2})?)$/i.exec(id)!;
    return { model: _t('Supertonic'), voice: `${m[1]} · ${m[2]}` };
  }

  if (/^[a-z]{2}_[a-z0-9_]+$/i.test(id)) {
    const underscore = id.indexOf('_');
    const voice = id.slice(underscore + 1).replace(/_/g, ' ');
    return { model: _t('Kokoro'), voice };
  }

  if (id.includes('/') || id.includes('\\')) {
    const leaf = id.split(/[/\\]/).pop() ?? id;
    return { model: _t('Web Speech'), voice: leaf };
  }

  return { model: _t('TTS'), voice: id };
};

const TTSPanel = ({
  bookKey,
  ttsLang,
  isPlaying,
  timeoutOption,
  timeoutTimestamp,
  onTogglePlay,
  onBackward,
  onForward,
  onSetRate,
  onGetVoices,
  onSetVoice,
  onGetVoiceId,
  onSelectTimeout,
  onToogleTTSBar,
  liveVoiceId,
}: TTSPanelProps) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { getViewSettings, setViewSettings } = useReaderStore();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const viewSettings = getViewSettings(bookKey);

  const [voiceGroups, setVoiceGroups] = useState<TTSVoicesGroup[]>([]);
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [expandedVoiceGroupId, setExpandedVoiceGroupId] = useState<string | null>(null);
  const [rate, setRate] = useState(viewSettings?.ttsRate ?? 1.0);
  const [selectedVoice, setSelectedVoice] = useState(viewSettings?.ttsVoice ?? '');

  const [timeoutCountdown, setTimeoutCountdown] = useState(() => {
    return getCountdownTime(timeoutTimestamp);
  });

  const defaultIconSize = useDefaultIconSize();
  const iconSize32 = useResponsiveSize(32);
  const iconSize48 = useResponsiveSize(48);
  const voiceStripIconSize = useResponsiveSize(14);
  const stickyBarToggleIconSize = useResponsiveSize(30);

  const displayVoiceId =
    (liveVoiceId && liveVoiceId.length > 0 ? liveVoiceId : null) ?? selectedVoice;

  const handleSetRate = (e: ChangeEvent<HTMLInputElement>) => {
    let newRate = parseFloat(e.target.value);
    newRate = Math.max(0.2, Math.min(3.0, newRate));
    setRate(newRate);
    onSetRate(newRate);
    const viewSettings = getViewSettings(bookKey)!;
    viewSettings.ttsRate = newRate;
    settings.globalViewSettings.ttsRate = newRate;
    setViewSettings(bookKey, viewSettings);
    setSettings(settings);
    saveSettings(envConfig, settings);
  };

  const handleSelectVoice = (voice: string, lang: string) => {
    onSetVoice(voice, lang);
    setSelectedVoice(voice);
    const viewSettings = getViewSettings(bookKey)!;
    viewSettings.ttsVoice = voice;
    setViewSettings(bookKey, viewSettings);
  };

  const updateTimeout = (timeout: number) => {
    const now = Date.now();
    if (timeout > 0 && timeout < now) {
      onSelectTimeout(bookKey, 0);
      setTimeoutCountdown('');
    } else if (timeout > 0) {
      setTimeoutCountdown(getCountdownTime(timeout));
    }
  };

  useEffect(() => {
    setTimeout(() => {
      updateTimeout(timeoutTimestamp);
    }, 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeoutTimestamp, timeoutCountdown]);

  useEffect(() => {
    const voiceId = onGetVoiceId();
    setSelectedVoice(voiceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const fetchVoices = async () => {
      const voiceGroups = await onGetVoices(ttsLang);
      const voicesCount = voiceGroups.reduce((acc, group) => acc + group.voices.length, 0);
      if (!voiceGroups || voicesCount === 0) {
        console.warn('No voices found for TTSPanel');
        setVoiceGroups([
          {
            id: 'no-voices',
            name: _('Voices for {{lang}}', { lang: getLanguageName(ttsLang) }),
            voices: [],
          },
        ]);
      } else {
        setVoiceGroups(voiceGroups);
      }
    };
    fetchVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsLang]);

  const activeVoiceMeta = useMemo((): { group: TTSVoicesGroup; voice: TTSVoice } | null => {
    for (const g of voiceGroups) {
      const voice = g.voices.find((v) => v.id === displayVoiceId);
      if (voice) return { group: g, voice };
    }
    return null;
  }, [voiceGroups, displayVoiceId]);

  const rawVoiceFallback = useMemo(() => {
    if (!displayVoiceId || activeVoiceMeta) return null;
    return parseRawVoiceIdForDisplay(displayVoiceId, _);
  }, [displayVoiceId, activeVoiceMeta, _]);

  const panelVoiceTitle = activeVoiceMeta
    ? `${_(activeVoiceMeta.voice.name)} · ${_(activeVoiceMeta.group.name)}`
    : rawVoiceFallback
      ? `${rawVoiceFallback.model} - ${rawVoiceFallback.voice}`
      : displayVoiceId || '';

  useLayoutEffect(() => {
    if (!voiceModalOpen || voiceGroups.length === 0) return;
    const containing = voiceGroups.find((g) => g.voices.some((v) => v.id === displayVoiceId));
    setExpandedVoiceGroupId(containing?.id ?? voiceGroups[0]!.id);
  }, [voiceModalOpen, voiceGroups, displayVoiceId]);

  useEffect(() => {
    if (!voiceModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setVoiceModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [voiceModalOpen]);

  const timeoutOptions = getTTSTimeoutOptions(_);

  return (
    <div className='flex w-full flex-col items-center justify-center gap-2 rounded-2xl px-4 pt-4 sm:gap-1'>
      {displayVoiceId ? (
        <div
          className='border-primary/35 bg-primary/10 text-base-content flex w-full max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5'
          title={panelVoiceTitle}
        >
          <RiVoiceAiFill size={voiceStripIconSize} className='text-primary shrink-0' aria-hidden />
          <div className='min-w-0 flex-1 text-start'>
            <p className='text-primary text-[10px] font-semibold uppercase tracking-wide'>
              {_('Active voice')}
            </p>
            {activeVoiceMeta ? (
              <>
                <p className='line-clamp-1 text-xs font-medium'>{_(activeVoiceMeta.voice.name)}</p>
                <p className='text-base-content/60 line-clamp-1 text-[10px]'>
                  {_(activeVoiceMeta.group.name)}
                </p>
              </>
            ) : rawVoiceFallback ? (
              <p className='line-clamp-2 text-xs font-medium'>
                {`${rawVoiceFallback.model} - ${rawVoiceFallback.voice}`}
              </p>
            ) : (
              <p className='line-clamp-1 font-mono text-xs'>{displayVoiceId}</p>
            )}
          </div>
        </div>
      ) : null}
      <div className='flex w-full flex-col items-center gap-0.5'>
        <input
          className='range'
          type='range'
          min={0.0}
          max={3.0}
          step='0.1'
          value={rate}
          onChange={handleSetRate}
        />
        <div className='grid w-full grid-cols-7 text-xs'>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
        </div>
        <div className='grid w-full grid-cols-7 text-xs'>
          <span className='text-center'>{_('Slow')}</span>
          <span className='text-center'></span>
          <span className='text-center'>1.0</span>
          <span className='text-center'>1.5</span>
          <span className='text-center'>2.0</span>
          <span className='text-center'></span>
          <span className='text-center'>{_('Fast')}</span>
        </div>
      </div>
      <div className='flex items-center justify-between space-x-2'>
        <button
          onClick={() => onBackward()}
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={_('Previous Paragraph')}
          aria-label={_('Previous Paragraph')}
        >
          <MdFastRewind size={iconSize32} />
        </button>
        <button
          onClick={onTogglePlay}
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={isPlaying ? _('Pause') : _('Play')}
          aria-label={isPlaying ? _('Pause') : _('Play')}
        >
          {isPlaying ? (
            <MdPauseCircle size={iconSize48} className='fill-primary' />
          ) : (
            <MdPlayCircle size={iconSize48} className='fill-primary' />
          )}
        </button>
        <button
          onClick={() => onForward()}
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={_('Next Paragraph')}
          aria-label={_('Next Paragraph')}
        >
          <MdFastForward size={iconSize32} />
        </button>
        <div className='dropdown dropdown-top'>
          <button
            tabIndex={0}
            className='flex flex-col items-center justify-center rounded-full p-1 transition-transform duration-200 hover:scale-105'
            onClick={(e) => e.currentTarget.focus()}
            title={_('Set Timeout')}
            aria-label={_('Set Timeout')}
          >
            <MdAlarm size={iconSize32} />
            {timeoutCountdown && (
              <span
                className={clsx(
                  'absolute bottom-0 left-1/2 w-12 translate-x-[-50%] translate-y-[80%] px-1',
                  'bg-primary/80 text-base-100 rounded-full text-center text-xs',
                )}
              >
                {timeoutCountdown}
              </span>
            )}
          </button>
          <ul
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            className={clsx(
              'dropdown-content bgcolor-base-200 no-triangle menu menu-vertical rounded-box absolute right-0 z-[1] shadow',
              'mt-4 inline max-h-96 w-[200px] overflow-y-scroll',
            )}
          >
            {timeoutOptions.map((option, index) => (
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
              <li
                key={`${index}-${option.value}`}
                onClick={() => onSelectTimeout(bookKey, option.value)}
              >
                <div className='flex items-center px-2'>
                  <span
                    style={{
                      width: `${defaultIconSize}px`,
                      height: `${defaultIconSize}px`,
                    }}
                  >
                    {timeoutOption === option.value && <MdCheck className='text-base-content' />}
                  </span>
                  <span className={clsx('text-base sm:text-sm')}>{option.label}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <button
          type='button'
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={_('Select Voice')}
          aria-label={_('Select Voice')}
          aria-expanded={voiceModalOpen}
          aria-haspopup='dialog'
          onClick={() => setVoiceModalOpen(true)}
        >
          <RiVoiceAiFill size={iconSize32} />
        </button>
      </div>
      <div className='relative flex min-h-9 w-full shrink-0 items-center justify-center pb-1.5 pt-0 opacity-60 transition-opacity duration-200 hover:opacity-100'>
        <button
          type='button'
          onClick={onToogleTTSBar}
          className='text-base-content/80 hover:text-base-content flex items-center justify-center rounded-lg p-1 transition-transform duration-200 hover:scale-105'
          title={_('Toggle Sticky Bottom TTS Bar')}
          aria-label={_('Toggle Sticky Bottom TTS Bar')}
        >
          {viewSettings?.showTTSBar ? (
            <TbChevronCompactUp size={stickyBarToggleIconSize} />
          ) : (
            <TbChevronCompactDown size={stickyBarToggleIconSize} />
          )}
        </button>
      </div>

      {voiceModalOpen && (
        <ModalPortal>
          <div
            role='presentation'
            className='flex h-full w-full cursor-default items-center justify-center p-4'
            onClick={() => setVoiceModalOpen(false)}
          >
            <div
              role='dialog'
              aria-modal='true'
              aria-labelledby='tts-voice-modal-title'
              className={clsx(
                'bg-base-100 modal-box shadow-2xl',
                'flex max-h-[min(84vh,640px)] w-full max-w-md flex-col overflow-hidden rounded-2xl p-0 sm:max-w-[min(92vw,440px)]',
                'eink:border-base-300 eink:border',
              )}
              onClick={(e) => e.stopPropagation()}
            >
              <div className='border-base-200 flex items-center justify-between border-b px-4 py-3'>
                <h2 id='tts-voice-modal-title' className='text-base font-semibold'>
                  {_('Select Voice')}
                </h2>
                <button
                  type='button'
                  className='btn btn-ghost btn-sm btn-circle min-h-8 w-8'
                  aria-label={_('Close')}
                  onClick={() => setVoiceModalOpen(false)}
                >
                  ×
                </button>
              </div>

              <div className='border-primary/35 bg-primary/10 shrink-0 border-b px-4 py-3'>
                <p className='text-primary mb-0.5 text-xs font-semibold uppercase tracking-wide'>
                  {_('Active voice')}
                </p>
                {activeVoiceMeta ? (
                  <>
                    <p className='text-base-content line-clamp-2 font-medium'>
                      {_(activeVoiceMeta.voice.name)}
                    </p>
                    <p className='text-base-content/60 mt-0.5 text-xs'>
                      {_(activeVoiceMeta.group.name)}
                    </p>
                  </>
                ) : rawVoiceFallback ? (
                  <p className='text-base-content/90 text-sm font-medium'>
                    {`${rawVoiceFallback.model} - ${rawVoiceFallback.voice}`}
                  </p>
                ) : displayVoiceId ? (
                  <p className='text-base-content/70 font-mono text-sm'>{displayVoiceId}</p>
                ) : (
                  <p className='text-base-content/70 text-sm'>{_('No voice selected')}</p>
                )}
              </div>

              <div className='flex flex-col gap-2 overflow-y-auto p-3'>
                {voiceGroups.map((voiceGroup) => {
                  const expanded = expandedVoiceGroupId === voiceGroup.id;
                  const isEmpty = voiceGroup.voices.length === 0;
                  return (
                    <div
                      key={voiceGroup.id}
                      className={clsx(
                        'overflow-hidden rounded-xl border',
                        voiceGroup.disabled ? 'border-base-300 opacity-60' : 'border-base-300',
                      )}
                    >
                      <button
                        type='button'
                        disabled={isEmpty && voiceGroup.id !== 'no-voices'}
                        className={clsx(
                          'bg-base-200 flex w-full items-center justify-between gap-2 px-3 py-2.5 text-start',
                          'hover:bg-base-300/80 transition-colors',
                          isEmpty &&
                            voiceGroup.id !== 'no-voices' &&
                            'cursor-not-allowed opacity-50',
                        )}
                        onClick={() =>
                          setExpandedVoiceGroupId((id) =>
                            id === voiceGroup.id ? null : voiceGroup.id,
                          )
                        }
                        aria-expanded={expanded}
                      >
                        <span className='line-clamp-2 text-sm font-medium'>
                          {_(voiceGroup.name)}
                          <span className='text-base-content/50 ms-1 font-normal'>
                            ({voiceGroup.voices.length})
                          </span>
                        </span>
                        <TbChevronDown
                          className={clsx(
                            'text-base-content/60 shrink-0 transition-transform duration-200',
                            expanded && 'rotate-180',
                          )}
                          size={20}
                          aria-hidden
                        />
                      </button>
                      {expanded && !isEmpty && (
                        <ul
                          className={clsx(
                            'divide-base-200 bg-base-100 max-h-60 divide-y overflow-y-auto sm:max-h-72',
                          )}
                        >
                          {voiceGroup.voices.map((voice, voiceIndex) => (
                            <li key={`${voiceGroup.id}-${voiceIndex}`}>
                              <button
                                type='button'
                                disabled={!!voice.disabled}
                                className={clsx(
                                  'flex w-full items-center gap-2 px-3 py-2 text-start text-sm transition-colors',
                                  selectedVoice === voice.id
                                    ? 'bg-primary/15 font-medium'
                                    : 'hover:bg-base-200',
                                  voice.disabled && 'text-base-content/40 cursor-not-allowed',
                                )}
                                onClick={() => {
                                  if (!voice.disabled) {
                                    handleSelectVoice(voice.id, voice.lang);
                                  }
                                }}
                              >
                                <span
                                  className='flex w-5 shrink-0 justify-center'
                                  style={{
                                    width: `${defaultIconSize}px`,
                                    minWidth: `${defaultIconSize}px`,
                                  }}
                                >
                                  {selectedVoice === voice.id && (
                                    <MdCheck className='text-primary' />
                                  )}
                                </span>
                                <span className='line-clamp-2'>{_(voice.name)}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {expanded && isEmpty && (
                        <p className='text-base-content/60 bg-base-100 px-3 py-2 text-xs'>
                          {_('No voices available')}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className='border-base-200 flex justify-end border-t p-3'>
                <button
                  type='button'
                  className='btn btn-primary btn-sm rounded-lg px-4'
                  onClick={() => setVoiceModalOpen(false)}
                >
                  {_('Done')}
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
};

export default TTSPanel;
