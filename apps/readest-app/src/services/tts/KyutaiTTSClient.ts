import { TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSVoice, TTSVoicesGroup } from './types';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { useSettingsStore } from '@/store/settingsStore';
import { DEFAULT_KYUTAI_SETTINGS } from './kyutaiSettings';

const ENGINE_ID = 'kyutai-tts';
const ENGINE_NAME = 'Kyutai Pocket TTS';

type KyutaiVoice = TTSVoice & {
  voiceUrl: string;
};

const KYUTAI_VOICES: KyutaiVoice[] = [
  { id: 'kyutai-estelle-fr', name: 'Kyutai · Estelle', lang: 'fr-FR', voiceUrl: 'estelle' },
  { id: 'kyutai-alba-en', name: 'Kyutai · Alba', lang: 'en-US', voiceUrl: 'alba' },
  { id: 'kyutai-lola-es', name: 'Kyutai · Lola', lang: 'es-ES', voiceUrl: 'lola' },
  { id: 'kyutai-giovanni-it', name: 'Kyutai · Giovanni', lang: 'it-IT', voiceUrl: 'giovanni' },
  { id: 'kyutai-juergen-de', name: 'Kyutai · Juergen', lang: 'de-DE', voiceUrl: 'juergen' },
  { id: 'kyutai-rafael-pt', name: 'Kyutai · Rafael', lang: 'pt-PT', voiceUrl: 'rafael' },
];

export class KyutaiTTSClient implements TTSClient {
  name = ENGINE_ID;
  initialized = false;
  controller?: TTSController;

  #voices: KyutaiVoice[] = KYUTAI_VOICES.map((voice) => ({ ...voice }));
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = 'kyutai-estelle-fr';
  #rate = 1.0;
  #audioElement: HTMLAudioElement | null = null;
  #currentObjectUrl: string | null = null;
  #isPlaying = false;

  constructor(controller?: TTSController) {
    this.controller = controller;
  }

  async init(): Promise<boolean> {
    this.initialized = await this.#healthCheck();
    return this.initialized;
  }

