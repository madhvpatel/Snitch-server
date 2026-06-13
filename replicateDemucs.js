// Replicate-hosted Demucs backend — a drop-in alternative to the self-hosted
// Python service so production needn't deploy Demucs at all.
//
// Returns the SAME shape as the local requestAudioDeconstruction so the rest of
// the pipeline is untouched:
//   { provider, model, device, jobId, preferredStem, stems: { [name]: { buffer, mimeType, fileName, sourceUrl } } }
//
// Two compatibility steps proven during evaluation (see verify-replicate-compat.mjs):
//   • Model `ryan5453/demucs` emits 24-bit WAVE_FORMAT_EXTENSIBLE; our decoder
//     handles only 16-bit/32f → every stem is transcoded to 16-bit/44.1k PCM
//     via ffmpeg on download (~90ms each).
//   • No `music` stem (gives bass/drums/other/vocals) → preferredStem = 'other'.

import Replicate from 'replicate';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);

const REPLICATE_DEMUCS_MODEL = process.env.REPLICATE_DEMUCS_MODEL
    || 'ryan5453/demucs:5a7041cc9b82e5a558fea6b3d7b12dea89625e89da33f0447bd727c2d0ab9e77';

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

// Transcode any WAV (e.g. 24-bit WAVE_FORMAT_EXTENSIBLE from Replicate) to the
// 16-bit/44.1k PCM the pipeline's decodeMonoWav expects.
const transcodeTo16BitWav = async (inputBuffer) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'demucs-stem-'));
    const inPath = path.join(dir, 'in.wav');
    const outPath = path.join(dir, 'out.wav');
    try {
        await fs.writeFile(inPath, inputBuffer);
        await execFileAsync(ffmpegPath, ['-y', '-i', inPath, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', outPath]);
        return await fs.readFile(outPath);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
};

const resolveStemUrl = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (typeof value.url === 'function') return String(value.url());
    if (value.url) return String(value.url);
    return null;
};

// Mirror requestAudioDeconstruction({ audioBuffer, fileName, mimeType }).
export const requestAudioDeconstructionReplicate = async ({ audioBuffer, fileName = 'input.wav', mimeType = 'audio/wav' }) => {
    if (!process.env.REPLICATE_API_TOKEN) {
        throw new Error('REPLICATE_API_TOKEN is not set');
    }
    const replicate = new Replicate();
    const jobId = crypto.randomUUID().slice(0, 8);

    // Upload the local audio buffer (Blob → Replicate files API) and request all
    // four stems as WAV. stem='none' returns bass/drums/other/vocals; we need
    // vocals for the fingerprint vocal-penalty score, so don't isolate a single one.
    const audio = new Blob([audioBuffer], { type: mimeType });
    const output = await replicate.run(REPLICATE_DEMUCS_MODEL, {
        input: { audio, stem: 'none', output_format: 'wav' },
    });

    const stems = {};
    for (const [name, value] of Object.entries(output || {})) {
        const url = resolveStemUrl(value);
        if (!url) continue;
        const res = await fetch(url);
        if (!res.ok) continue;
        const raw = Buffer.from(await res.arrayBuffer());
        const buffer = await transcodeTo16BitWav(raw); // 24-bit → 16-bit
        stems[name] = { buffer, mimeType: 'audio/wav', fileName: `${name}.wav`, sourceUrl: url };
    }

    if (!Object.keys(stems).length) {
        throw new Error('Replicate Demucs returned no downloadable stems');
    }

    const preferredStem = stems.music ? 'music' : stems.other ? 'other' : Object.keys(stems)[0];

    return {
        provider: 'demucs',
        model: 'htdemucs',
        device: 'replicate',
        jobId,
        preferredStem,
        stems,
    };
};
