import { TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { installModelFetchInterceptor } from './modelCache';

// Match the kokoro-js voice map shape without importing the package at load
// time (it pulls in @huggingface/transformers + ONNX runtime, which we want
// to defer until the user actually picks a Kokoro voice).
interface KokoroVoiceMeta {
  name: string;
  language: 'en-us' | 'en-gb';
  gender: 'Male' | 'Female';
}

interface KokoroAudio {
  audio: Float32Array;
  sampling_rate: number;
  toBlob(): Blob;
}

interface KokoroTTSInstance {
  voices: Readonly<Record<string, KokoroVoiceMeta>>;
  generate(text: string, options: { voice: string; speed?: number }): Promise<KokoroAudio>;
}

// Hugging Face repo for the 82M ONNX export. q8 is ~80MB and runs well on
// an M-series Mac in WASM; we let the user upgrade dtype/device via env if
// they want, but the defaults below ship a good first-load experience.
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_DTYPE = 'q8' as const;

const ENGINE_ID = 'kokoro-tts';
const ENGINE_NAME = 'Kokoro (Local Neural)';

// Stable cache key for $APPDATA/Readest/models/<engine>/. kokoro-js asks
// transformers.js to fetch from `huggingface.co/<KOKORO_MODEL_ID>/resolve/...`
// — we intercept those requests once and route through the disk cache so
// the model survives an IndexedDB wipe (the user's "offline → lost voice"
// symptom). The interceptor is installed lazily on the first speak() so
// it's never set up for users who never pick a Kokoro voice.
const KOKORO_CACHE_KEY = 'kokoro-82m-v1';
const KOKORO_URL_PREFIX = `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/`;
let fetchInterceptorInstalled = false;

/**
 * Kokoro 82M TTS running entirely in the browser via kokoro-js (Transformers.js
 * + ONNX Web). The model is downloaded from Hugging Face on first use and
 * cached in IndexedDB by the underlying Transformers cache.
 *
 * Word-boundary highlight strategy follows the lector "Option B" pattern:
 * generate audio for the whole SSML chunk, then schedule per-mark callbacks
 * uniformly across the audio duration. The model itself doesn't expose
 * per-word timestamps, so this is the cheapest approximation that still
 * looks correct visually.
 */
export class KokoroTTSClient implements TTSClient {
  name = ENGINE_ID;
  initialized = false;
  controller?: TTSController;

  #tts: KokoroTTSInstance | null = null;
  #loadPromise: Promise<KokoroTTSInstance> | null = null;
  #voices: TTSVoice[] = [];
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = 'af_heart';
  #rate = 1.0;

  #audioElement: HTMLAudioElement | null = null;
  #currentObjectUrl: string | null = null;
  #isPlaying = false;

  constructor(controller?: TTSController) {
    this.controller = controller;
  }

  async init(): Promise<boolean> {
    // Surface the voice list immediately so the picker can render Kokoro
    // entries before the model has been downloaded. Actual model loading
    // is deferred to the first speak() call so users who never pick a
    // Kokoro voice pay zero cost.
    this.#voices = this.#buildVoiceListSync();
    this.initialized = typeof window !== 'undefined';
    return this.initialized;
  }

  /**
   * Hard-coded voice catalogue. We could load this from the kokoro-js
   * `VOICES` export, but doing so triggers the whole transformers import
   * chain at module load. The kokoro-js voice map is small and stable, so
   * mirroring it here keeps init cheap and SSR-safe.
   */
  #buildVoiceListSync(): TTSVoice[] {
    const langFor = (id: string): string => (id.startsWith('b') ? 'en-GB' : 'en-US');
    const names: Array<[string, string]> = [
      ['af_heart', 'Heart 🎀'],
      ['af_alloy', 'Alloy'],
      ['af_aoede', 'Aoede'],
      ['af_bella', 'Bella'],
      ['af_jessica', 'Jessica'],
      ['af_kore', 'Kore'],
      ['af_nicole', 'Nicole'],
      ['af_nova', 'Nova'],
      ['af_river', 'River'],
      ['af_sarah', 'Sarah'],
      ['af_sky', 'Sky'],
      ['am_adam', 'Adam'],
      ['am_echo', 'Echo'],
      ['am_eric', 'Eric'],
      ['am_fenrir', 'Fenrir'],
      ['am_liam', 'Liam'],
      ['am_michael', 'Michael'],
      ['am_onyx', 'Onyx'],
      ['am_puck', 'Puck'],
      ['am_santa', 'Santa'],
      ['bf_emma', 'Emma'],
      ['bf_isabella', 'Isabella'],
      ['bf_alice', 'Alice'],
      ['bf_lily', 'Lily'],
      ['bm_george', 'George'],
      ['bm_lewis', 'Lewis'],
      ['bm_daniel', 'Daniel'],
      ['bm_fable', 'Fable'],
    ];
    return names.map(([id, name]) => ({
      id,
      name: `Kokoro · ${name}`,
      lang: langFor(id),
    }));
  }

  async #ensureModel(): Promise<KokoroTTSInstance> {
    if (this.#tts) return this.#tts;
    if (!this.#loadPromise) {
      // Dynamic import so kokoro-js + transformers + ONNX runtime stay out
      // of the SSR bundle and only load when someone actually picks Kokoro.
      this.#loadPromise = (async () => {
        if (!fetchInterceptorInstalled) {
          // Strip the `<revision>/` segment when computing the on-disk
          // filename — transformers.js may resolve a specific commit SHA
          // depending on cache state, but the underlying file (config.json,
          // *.onnx, voices.bin, …) is identical and shouldn't be re-cached
          // per revision. Filename is everything after `resolve/<rev>/`.
          installModelFetchInterceptor({
            engine: KOKORO_CACHE_KEY,
            urlPrefix: KOKORO_URL_PREFIX,
            urlToFilename: (url) => {
              const tail = url.slice(KOKORO_URL_PREFIX.length).split('?')[0]!;
              const slash = tail.indexOf('/');
              return slash >= 0 ? tail.slice(slash + 1) : tail;
            },
          });
          fetchInterceptorInstalled = true;
        }
        const mod = await import('kokoro-js');
        const tts = (await mod.KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
          dtype: KOKORO_DTYPE,
          // device: null -> kokoro-js auto-detects (webgpu when available, wasm fallback).
          device: null,
        })) as unknown as KokoroTTSInstance;
        this.#tts = tts;
        return tts;
      })();
    }
    return this.#loadPromise;
  }

  async *speak(
    ssml: string,
    signal: AbortSignal,
    preload = false,
  ): AsyncGenerator<TTSMessageEvent> {
    if (preload) {
      // Warm the model in the background — first generation is slow because
      // of the cold-start cost (model download + WASM init).
      this.#ensureModel().catch(() => {});
      yield { code: 'end', message: 'Preload finished' } as TTSMessageEvent;
      return;
    }

    const { plainText, marks } = parseSSMLMarks(ssml, this.#primaryLang);
    if (!plainText.trim() || marks.length === 0) {
      yield { code: 'end', message: 'Empty chunk' } as TTSMessageEvent;
      return;
    }

    await this.stopInternal();
    if (!this.#audioElement) {
      this.#audioElement = new Audio();
      this.#audioElement.setAttribute('x-webkit-airplay', 'deny');
      this.#audioElement.preload = 'auto';
    }
    const audio = this.#audioElement;

    let tts: KokoroTTSInstance;
    try {
      tts = await this.#ensureModel();
    } catch (err) {
      yield {
        code: 'error',
        message: `Kokoro model load failed: ${(err as Error).message}`,
      } as TTSMessageEvent;
      return;
    }

    if (signal.aborted) {
      yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
      return;
    }

    let rawAudio: KokoroAudio;
    try {
      rawAudio = await tts.generate(plainText, {
        voice: this.#currentVoiceId || 'af_heart',
        speed: this.#rate,
      });
    } catch (err) {
      yield {
        code: 'error',
        message: `Kokoro generation failed: ${(err as Error).message}`,
      } as TTSMessageEvent;
      return;
    }

    if (signal.aborted) {
      yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
      return;
    }

    const durationSec = rawAudio.audio.length / rawAudio.sampling_rate;
    const url = URL.createObjectURL(rawAudio.toBlob());
    if (this.#currentObjectUrl) URL.revokeObjectURL(this.#currentObjectUrl);
    this.#currentObjectUrl = url;

    // Schedule per-mark dispatch evenly across the audio duration. We use
    // the `audio.currentTime` clock (driven by playback) rather than wall
    // time so pause/seek stay correct.
    const markPositions = this.#computeMarkPositions(marks, durationSec);

    // Fire the first mark immediately so the highlight matches the first
    // spoken word from the moment audio starts.
    this.controller?.dispatchSpeakMark(marks[0]!);
    yield {
      code: 'boundary',
      mark: marks[0]!.name,
      message: `Start chunk: ${marks[0]!.name}`,
    } as TTSMessageEvent;

    audio.src = url;
    this.#speakingLang = marks[0]!.language || this.#primaryLang;

    // The boundary events for marks[1..] are delivered via the time-update
    // loop; we still need to yield them from the generator so the consumer
    // (TTSController) sees them. We collect them into a queue.
    type QueuedEvent =
      | { kind: 'boundary'; mark: TTSMark }
      | { kind: 'end' }
      | { kind: 'error'; message: string };
    const queue: QueuedEvent[] = [];
    let queueResolver: (() => void) | null = null;
    const pushEvent = (ev: QueuedEvent) => {
      queue.push(ev);
      if (queueResolver) {
        const r = queueResolver;
        queueResolver = null;
        r();
      }
    };
    const waitForEvent = () =>
      new Promise<void>((resolve) => {
        if (queue.length > 0) {
          resolve();
        } else {
          queueResolver = resolve;
        }
      });

    let nextMarkIndex = 1;
    const onTimeUpdate = () => {
      if (!audio) return;
      const t = audio.currentTime;
      while (nextMarkIndex < markPositions.length && t >= markPositions[nextMarkIndex]!) {
        const mark = marks[nextMarkIndex]!;
        this.controller?.dispatchSpeakMark(mark);
        pushEvent({ kind: 'boundary', mark });
        nextMarkIndex++;
      }
    };
    const onEnded = () => pushEvent({ kind: 'end' });
    const onError = () => pushEvent({ kind: 'error', message: 'Audio playback error' });
    const onAbort = () => pushEvent({ kind: 'error', message: 'Aborted' });

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort);

    try {
      audio.playbackRate = this.#rate;
      try {
        await audio.play();
      } catch (err) {
        yield {
          code: 'error',
          message: `Playback failed: ${(err as Error).message}`,
        } as TTSMessageEvent;
        return;
      }
      this.#isPlaying = true;

      while (true) {
        if (queue.length === 0) await waitForEvent();
        const ev = queue.shift();
        if (!ev) continue;
        if (ev.kind === 'boundary') {
          yield {
            code: 'boundary',
            mark: ev.mark.name,
            message: `Mark: ${ev.mark.name}`,
          } as TTSMessageEvent;
        } else if (ev.kind === 'end') {
          yield { code: 'end', message: 'Chunk finished' } as TTSMessageEvent;
          return;
        } else {
          yield { code: 'error', message: ev.message } as TTSMessageEvent;
          return;
        }
      }
    } finally {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      await this.stopInternal();
    }
  }

  /**
   * Distribute mark positions across the audio duration. Each mark gets a
   * start time at i * (duration / N). For marks weighted by character count
   * this would be more accurate, but the uniform approximation is what
   * lector ships and it reads correctly in practice.
   */
  #computeMarkPositions(marks: TTSMark[], durationSec: number): number[] {
    const n = marks.length;
    if (n <= 1) return [0];
    // Weight each mark by its text length so longer words/sentences get
    // proportionally more audio time. Falls back to uniform if every mark
    // has zero length.
    const weights = marks.map((m) => Math.max(1, m.text.trim().length));
    const total = weights.reduce((a, b) => a + b, 0);
    const positions: number[] = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      positions.push((acc / total) * durationSec);
      acc += weights[i]!;
    }
    return positions;
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
    // Kokoro does not expose pitch control; the rate parameter on generate()
    // is the only audio-shape lever. Accept-and-ignore to satisfy the
    // TTSClient contract without misleading callers.
  }

  async setVoice(voice: string): Promise<void> {
    if (this.#voices.find((v) => v.id === voice)) {
      this.#currentVoiceId = voice;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return this.#voices;
  }

  async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    const normalized = lang.toLowerCase();
    // Kokoro 82M ONNX is English-only, so for non-English requests we
    // return an empty group rather than surfacing voices that would
    // produce gibberish output.
    const matches = normalized.startsWith('en') ? this.#voices : [];
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
    return ['word', 'sentence'];
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
    this.#tts = null;
    this.#loadPromise = null;
  }
}
