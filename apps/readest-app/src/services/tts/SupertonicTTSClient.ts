import { TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { loadModelBytes, loadModelJson } from './modelCache';

// onnxruntime-web is loaded dynamically inside #ensureModel() so the heavy
// WASM/WebGPU runtime stays out of the SSR bundle and the initial JS payload
// stays small for users who never pick a Supertonic voice.
type OrtTensor = {
  data: Float32Array | BigInt64Array;
  dims: readonly number[];
};
type OrtInferenceSession = {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
};
interface OrtModule {
  Tensor: new (type: string, data: Float32Array | BigInt64Array, shape: number[]) => OrtTensor;
  InferenceSession: {
    create(
      path: string | Uint8Array,
      options?: Record<string, unknown>,
    ): Promise<OrtInferenceSession>;
  };
  env: {
    wasm: {
      wasmPaths?: string;
      numThreads?: number;
    };
  };
}

// All assets live under the Supertonic-3 HuggingFace repo. The Tauri-side
// disk cache (services/tts/modelCache.ts) writes a copy to $APPDATA so the
// ~398MB first-use download survives an IndexedDB wipe and the engine works
// fully offline on the second run.
const HF_BASE = 'https://huggingface.co/Supertone/supertonic-3/resolve/main';
const ENGINE_ID = 'supertonic-tts';
const ENGINE_NAME = 'Supertonic-3 (Local Neural)';
const ENGINE_CACHE_KEY = 'supertonic-3';

// File names match the layout in the HuggingFace repo. Voice JSON files are
// loaded lazily — only the currently-selected voice is downloaded.
const FILES = {
  cfgs: 'tts.json',
  indexer: 'unicode_indexer.json',
  dp: 'duration_predictor.onnx',
  textEnc: 'text_encoder.onnx',
  vectorEst: 'vector_estimator.onnx',
  vocoder: 'vocoder.onnx',
} as const;

// Languages exposed by Supertonic-3 (helper.js AVAILABLE_LANGS).
const AVAILABLE_LANGS = [
  'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr',
  'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk',
  'sl', 'sv', 'tr', 'uk', 'vi',
];

// 10 stock voices ship with Supertonic-3. Each voice JSON is ~290KB.
const VOICE_IDS = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'] as const;
type SupertonicVoiceId = (typeof VOICE_IDS)[number];

interface SupertonicCfgs {
  ae: {
    sample_rate: number;
    base_chunk_size: number;
  };
  ttl: {
    chunk_compress_factor: number;
    latent_dim: number;
  };
}

interface SupertonicStyleJson {
  style_ttl: { dims: number[]; data: number[] | number[][] | number[][][] };
  style_dp: { dims: number[]; data: number[] | number[][] | number[][][] };
}

interface LoadedStyle {
  ttl: OrtTensor;
  dp: OrtTensor;
}

interface LoadedModel {
  ort: OrtModule;
  cfgs: SupertonicCfgs;
  indexer: number[];
  dp: OrtInferenceSession;
  textEnc: OrtInferenceSession;
  vectorEst: OrtInferenceSession;
  vocoder: OrtInferenceSession;
}

/**
 * Supertonic-3 multilingual TTS running entirely in the browser via
 * onnxruntime-web. ~99M params split across 4 ONNX sessions; the
 * vector_estimator (257MB) and vocoder (101MB) dominate the download.
 *
 * Highlight strategy mirrors Kokoro: synthesize the whole SSML chunk in
 * one shot, then schedule one boundary callback per SSML mark distributed
 * across the audio duration. Supertonic doesn't expose per-token
 * timestamps, so the uniform/length-weighted approximation is the cheapest
 * thing that still tracks audio reasonably.
 */
export class SupertonicTTSClient implements TTSClient {
  name = ENGINE_ID;
  initialized = false;
  controller?: TTSController;

  #model: LoadedModel | null = null;
  #loadPromise: Promise<LoadedModel> | null = null;
  #voices: TTSVoice[] = [];
  #voiceStyles = new Map<string, LoadedStyle>();
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId: SupertonicVoiceId = 'F1';
  #rate = 1.05;

  #audioElement: HTMLAudioElement | null = null;
  #currentObjectUrl: string | null = null;
  #isPlaying = false;

  // Denoising steps. The reference demo uses 8 — fewer steps trade quality
  // for latency. 4 is the practical floor for natural-sounding output; at 2
  // the audio gets metallic. Could be made configurable via a "performance"
  // setting once we wire a knob in the TTS panel.
  #totalSteps = 4;
  #silenceBetweenChunksSec = 0.3;

  constructor(controller?: TTSController) {
    this.controller = controller;
  }

  async init(): Promise<boolean> {
    this.#voices = this.#buildVoiceListSync();
    this.initialized = typeof window !== 'undefined';
    return this.initialized;
  }

  #buildVoiceListSync(): TTSVoice[] {
    // Supertonic-3 is multilingual but each stock voice is trained on a
    // mixed corpus. We expose each voice under every supported language so
    // the existing Readest voice picker can match by language without us
    // needing a separate "engine languages" list.
    const out: TTSVoice[] = [];
    for (const id of VOICE_IDS) {
      const gender = id.startsWith('F') ? 'Female' : 'Male';
      for (const lang of AVAILABLE_LANGS) {
        out.push({
          id: `${id}_${lang}`,
          name: `Supertonic · ${id} (${gender})`,
          lang,
        });
      }
    }
    return out;
  }

  async #ensureModel(): Promise<LoadedModel> {
    if (this.#model) return this.#model;
    if (!this.#loadPromise) {
      this.#loadPromise = this.#loadModel();
    }
    return this.#loadPromise;
  }

  async #loadModel(): Promise<LoadedModel> {
    // onnxruntime-web is imported dynamically so the WASM blob doesn't
    // appear in the SSR/initial chunk. The 1.22.0-dev build (matched to
    // kokoro-js' transitive ORT for dedupe) doesn't expose its types via
    // the package's "exports" map, so we suppress the implicit-any
    // diagnostic and lean on the OrtModule structural type for safety.
    // @ts-expect-error onnxruntime-web 1.22 has no published types export
    const ortMod = (await import('onnxruntime-web')) as unknown as OrtModule;

    // Pin single-thread WASM. Multi-threaded ORT needs SharedArrayBuffer
    // which needs COOP/COEP isolation — but enabling COEP=require-corp on
    // the Next.js page breaks kokoro-js' phonemizer (its espeak-ng WASM
    // load gets blocked), so we leave the page un-isolated and run ORT
    // single-threaded. Slower but works alongside Kokoro without the COEP
    // collateral damage.
    ortMod.env.wasm.numThreads = 1;

    const [cfgs, indexer, dpBytes, textEncBytes, vectorEstBytes, vocoderBytes] =
      await Promise.all([
        loadModelJson<SupertonicCfgs>(
          ENGINE_CACHE_KEY,
          FILES.cfgs,
          `${HF_BASE}/onnx/${FILES.cfgs}`,
        ),
        loadModelJson<number[]>(
          ENGINE_CACHE_KEY,
          FILES.indexer,
          `${HF_BASE}/onnx/${FILES.indexer}`,
        ),
        loadModelBytes(ENGINE_CACHE_KEY, FILES.dp, `${HF_BASE}/onnx/${FILES.dp}`),
        loadModelBytes(ENGINE_CACHE_KEY, FILES.textEnc, `${HF_BASE}/onnx/${FILES.textEnc}`),
        loadModelBytes(ENGINE_CACHE_KEY, FILES.vectorEst, `${HF_BASE}/onnx/${FILES.vectorEst}`),
        loadModelBytes(ENGINE_CACHE_KEY, FILES.vocoder, `${HF_BASE}/onnx/${FILES.vocoder}`),
      ]);

    const sessionOptions = {
      // WebGPU first, fall back to WASM. Tauri's WKWebView doesn't expose
      // WebGPU on stable Safari yet, so most users will end up on WASM —
      // that's fine, it's a few seconds per chunk on an M-series Mac.
      executionProviders: ['webgpu', 'wasm'],
    };

    const [dp, textEnc, vectorEst, vocoder] = await Promise.all([
      ortMod.InferenceSession.create(dpBytes, sessionOptions),
      ortMod.InferenceSession.create(textEncBytes, sessionOptions),
      ortMod.InferenceSession.create(vectorEstBytes, sessionOptions),
      ortMod.InferenceSession.create(vocoderBytes, sessionOptions),
    ]);

    const loaded: LoadedModel = {
      ort: ortMod,
      cfgs,
      indexer,
      dp,
      textEnc,
      vectorEst,
      vocoder,
    };
    this.#model = loaded;
    return loaded;
  }

  async #ensureVoiceStyle(model: LoadedModel, voiceId: string): Promise<LoadedStyle> {
    const cached = this.#voiceStyles.get(voiceId);
    if (cached) return cached;
    const raw = await loadModelJson<SupertonicStyleJson>(
      ENGINE_CACHE_KEY,
      `voice_styles/${voiceId}.json`,
      `${HF_BASE}/voice_styles/${voiceId}.json`,
    );
    const ttl = makeTensorFromJson(model.ort, raw.style_ttl);
    const dp = makeTensorFromJson(model.ort, raw.style_dp);
    const style: LoadedStyle = { ttl, dp };
    this.#voiceStyles.set(voiceId, style);
    return style;
  }

  async *speak(
    ssml: string,
    signal: AbortSignal,
    preload = false,
  ): AsyncGenerator<TTSMessageEvent> {
    if (preload) {
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

    let model: LoadedModel;
    try {
      model = await this.#ensureModel();
    } catch (err) {
      yield {
        code: 'error',
        message: `Supertonic model load failed: ${(err as Error).message}`,
      } as TTSMessageEvent;
      return;
    }

    if (signal.aborted) {
      yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
      return;
    }

    // Voice IDs in the picker are stored as `${voice}_${lang}` so the same
    // voice can appear in multiple language groups. Strip the lang suffix
    // for the underlying style lookup; default to whatever the SSML mark
    // reports if the voice ID isn't recognised.
    const baseVoiceId = (
      VOICE_IDS.find((v) => this.#currentVoiceId.startsWith(v)) ?? 'F1'
    ) as SupertonicVoiceId;
    const targetLang = pickEngineLang(marks[0]?.language || this.#primaryLang);

    let style: LoadedStyle;
    try {
      style = await this.#ensureVoiceStyle(model, baseVoiceId);
    } catch (err) {
      yield {
        code: 'error',
        message: `Supertonic voice load failed: ${(err as Error).message}`,
      } as TTSMessageEvent;
      return;
    }

    if (signal.aborted) {
      yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
      return;
    }

    let wav: Float32Array;
    let totalDurationSec: number;
    try {
      const result = await synthesizeChunked(
        model,
        plainText,
        targetLang,
        style,
        this.#totalSteps,
        this.#rate,
        this.#silenceBetweenChunksSec,
      );
      wav = result.wav;
      totalDurationSec = result.durationSec;
    } catch (err) {
      yield {
        code: 'error',
        message: `Supertonic synthesis failed: ${(err as Error).message}`,
      } as TTSMessageEvent;
      return;
    }

    if (signal.aborted) {
      yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
      return;
    }

    const wavBuffer = encodeWavPcm16(wav, model.cfgs.ae.sample_rate);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    if (this.#currentObjectUrl) URL.revokeObjectURL(this.#currentObjectUrl);
    this.#currentObjectUrl = url;

    const markPositions = computeMarkPositions(marks, totalDurationSec);

    this.controller?.dispatchSpeakMark(marks[0]!);
    yield {
      code: 'boundary',
      mark: marks[0]!.name,
      message: `Start chunk: ${marks[0]!.name}`,
    } as TTSMessageEvent;

    audio.src = url;
    this.#speakingLang = marks[0]!.language || this.#primaryLang;

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
        if (queue.length > 0) resolve();
        else queueResolver = resolve;
      });

    let nextMarkIndex = 1;
    const onTimeUpdate = () => {
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
      // Supertonic already bakes the speed factor into the duration
      // predictor's output, so playbackRate stays at 1.0 — bumping it would
      // double-apply the speed-up and chipmunk the audio.
      audio.playbackRate = 1.0;
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

  async pause(): Promise<boolean> {
    if (!this.#audioElement || !this.#isPlaying) return true;
    this.#audioElement.pause();
    this.#isPlaying = false;
    return true;
  }

  async resume(): Promise<boolean> {
    // Guard the play() call: if no source is loaded (e.g. stopInternal()
    // cleared src after a section change), play() throws NotSupportedError
    // in WKWebView and the toggle-play UI gets stuck. Return false so the
    // controller knows to re-issue speak() instead of treating resume as
    // a noop success.
    if (!this.#audioElement || this.#isPlaying) return true;
    if (!this.#audioElement.src) return false;
    try {
      await this.#audioElement.play();
    } catch {
      return false;
    }
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
    this.#primaryLang = pickEngineLang(lang);
  }

  async setRate(rate: number): Promise<void> {
    // Supertonic's `_infer` accepts a `speed` factor that's applied to the
    // duration_predictor output before sampling — that's the right way to
    // change rate (changing playbackRate after the fact would shift pitch).
    this.#rate = Math.max(0.5, Math.min(2.0, rate));
  }

  async setPitch(_pitch: number): Promise<void> {
    // No explicit pitch knob in the model; ignore quietly so callers
    // following the TTSClient contract don't break.
  }

  async setVoice(voice: string): Promise<void> {
    if (this.#voices.find((v) => v.id === voice)) {
      const base = (
        VOICE_IDS.find((v) => voice.startsWith(v)) ?? 'F1'
      ) as SupertonicVoiceId;
      this.#currentVoiceId = base;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return this.#voices;
  }

  async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    const normalized = lang.toLowerCase().split('-')[0]!;
    const engineLang = AVAILABLE_LANGS.includes(normalized) ? normalized : 'en';
    const matches = this.#voices.filter((v) => v.lang === engineLang);
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
    return `${this.#currentVoiceId}_${this.#speakingLang || this.#primaryLang}`;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    await this.stopInternal();
    this.#model = null;
    this.#loadPromise = null;
    this.#voiceStyles.clear();
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

const pickEngineLang = (lang: string): string => {
  if (!lang) return 'en';
  const base = lang.toLowerCase().split('-')[0]!;
  return AVAILABLE_LANGS.includes(base) ? base : 'en';
};

// Sentence-aware chunker copied from helper.js. Splits on sentence
// terminators while keeping common abbreviations intact, then packs into
// segments of at most `maxLen` characters so the ONNX text_encoder gets
// inputs of bounded length.
const chunkText = (text: string, maxLen: number): string[] => {
  const paragraphs = text.trim().split(/\n\s*\n+/).filter((p) => p.trim());
  const chunks: string[] = [];
  const splitRegex =
    /(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/;
  for (let paragraph of paragraphs) {
    paragraph = paragraph.trim();
    if (!paragraph) continue;
    const sentences = paragraph.split(splitRegex);
    let current = '';
    for (const sentence of sentences) {
      if (current.length + sentence.length + 1 <= maxLen) {
        current += (current ? ' ' : '') + sentence;
      } else {
        if (current) chunks.push(current.trim());
        current = sentence;
      }
    }
    if (current) chunks.push(current.trim());
  }
  return chunks;
};

const preprocessText = (text: string, lang: string): string => {
  let out = text.normalize('NFKD');
  const emojiPattern =
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
  out = out.replace(emojiPattern, '');
  const replacements: Record<string, string> = {
    '–': '-', '‑': '-', '—': '-', '_': ' ',
    '“': '"', '”': '"',
    '‘': "'", '’': "'",
    '´': "'", '`': "'",
    '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ',
    '→': ' ', '←': ' ',
  };
  for (const [k, v] of Object.entries(replacements)) {
    out = out.replaceAll(k, v);
  }
  out = out.replace(/[♥☆♡©\\]/g, '');
  const expr: Record<string, string> = {
    '@': ' at ',
    'e.g.,': 'for example, ',
    'i.e.,': 'that is, ',
  };
  for (const [k, v] of Object.entries(expr)) out = out.replaceAll(k, v);
  out = out
    .replace(/ ,/g, ',')
    .replace(/ \./g, '.')
    .replace(/ !/g, '!')
    .replace(/ \?/g, '?')
    .replace(/ ;/g, ';')
    .replace(/ :/g, ':')
    .replace(/ '/g, "'");
  while (out.includes('""')) out = out.replace('""', '"');
  while (out.includes("''")) out = out.replace("''", "'");
  while (out.includes('``')) out = out.replace('``', '`');
  out = out.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'\"')\]}…。」』】〉》›»]$/.test(out)) {
    out += '.';
  }
  return `<${lang}>${out}</${lang}>`;
};

// Map UTF-16 code units to int IDs using the indexer table from
// unicode_indexer.json. Unknown code points get -1, which the model treats
// as a sentinel.
const textToIds = (text: string, indexer: number[]): number[] => {
  const ids: number[] = new Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    ids[i] = cp < indexer.length ? indexer[cp]! : -1;
  }
  return ids;
};

// Build a float32 tensor from a possibly-nested JSON array (voice_styles
// store data as [[[float]]]). We flatten in-place into a typed array so
// downstream ONNX runs don't pay the cost of a fresh `Array.flat(2)` each
// frame.
const makeTensorFromJson = (
  ort: OrtModule,
  spec: { dims: number[]; data: number[] | number[][] | number[][][] },
): OrtTensor => {
  const total = spec.dims.reduce((a, b) => a * b, 1);
  const flat = new Float32Array(total);
  flattenInto(spec.data as unknown as number | number[] | number[][] | number[][][], flat, { i: 0 });
  return new ort.Tensor('float32', flat, [...spec.dims]);
};

const flattenInto = (
  src: number | number[] | number[][] | number[][][],
  dst: Float32Array,
  cursor: { i: number },
): void => {
  if (typeof src === 'number') {
    dst[cursor.i++] = src;
    return;
  }
  for (const child of src) {
    flattenInto(child as number | number[] | number[][] | number[][][], dst, cursor);
  }
};

interface SynthResult {
  wav: Float32Array;
  durationSec: number;
}

const synthesizeChunked = async (
  model: LoadedModel,
  text: string,
  lang: string,
  style: LoadedStyle,
  totalStep: number,
  speed: number,
  silenceSec: number,
): Promise<SynthResult> => {
  // Match helper.js: shorter chunks for CJK so the encoder context window
  // doesn't blow up on dense glyphs.
  const maxLen = lang === 'ko' || lang === 'ja' ? 120 : 300;
  const segments = chunkText(text, maxLen);
  if (segments.length === 0) {
    return { wav: new Float32Array(0), durationSec: 0 };
  }

  const sampleRate = model.cfgs.ae.sample_rate;
  const silenceSamples = Math.floor(silenceSec * sampleRate);
  const pieces: Float32Array[] = [];
  let durationSec = 0;
  let totalSamples = 0;

  for (let i = 0; i < segments.length; i++) {
    const piece = await synthesizeOne(model, segments[i]!, lang, style, totalStep, speed);
    pieces.push(piece.wav);
    durationSec += piece.durationSec;
    totalSamples += piece.wav.length;
    if (i < segments.length - 1) {
      pieces.push(new Float32Array(silenceSamples));
      totalSamples += silenceSamples;
      durationSec += silenceSec;
    }
  }

  // Concatenate into a single Float32Array — cheaper than the JS-array
  // spread the reference demo uses, and avoids the GC churn that would
  // come with a long array of pieces on a long chapter.
  const wav = new Float32Array(totalSamples);
  let offset = 0;
  for (const p of pieces) {
    wav.set(p, offset);
    offset += p.length;
  }
  return { wav, durationSec };
};

interface SegmentResult {
  wav: Float32Array;
  durationSec: number;
}

const synthesizeOne = async (
  model: LoadedModel,
  text: string,
  lang: string,
  style: LoadedStyle,
  totalStep: number,
  speed: number,
): Promise<SegmentResult> => {
  const processed = preprocessText(text, lang);
  const ids = textToIds(processed, model.indexer);
  const T = ids.length;
  const bsz = 1;

  const textIdsFlat = new BigInt64Array(T);
  for (let i = 0; i < T; i++) textIdsFlat[i] = BigInt(ids[i]!);
  const textIdsTensor = new model.ort.Tensor('int64', textIdsFlat, [bsz, T]);

  // Single-input: every position is valid, so the mask is all-ones.
  const textMaskFlat = new Float32Array(T).fill(1.0);
  const textMaskTensor = new model.ort.Tensor('float32', textMaskFlat, [bsz, 1, T]);

  const dpOutputs = await model.dp.run({
    text_ids: textIdsTensor,
    style_dp: style.dp,
    text_mask: textMaskTensor,
  });
  const durationData = dpOutputs['duration']!.data as Float32Array;
  // Apply speed factor: faster speech = shorter audio = smaller duration.
  const adjustedDuration = durationData[0]! / speed;

  const textEncOutputs = await model.textEnc.run({
    text_ids: textIdsTensor,
    style_ttl: style.ttl,
    text_mask: textMaskTensor,
  });
  const textEmb = textEncOutputs['text_emb']!;

  const sampleRate = model.cfgs.ae.sample_rate;
  const wavLen = Math.floor(adjustedDuration * sampleRate);
  const chunkSize = model.cfgs.ae.base_chunk_size * model.cfgs.ttl.chunk_compress_factor;
  const latentLen = Math.floor((wavLen + chunkSize - 1) / chunkSize);
  const latentDimVal = model.cfgs.ttl.latent_dim * model.cfgs.ttl.chunk_compress_factor;

  // Initialize the noisy latent with Box-Muller transformed unit Gaussian
  // samples, masked to the actual content length. Single-input so the mask
  // is all-ones — kept explicit for parity with the reference.
  let xt = new Float32Array(bsz * latentDimVal * latentLen);
  for (let i = 0; i < xt.length; i++) {
    const u1 = Math.max(0.0001, Math.random());
    const u2 = Math.random();
    xt[i] = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }
  const latentMaskFlat = new Float32Array(latentLen).fill(1.0);
  const latentMaskTensor = new model.ort.Tensor(
    'float32',
    latentMaskFlat,
    [bsz, 1, latentLen],
  );

  const totalStepTensor = new model.ort.Tensor(
    'float32',
    new Float32Array([totalStep]),
    [bsz],
  );

  for (let step = 0; step < totalStep; step++) {
    const currentStepTensor = new model.ort.Tensor(
      'float32',
      new Float32Array([step]),
      [bsz],
    );
    const xtTensor = new model.ort.Tensor(
      'float32',
      xt,
      [bsz, latentDimVal, latentLen],
    );
    const vecOutputs = await model.vectorEst.run({
      noisy_latent: xtTensor,
      text_emb: textEmb,
      style_ttl: style.ttl,
      latent_mask: latentMaskTensor,
      text_mask: textMaskTensor,
      current_step: currentStepTensor,
      total_step: totalStepTensor,
    });
    const denoised = vecOutputs['denoised_latent']!.data as Float32Array;
    // Copy out so the previous tensor's underlying buffer can be reclaimed
    // by ORT — we'd otherwise hold a reference for the rest of the loop.
    xt = new Float32Array(denoised);
  }

  const finalTensor = new model.ort.Tensor(
    'float32',
    xt,
    [bsz, latentDimVal, latentLen],
  );
  const vocOutputs = await model.vocoder.run({ latent: finalTensor });
  const wavData = vocOutputs['wav_tts']!.data as Float32Array;
  // Snapshot into a fresh Float32Array — the ORT-returned buffer is tied
  // to the session's output binding and can be reused on the next run().
  const wav = new Float32Array(wavData);
  const durationSec = wav.length / sampleRate;
  return { wav, durationSec };
};

const encodeWavPcm16 = (samples: Float32Array, sampleRate: number): ArrayBuffer => {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1.0, Math.min(1.0, samples[i]!));
    view.setInt16(offset, Math.floor(clamped * 32767), true);
    offset += 2;
  }
  return buffer;
};

const computeMarkPositions = (marks: TTSMark[], durationSec: number): number[] => {
  const n = marks.length;
  if (n <= 1) return [0];
  const weights = marks.map((m) => Math.max(1, m.text.trim().length));
  const total = weights.reduce((a, b) => a + b, 0);
  const positions: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    positions.push((acc / total) * durationSec);
    acc += weights[i]!;
  }
  return positions;
};
