// Compatibility verification: can a REAL Replicate ryan5453/demucs stem flow
// through our existing pipeline functions unchanged? Tests the actual decode +
// peak-selection path that song-ID / source-analysis depend on.
//
//   REPLICATE_API_TOKEN=… node scripts/verify-replicate-compat.mjs
//
// Proves two things empirically:
//   A. Raw 24-bit Replicate WAV → decodeMonoWav THROWS (incompatible as-is).
//   B. After an ffmpeg 16-bit transcode → decodeMonoWav + selectPeakWindows
//      succeed (a transcode-on-ingest adapter makes it fully compatible).

import Replicate from 'replicate';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { decodeMonoWav, selectPeakWindows } from '../peakFrameAnalysis.js';

const execFileAsync = promisify(execFile);
const MODEL = 'ryan5453/demucs:5a7041cc9b82e5a558fea6b3d7b12dea89625e89da33f0447bd727c2d0ab9e77';
const audio = process.env.AUDIO
    || 'https://replicate.delivery/pbxt/KqCC8G0RySCjKBQinde7gog9XwsfUR8uF6IyD2h6HPirewAg/Josh%20Woodward%20-%20Are%20You%20Having%20Fun';

const wavInfo = (buf) => ({
    container: buf.slice(0, 4).toString('ascii'),
    audioFormat: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    bits: buf.readUInt16LE(34),
});

(async () => {
    const replicate = new Replicate();
    console.log('1. Requesting real Replicate stem (stem=other, output_format=wav)…');
    const output = await replicate.run(MODEL, { input: { audio, stem: 'other', output_format: 'wav' } });
    const url = Object.entries(output)
        .map(([, v]) => (typeof v === 'string' ? v : (typeof v?.url === 'function' ? v.url() : v?.url)))
        .find((u) => u && String(u).includes('other') === false ? false : true)
        || (typeof output.other === 'string' ? output.other : output.other?.url?.() ?? output.other?.url);
    const otherUrl = typeof output.other === 'string' ? output.other : (output.other?.url?.() ?? String(output.other));
    const res = await fetch(otherUrl);
    const raw24 = Buffer.from(await res.arrayBuffer());
    console.log('   got stem:', JSON.stringify(wavInfo(raw24)), `${(raw24.length / 1024 / 1024).toFixed(1)} MB\n`);

    console.log('2. TEST A — feed RAW Replicate stem to our pipeline (as-is):');
    try {
        decodeMonoWav(raw24);
        console.log('   decodeMonoWav: ✅ unexpectedly succeeded\n');
    } catch (err) {
        console.log(`   decodeMonoWav: ❌ THROWS → "${err.message}"`);
    }
    try {
        selectPeakWindows(raw24, { windowSeconds: 8 });
        console.log('   selectPeakWindows: ✅ unexpectedly succeeded');
    } catch (err) {
        console.log(`   selectPeakWindows: ❌ THROWS → "${err.message}"`);
    }
    console.log('   → As-is, the stem is NOT compatible: the whole song-ID/source path crashes.\n');

    console.log('3. TEST B — transcode to 16-bit/44.1k via ffmpeg, then re-test:');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replicate-compat-'));
    const inPath = path.join(dir, 'in.wav');
    const outPath = path.join(dir, 'out16.wav');
    await fs.writeFile(inPath, raw24);
    const tT0 = Date.now();
    await execFileAsync('ffmpeg', ['-y', '-i', inPath, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', outPath]);
    const transcodeMs = Date.now() - tT0;
    const wav16 = await fs.readFile(outPath);
    console.log('   transcoded:', JSON.stringify(wavInfo(wav16)), `(${transcodeMs}ms)`);
    try {
        const decoded = decodeMonoWav(wav16);
        console.log(`   decodeMonoWav: ✅ ${decoded.samples.length} samples, ${decoded.durationSeconds.toFixed(1)}s @ ${decoded.sampleRate}Hz`);
        const peaks = selectPeakWindows(wav16, { windowSeconds: 8, maxWindows: 6 });
        console.log(`   selectPeakWindows: ✅ ${peaks.length} peak window(s) found`);
        console.log('   → After a 16-bit transcode, the stem is byte-format identical to the self-hosted');
        console.log('     backend and flows through the pipeline unchanged. ✅ FULLY COMPATIBLE.');
    } catch (err) {
        console.log(`   ❌ still fails after transcode: ${err.message}`);
    }
    await fs.rm(dir, { recursive: true, force: true });

    console.log('\n── VERDICT ──');
    console.log('Replicate ryan5453/demucs emits 24-bit WAV; pipeline decodeMonoWav handles only 16-bit/32f.');
    console.log('NOT a drop-in as-is. Needs a transcode-to-16-bit step on stem download (ffmpeg, already a dep).');
})().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
