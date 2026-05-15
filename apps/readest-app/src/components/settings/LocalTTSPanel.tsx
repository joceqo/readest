import clsx from 'clsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PiCheckCircle, PiWarningCircle } from 'react-icons/pi';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useEnv } from '@/context/EnvContext';
import { isTauriAppPlatform } from '@/services/environment';
import { DEFAULT_KYUTAI_SETTINGS, KyutaiSettings } from '@/services/tts/kyutaiSettings';
import { BoxedList, SettingLabel, Tips } from './primitives';

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

const PRESETS = [{ label: 'Kyutai (default)', url: DEFAULT_KYUTAI_SETTINGS.baseUrl }];

const LocalTTSPanel: React.FC = () => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();

  const kyutaiSettings: KyutaiSettings = settings?.kyutaiSettings ?? DEFAULT_KYUTAI_SETTINGS;

  const [serverUrl, setServerUrl] = useState(kyutaiSettings.baseUrl);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const isMounted = useRef(false);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const saveKyutaiSetting = useCallback(
    async <K extends keyof KyutaiSettings>(key: K, value: KyutaiSettings[K]) => {
      const currentSettings = settingsRef.current;
      if (!currentSettings) return;
      const currentKyutaiSettings: KyutaiSettings =
        currentSettings.kyutaiSettings ?? DEFAULT_KYUTAI_SETTINGS;
      const newKyutaiSettings: KyutaiSettings = { ...currentKyutaiSettings, [key]: value };
      const newSettings = { ...currentSettings, kyutaiSettings: newKyutaiSettings };
      setSettings(newSettings);
      await saveSettings(envConfig, newSettings);
    },
    [envConfig, setSettings, saveSettings],
  );

  useEffect(() => {
    isMounted.current = true;
  }, []);

  useEffect(() => {
    if (!isMounted.current) return;
    if (serverUrl !== kyutaiSettings.baseUrl) {
      saveKyutaiSetting('baseUrl', serverUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  const handleTestConnection = async () => {
    setConnectionStatus('testing');
    setErrorMessage('');
    const base = (serverUrl || DEFAULT_KYUTAI_SETTINGS.baseUrl).replace(/\/+$/, '');
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 3000);
    try {
      const fetchImpl = isTauriAppPlatform() ? tauriFetch : window.fetch.bind(window);
      const response = await fetchImpl(`${base}/health`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (response.ok) {
        setConnectionStatus('success');
      } else {
        setConnectionStatus('error');
        setErrorMessage(_('Server responded with status {{status}}', { status: response.status }));
      }
    } catch (error) {
      setConnectionStatus('error');
      setErrorMessage((error as Error).message || _("Couldn't reach the server. Is it running?"));
    } finally {
      globalThis.clearTimeout(timeout);
    }
  };

  return (
    <div className='my-4 w-full space-y-6'>
      <BoxedList
        title={_('Kyutai Pocket TTS')}
        description={_(
          'Configure a local Kyutai Pocket TTS HTTP server for offline neural speech. To use it, pick a "Kyutai" voice in the TTS bar while reading.',
        )}
      >
        <div className='flex flex-col gap-2 py-3 pe-4'>
          <div className='flex w-full items-center justify-between'>
            <SettingLabel>{_('Server URL')}</SettingLabel>
            <div className='flex items-center gap-1'>
              {PRESETS.map((preset) => (
                <button
                  key={preset.url}
                  type='button'
                  className={clsx('btn btn-ghost btn-xs', serverUrl === preset.url && 'btn-active')}
                  onClick={() => setServerUrl(preset.url)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <input
            type='text'
            className='input input-bordered input-sm eink-bordered w-full'
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder={DEFAULT_KYUTAI_SETTINGS.baseUrl}
          />
        </div>
      </BoxedList>

      <BoxedList title={_('Connection')}>
        <div className='flex min-h-14 items-center justify-between gap-3 pe-4'>
          <button
            type='button'
            className='btn btn-outline btn-sm'
            onClick={handleTestConnection}
            disabled={connectionStatus === 'testing'}
          >
            {_('Test Connection')}
          </button>
          <div className='flex-1 text-end'>
            {connectionStatus === 'success' && (
              <span className='text-success inline-flex items-center gap-1 text-sm'>
                <PiCheckCircle className='size-4 shrink-0' />
                {_('Connected')}
              </span>
            )}
            {connectionStatus === 'error' && (
              <span className='text-error inline-flex items-center gap-1 text-sm'>
                <PiWarningCircle className='size-4 shrink-0' />
                {errorMessage || _('Failed')}
              </span>
            )}
          </div>
        </div>
      </BoxedList>

      <Tips>
        <li>
          {_(
            'Run the Kyutai Pocket TTS server locally (default port 8000) and point this URL at it.',
          )}
        </li>
        <li>
          {_('Kyutai voices stream from the server, so a fast local network or loopback is best.')}
        </li>
        <li>
          {_('You can pick a Kyutai voice per book from the TTS bar; the URL applies app-wide.')}
        </li>
      </Tips>
    </div>
  );
};

export default LocalTTSPanel;