  // Read the base URL fresh from the settings store on every call so that
  // edits in the Local TTS settings panel take effect on the next playback
  // without needing to restart the client. Trailing slashes are stripped
  // because `${baseUrl}/health` would otherwise produce a double slash that
  // some servers (and Tauri's HTTP plugin URL parser) reject.
  #getBaseUrl(): string {
    const stored =
      useSettingsStore.getState().settings?.kyutaiSettings?.baseUrl?.trim() || '';
    const url = stored || DEFAULT_KYUTAI_SETTINGS.baseUrl;
    return url.replace(/\/+$/, '');
  }

  async #healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 1200);
    try {
      const fetchImpl = isTauriAppPlatform() ? tauriFetch : window.fetch.bind(window);
      const response = await fetchImpl(`${this.#getBaseUrl()}/health`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  #getVoice(voiceId = this.#currentVoiceId): KyutaiVoice {
    return this.#voices.find((voice) => voice.id === voiceId) || this.#voices[0]!;
  }

  async #synthesize(text: string, voice: KyutaiVoice, signal: AbortSignal): Promise<Blob> {
    const body = new URLSearchParams();
    body.set('text', text);
    body.set('voice_url', voice.voiceUrl);

    const fetchImpl = isTauriAppPlatform() ? tauriFetch : window.fetch.bind(window);
    const response = await fetchImpl(`${this.#getBaseUrl()}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    });

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new Error(`Kyutai TTS failed (${response.status}): ${message || response.statusText}`);
    }

    return response.blob();
  }

  async *speak(
    ssml: string,
    signal: AbortSignal,
    preload = false,
  ): AsyncGenerator<TTSMessageEvent> {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);

    if (preload) {
      yield { code: 'end', message: 'Preload skipped' } as TTSMessageEvent;
      return;
    }

    if (!this.initialized) {
      this.initialized = await this.#healthCheck();
      if (!this.initialized) {
        yield {
          code: 'error',
          message: `Kyutai Pocket TTS is not running at ${this.#getBaseUrl()}`,
        } as TTSMessageEvent;
        return;
      }
    }

    await this.stopInternal();
    if (!this.#audioElement) {
      this.#audioElement = new Audio();
      this.#audioElement.setAttribute('x-webkit-airplay', 'deny');
      this.#audioElement.preload = 'auto';
    }
    const audio = this.#audioElement;

    for (const mark of marks) {
      const text = mark.text.trim();
      if (!text) continue;

      const voice = this.#getVoice();
      this.#speakingLang = mark.language || voice.lang || this.#primaryLang;
      this.controller?.dispatchSpeakMark(mark);
      yield {
        code: 'boundary',
        message: `Start chunk: ${mark.name}`,
        mark: mark.name,
      } as TTSMessageEvent;

      let abortHandler: (() => void) | null = null;
      try {
        const blob = await this.#synthesize(text, voice, signal);
        if (signal.aborted) {
          yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
          return;
        }

        if (this.#currentObjectUrl) URL.revokeObjectURL(this.#currentObjectUrl);
        this.#currentObjectUrl = URL.createObjectURL(blob);
        audio.src = this.#currentObjectUrl;
        audio.playbackRate = this.#rate;

        const result = await new Promise<TTSMessageEvent>((resolve) => {
          const cleanUp = () => {
            audio.onended = null;
            audio.onerror = null;
          };

          abortHandler = () => {
            cleanUp();
            resolve({ code: 'error', message: 'Aborted' });
          };

          if (signal.aborted) {
            abortHandler();
            return;
          }

          signal.addEventListener('abort', abortHandler);
          audio.onended = () => {
            cleanUp();
            resolve({ code: 'end', message: `Chunk finished: ${mark.name}` });
          };
          audio.onerror = () => {
            cleanUp();
            resolve({ code: 'error', message: 'Audio playback error' });
          };

          this.#isPlaying = true;
          audio.play().catch((err) => {
            cleanUp();
            resolve({
              code: 'error',
              message: `Playback failed: ${(err as Error).message}`,
            });
          });
        });

        yield result;
        if (result.code === 'error') return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { code: 'error', message } as TTSMessageEvent;
        return;
      } finally {
        if (abortHandler) signal.removeEventListener('abort', abortHandler);
      }
    }

    await this.stopInternal();
  }

  async pause(): Promise<boolean> {
    if (!this.#audioElement || !this.#isPlaying) return true;
    this.#audioElement.pause();
    this.#isPlaying = false;
    return true;
  }

  async resume(): Promise<boolean> {
    if (!this.#audioElement || this.#isPlaying) return true;
    await this.#audioElement.play();
    this.#isPlaying = true;
    return true;
  }

  async stop(): Promise<void> {
    await this.stopInternal();
  }

  async stopInternal(): Promise<void> {
    if (this.#audioElement) {
      try {
        this.#audioElement.pause();
        this.#audioElement.currentTime = 0;
        this.#audioElement.src = '';
      } catch {
        /* ignore */
      }
    }
    if (this.#currentObjectUrl) {
      URL.revokeObjectURL(this.#currentObjectUrl);
      this.#currentObjectUrl = null;
    }
    this.#isPlaying = false;
  }

  setPrimaryLang(lang: string): void {
    this.#primaryLang = lang;
  }

  async setRate(rate: number): Promise<void> {
    this.#rate = rate;
    if (this.#audioElement) this.#audioElement.playbackRate = rate;
  }

  async setPitch(_pitch: number): Promise<void> {
    // Pocket TTS does not expose pitch control through the HTTP server.
  }

  async setVoice(voice: string): Promise<void> {
    if (this.#voices.find((v) => v.id === voice)) {
      this.#currentVoiceId = voice;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return this.#voices.map((voice) => ({ ...voice, disabled: !this.initialized }));
  }

  async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    if (!this.initialized) {
      this.initialized = await this.#healthCheck();
    }

    const normalized = lang.toLowerCase();
    const matches = this.#voices.filter((voice) => {
      const voiceLang = voice.lang.toLowerCase();
      return voiceLang.startsWith(normalized) || normalized.startsWith(voiceLang.slice(0, 2));
    });

    return [
      {
        id: ENGINE_ID,
        name: ENGINE_NAME,
        voices: matches.sort(TTSUtils.sortVoicesFunc),
        disabled: !this.initialized || matches.length === 0,
      },
    ];
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId(): string {
    return this.#currentVoiceId;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    await this.stopInternal();
  }
}
