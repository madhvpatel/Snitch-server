// One-off probe: does Replicate's hosted Demucs work as a drop-in for our
// self-hosted Python backend? Run BEFORE changing the pipeline.
//
//   REPLICATE_API_TOKEN=r8_xxx node scripts/test-replicate-demucs.mjs [audioUrl]
//
// Checks the things that actually matter for our pipeline:
//   1. Does the call succeed and return stems?
//   2. WHICH stems? (our fingerprinter prefers a `music` stem — standard
//      4-stem demucs gives vocals/drums/bass/other, NO `music`.)
//   3. Are the stem URLs downloadable, and what format/size?
//   4. End-to-end latency (hosted = queue + cold start + up/download — this is
//      the real risk vs. local MPS).

import Replicate from 'replicate';

const MODEL = process.env.MODEL
    || 'cjwbw/demucs:25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953';
const audio = process.env.AUDIO || process.argv[2]
    || 'https://replicate.delivery/pbxt/J6Quo9VPU210JJB9HS97ThWUxT7iax8PWiP7FD5f3bg2G6AY/test1.mp3';

if (!process.env.REPLICATE_API_TOKEN) {
    console.error('Missing REPLICATE_API_TOKEN. Run: REPLICATE_API_TOKEN=r8_xxx node scripts/test-replicate-demucs.mjs');
    process.exit(1);
}

const replicate = new Replicate();

const PIPELINE_PREFERRED = ['music', 'other']; // what requestAudioDeconstruction prefers

(async () => {
    console.log('Model :', MODEL.split(':')[0]);
    console.log('Audio :', audio);
    console.log('Running (this can be slow on a cold start)…\n');

    const t0 = Date.now();
    let output;
    try {
        output = await replicate.run(MODEL, { input: { audio } });
    } catch (err) {
        console.error('❌ Replicate run FAILED:', err.message);
        if (err.response) console.error('   status:', err.response.status);
        process.exit(1);
    }
    const runMs = Date.now() - t0;
    console.log(`✅ Run finished in ${(runMs / 1000).toFixed(1)}s\n`);

    // Normalize output → { stemName: url }. The SDK may return FileOutput
    // objects (v1.x) or plain URL strings depending on model output shape.
    const stems = {};
    if (output && typeof output === 'object' && !Array.isArray(output)) {
        for (const [k, v] of Object.entries(output)) {
            const url = typeof v === 'string' ? v : (typeof v?.url === 'function' ? v.url() : v?.url ?? String(v));
            stems[k] = String(url);
        }
    } else {
        console.log('⚠️  Unexpected output shape (not an object):', output);
        process.exit(1);
    }

    const stemNames = Object.keys(stems);
    console.log('Stems returned :', stemNames.join(', '));

    const preferred = PIPELINE_PREFERRED.find((s) => stemNames.includes(s));
    if (preferred) {
        console.log(`Pipeline match : "${preferred}" stem present ✅`);
    } else {
        console.log('Pipeline match : ⚠️  NO "music"/"other" stem — fingerprinter would fall back to first stem;');
        console.log('                 self-hosted backend currently emits a `music` stem this model may not.');
    }

    console.log('\nDownloading each stem to verify format/size…');
    for (const [stem, url] of Object.entries(stems)) {
        try {
            const res = await fetch(url);
            const buf = Buffer.from(await res.arrayBuffer());
            console.log(`  ${stem.padEnd(8)} ${(buf.length / 1024).toFixed(0).padStart(6)} KB  ${res.headers.get('content-type')}  ${url.slice(0, 60)}…`);
        } catch (err) {
            console.log(`  ${stem.padEnd(8)} ❌ download failed: ${err.message}`);
        }
    }

    console.log('\n── Verdict inputs ──');
    console.log('latency_s        :', (runMs / 1000).toFixed(1), '(local MPS is ~seconds; watch for cold-start spikes)');
    console.log('stem_set         :', stemNames.join('/'));
    console.log('has_music_stem   :', stemNames.includes('music'));
    console.log('drop_in_ready    :', preferred ? 'shape OK (may need stem-name remap)' : 'needs stem remap (no music stem)');
})();
