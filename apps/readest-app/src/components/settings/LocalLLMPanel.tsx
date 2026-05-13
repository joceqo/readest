import clsx from 'clsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PiArrowsClockwise, PiCheckCircle, PiWarningCircle } from 'react-icons/pi';

import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useEnv } from '@/context/EnvContext';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import type { AISettings } from '@/services/ai/types';
import { ollamaProvider } from '@/services/translators/providers/ollama';
import { BoxedList, SettingLabel, Tips } from './primitives';

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

const PRESETS = [
  { label: 'Ollama', url: 'http://127.0.0.1:11434' },
  { label: 'LM Studio', url: 'http://127.0.0.1:1234' },
];

const LocalLLMPanel: React.FC = () => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();

  const aiSettings: AISettings = settings?.aiSettings ?? DEFAULT_AI_SETTINGS;

  const [serverUrl, setServerUrl] = useState(aiSettings.ollamaBaseUrl);
  const [model, setModel] = useState(aiSettings.ollamaModel);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [translationPreview, setTranslationPreview] = useState('');

  const isMounted = useRef(false);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const saveAiSetting = useCallback(
    async (key: keyof AISettings, value: AISettings[keyof AISettings]) => {
      const currentSettings = settingsRef.current;
      if (!currentSettings) return;
      const currentAiSettings: AISettings = currentSettings.aiSettings ?? DEFAULT_AI_SETTINGS;
      const newAiSettings: AISettings = { ...currentAiSettings, [key]: value };
      const newSettings = { ...currentSettings, aiSettings: newAiSettings };
      setSettings(newSettings);
      await saveSettings(envConfig, newSettings);
    },
    [envConfig, setSettings, saveSettings],
  );

  // Try to populate the model dropdown by hitting the OpenAI-standard
  // `/v1/models` endpoint first (works for LM Studio and many other
  // OpenAI-compatible servers), then fall back to Ollama's `/api/tags`.
  // If both fail we leave the list empty and the UI swaps in a free-form
  // text input so the user can still type a model name manually.
  const fetchModels = useCallback(async () => {
    if (!serverUrl) return;
    setFetchingModels(true);
    const base = serverUrl.replace(/\/+$/, '');
    try {
      // OpenAI-compat shape: { data: [{ id: 'model-name', ... }, ...] }
      const v1 = await fetch(`${base}/v1/models`).catch(() => null);
      if (v1?.ok) {
        const data = await v1.json();
        const list: string[] = data.data?.map((m: { id: string }) => m.id).filter(Boolean) ?? [];
        if (list.length > 0) {
          setAvailableModels(list);
          if (!list.includes(model)) setModel(list[0]!);
          return;
        }
      }
      // Ollama shape: { models: [{ name: 'model-name' }, ...] }
      const tags = await fetch(`${base}/api/tags`).catch(() => null);
      if (tags?.ok) {
        const data = await tags.json();
        const list: string[] =
          data.models?.map((m: { name: string }) => m.name).filter(Boolean) ?? [];
        setAvailableModels(list);
        if (list.length > 0 && !list.includes(model)) setModel(list[0]!);
        return;
      }
      setAvailableModels([]);
    } finally {
      setFetchingModels(false);
    }
  }, [serverUrl, model]);

  useEffect(() => {
    fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  useEffect(() => {
    isMounted.current = true;
  }, []);

  useEffect(() => {
    if (!isMounted.current) return;
    if (serverUrl !== aiSettings.ollamaBaseUrl) {
      console.warn('[LocalLLM] save ollamaBaseUrl:', aiSettings.ollamaBaseUrl, '→', serverUrl);
      saveAiSetting('ollamaBaseUrl', serverUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  useEffect(() => {
    if (!isMounted.current) return;
    if (model !== aiSettings.ollamaModel) {
      console.warn('[LocalLLM] save ollamaModel:', aiSettings.ollamaModel, '→', model);
      saveAiSetting('ollamaModel', model);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // Surface unexpected drift back to the saved value (e.g. another window
  // re-saved aiSettings while this dialog was open). Logged so we can spot
  // whether the URL is being overwritten by something else mid-session.
  useEffect(() => {
    if (!isMounted.current) return;
    if (aiSettings.ollamaBaseUrl !== serverUrl) {
      console.warn(
        '[LocalLLM] external aiSettings.ollamaBaseUrl change detected:',
        serverUrl,
        '→',
        aiSettings.ollamaBaseUrl,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSettings.ollamaBaseUrl]);

  const handleTestTranslation = async () => {
    setConnectionStatus('testing');
    setErrorMessage('');
    setTranslationPreview('');
    try {
      const result = await ollamaProvider.translate(['Hello, world!'], 'en', 'fr');
      const translated = result[0]?.trim() ?? '';
      if (!translated || translated === 'Hello, world!') {
        setConnectionStatus('error');
        setErrorMessage(_('Server reachable but no translation returned'));
        return;
      }
      setConnectionStatus('success');
      setTranslationPreview(translated);
    } catch (error) {
      setConnectionStatus('error');
      setErrorMessage((error as Error).message || _("Couldn't reach the server. Is it running?"));
    }
  };

  return (
    <div className='my-4 w-full space-y-6'>
      <BoxedList
        title={_('Local LLM')}
        description={_(
          'Configure a local OpenAI-compatible server (Ollama, LM Studio, ...) for translation. To use it, pick "Local LLM" as your translator in Language settings.',
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
              <button
                className='hover:bg-base-200 inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150'
                onClick={fetchModels}
                disabled={fetchingModels}
                title={_('Refresh Models')}
                aria-label={_('Refresh Models')}
              >
                <PiArrowsClockwise className='size-4' />
              </button>
            </div>
          </div>
          <input
            type='text'
            className='input input-bordered input-sm eink-bordered w-full'
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder='http://127.0.0.1:11434'
          />
        </div>

        <div className='flex flex-col gap-2 py-3 pe-4'>
          <SettingLabel>{_('Model')}</SettingLabel>
          {availableModels.length > 0 ? (
            <select
              className='select select-bordered select-sm bg-base-100 text-base-content eink-bordered w-full'
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              type='text'
              className='input input-bordered input-sm eink-bordered w-full'
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder='llama3.2'
            />
          )}
        </div>
      </BoxedList>

      <BoxedList title={_('Connection')}>
        <div className='flex min-h-14 items-center justify-between gap-3 pe-4'>
          <button
            type='button'
            className='btn btn-outline btn-sm'
            onClick={handleTestTranslation}
            disabled={connectionStatus === 'testing'}
          >
            {_('Test Translation')}
          </button>
          <div className='flex-1 text-end'>
            {connectionStatus === 'success' && (
              <span className='text-success inline-flex items-center gap-1 text-sm'>
                <PiCheckCircle className='size-4 shrink-0' />
                {translationPreview ? `"Hello, world!" → "${translationPreview}"` : _('Connected')}
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
            'For Ollama, install a small instruction-tuned model first (e.g. `ollama pull llama3.2` or `qwen2.5:7b`).',
          )}
        </li>
        <li>
          {_(
            'Quality varies by model. Larger models translate better but run slower on your machine.',
          )}
        </li>
        <li>{_('This server is shared with the AI Assistant configuration.')}</li>
      </Tips>
    </div>
  );
};

export default LocalLLMPanel;
