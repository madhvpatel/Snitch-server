import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { execFile, spawn } from 'child_process';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getCurrentTotpCode, getTotpExpiryEpochMs, loginPortalUser, requireAuth, requirePlatformAdmin } from './platformAuth.js';
import { loginMobileUser, requireMobileAuth, signupMobileUser, toMobileUserPublic } from './mobileAuth.js';
import {
    MEDIA_DIR,
    buildAssetUrl,
    createReference,
    ensureAssetRecord,
    getAssetAbsolutePath,
    hashIp,
    listDemoUsers,
    mutatePlatformData,
    readPlatformData,
    removeAsset,
    saveAsset,
    stableHash,
} from './platformStore.js';
import { readCsvRecords } from './platformCsv.js';
import {
    REWARD_STAGE_KEYS,
    buildRewardHoldDate,
    calculateOutcomeBonus,
    estimateRecoverableValue,
    getCityTier,
    getStageOneAmount,
    getStageTwoAmount,
    getTrustTierPolicy,
    inferVenueType,
    isStatusActionableForRewards,
    normalizeInviteCode,
} from './platformRewards.js';
import {
    analyzeAudioSource,
    DEFAULT_SOURCE_CLASSIFIER_MODE,
    normalizeSourceClassifierMode,
} from './sourceAnalysis.js';
import { decodeMonoWav, encodeMonoWav, selectPeakWindows, summarizePeakWindows } from './peakFrameAnalysis.js';
import { analyzeGpsTrack, buildLocationDelta, haversineDistanceMeters } from './signals/locationSignals.js';
import { normalizeRadioEvidence, getLatestRadioEntry, summarizeRadioEntry } from './signals/radioSignals.js';
import { sanitizeVisualAnalysis, buildFallbackVisualAnalysis, looksLikeDegenerateVisualRefresh } from './signals/visualSignals.js';
import { buildCaptureIntegritySignals } from './signals/captureIntegritySignals.js';
import { buildAudioIdentificationSignals } from './signals/audioIdentificationSignals.js';
import {
    buildApplicationAssessmentContext,
    buildFallbackApplicationAssessment,
    generateApplicationAssessment,
} from './signals/applicationSignals.js';
import {
    buildHistoricalEvidenceContext,
    scoreEvidenceStrength,
    scoreLegalReadiness,
    scoreVenueIdentity,
} from './signals/evidenceScoring.js';
import {
    LICENSE_STATUSES,
    buildLicenseResolution,
    buildVenueResolutionModel,
    evaluateCaseReadiness,
    evaluateLitigationEligibility,
    normalizeLicenseStatus,
} from './signals/enforcementReadiness.js';
import { buildPrototypeChainOfCustody, derivePrototypeQualityScore } from './signals/authoritySignals.js';
import { inferVenueAttribution as inferSharedVenueAttribution } from './signals/venueAttribution.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDistDir = path.resolve(serverDir, '..', 'dist');
const frontendIndexFile = path.join(frontendDistDir, 'index.html');
const currentModuleFile = fileURLToPath(import.meta.url);

// Load environment variables explicitly from server/.env first, then root .env as fallback.
dotenv.config({ path: path.join(serverDir, '.env') });
dotenv.config({ path: path.join(serverDir, '..', '.env') });

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const defaultAllowedOrigins = [
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    'https://localhost:4173',
    'https://127.0.0.1:4173',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://localhost:5173',
    'https://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'https://localhost:5174',
    'https://127.0.0.1:5174',
];
const allowedOrigins = (process.env.ALLOWED_ORIGIN || defaultAllowedOrigins.join(','))
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const configuredFfmpegPath = String(process.env.FFMPEG_PATH || '').trim();
const ffmpegCandidates = (
    configuredFfmpegPath && configuredFfmpegPath !== 'ffmpeg'
        ? [configuredFfmpegPath]
        : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']
);
const ffmpegPath = ffmpegCandidates.find((candidate) => (
    candidate.includes('/') ? fsSync.existsSync(candidate) : true
)) || 'ffmpeg';
const pythonAiBaseUrl = (process.env.PYTHON_AI_BASE_URL || 'http://127.0.0.1:5001').replace(/\/+$/, '');
const isMainModule = process.argv[1] ? path.resolve(process.argv[1]) === currentModuleFile : false;
const demoForceSignatureVerified = String(process.env.DEMO_FORCE_SIGNATURE_VERIFIED || '').toLowerCase() === 'true';
const localhostOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const publicTunnelOriginPatterns = [
    /^https:\/\/[a-z0-9-]+\.ngrok-free\.dev$/i,
    /^https:\/\/[a-z0-9-]+\.ngrok\.app$/i,
    /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i,
];
const isAllowedOrigin = (origin) => !origin
    || allowedOrigins.includes(origin)
    || localhostOriginPattern.test(origin)
    || publicTunnelOriginPatterns.some((pattern) => pattern.test(origin));

// Enable CORS for frontend
app.use(cors({
    origin(origin, callback) {
        if (isAllowedOrigin(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error(`Origin ${origin} is not allowed by CORS`));
    }
}));

app.use(express.json());

const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Snitch API',
            version: '1.0.0',
            description: 'Backend server API documentation',
        },
    },
    apis: [currentModuleFile], // Automatically generate spec from JSDoc blocks in this file
};
const swaggerSpecs = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs));

// ACRCloud Configuration
const config = {
    host: process.env.ACRCLOUD_HOST,
    access_key: process.env.ACRCLOUD_ACCESS_KEY,
    access_secret: process.env.ACRCLOUD_ACCESS_SECRET,
    foursquare_key: process.env.FOURSQUARE_SERVICE_KEY,
    gemini_key: process.env.GEMINI_API_KEY,
    google_places_key: process.env.GOOGLE_PLACES_API_KEY
};
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const CAPTURE_POLICY = {
    minSeconds: 15,
    maxSeconds: 20,
    maxUploadBytes: 50 * 1024 * 1024,
    acceptedMimeTypes: ['video/webm', 'video/mp4', 'video/quicktime']
};
const CLOCK_SKEW_TOLERANCE_MS = 5000;
const processingSubmissions = new Set();
const FINGERPRINT_WINDOW_SECONDS = 8;
const FINGERPRINT_MAX_WINDOWS_PER_SOURCE = 6;
const FINGERPRINT_MAX_ATTEMPTS = 8;
const FINGERPRINT_MIN_SPACING_SECONDS = 3.2;
const FINGERPRINT_VOCAL_PENALTY_WEIGHT = 4;
const FINGERPRINT_WINDOW_RETRY_ATTEMPTS = 2;
const GEMINI_TIMEOUT_MS = 20000;

if (isMainModule) {
    console.log('🔐 ACRCloud Configuration:');
    console.log('Host:', config.host);
    console.log('Access Key:', config.access_key ? `${config.access_key.substring(0, 10)}...` : 'MISSING');
    console.log('Access Secret:', config.access_secret ? `${config.access_secret.substring(0, 10)}...` : 'MISSING');
}

app.use('/media', express.static(MEDIA_DIR));

const buildPublicBaseUrl = (req) => `${req.protocol}://${req.get('host')}`;
const rewritePythonStemUrl = (req, upstreamUrl) => {
    if (!upstreamUrl) {
        return upstreamUrl;
    }

    return upstreamUrl.replace(pythonAiBaseUrl, `${buildPublicBaseUrl(req)}/python`);
};

const sendUpstreamResponse = async (res, upstreamResponse) => {
    const contentType = upstreamResponse.headers.get('content-type');
    const payload = Buffer.from(await upstreamResponse.arrayBuffer());

    res.status(upstreamResponse.status);
    if (contentType) {
        res.type(contentType);
    }

    res.send(payload);
};

const RIGHTS_ORG_ALIASES = [
    { pattern: /\bASCAP\b|AMERICAN SOCIETY OF COMPOSERS/i, normalized: 'ASCAP' },
    { pattern: /\bBMI\b|BROADCAST MUSIC/i, normalized: 'BMI' },
    { pattern: /\bSESAC\b/i, normalized: 'SESAC' },
    { pattern: /\bGMR\b|GLOBAL MUSIC RIGHTS/i, normalized: 'GMR' },
    { pattern: /\bPRS\b|PRS FOR MUSIC/i, normalized: 'PRS' },
    { pattern: /\bGEMA\b/i, normalized: 'GEMA' },
];

const normalizeRightsOrg = (value) => {
    if (!value) {
        return null;
    }

    const trimmed = value.trim();
    for (const alias of RIGHTS_ORG_ALIASES) {
        if (alias.pattern.test(trimmed)) {
            return alias.normalized;
        }
    }

    return trimmed;
};

const parseRightsOrgFromText = (value) => {
    if (!value) {
        return null;
    }

    return normalizeRightsOrg(value);
};

const parseInlineDataUrl = (dataUrl) => {
    if (!dataUrl) {
        return null;
    }

    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
        return null;
    }

    return {
        mimeType: match[1],
        data: match[2]
    };
};

const bufferToDataUrl = (buffer, mimeType) => (
    buffer && mimeType
        ? `data:${mimeType};base64,${buffer.toString('base64')}`
        : null
);

const buildForensicPrompt = ({ mode = 'detail', peakTime, hasFrame }) => {
    const lead = mode === 'summary'
        ? 'You are reviewing a short venue recording excerpt. Provide a concise preliminary audio-only assessment.'
        : 'You are a forensic audio engineer reviewing venue evidence. Provide a practical, evidence-aware analysis.';

    const visualSection = hasFrame
        ? `
Visual frame:
- Note visible speakers, DJ booth, crowd activity, microphones, or staging.
- Flag any mismatch between the scene and the audio claim.
`
        : `
No frame was provided:
- Limit conclusions to audio evidence only.
`;

    return `
${lead}

Context:
- Peak timestamp: ${Number.isFinite(peakTime) ? `${peakTime.toFixed(2)}s` : 'unknown'}
- Keep conclusions calibrated. If the evidence is weak, say "inconclusive".

${visualSection}

Audio review:
- Is music clearly audible?
- Does the audio sound like room playback, direct feed, or an uncertain mix?
- Note crowd noise, ambience, reverberation, clipping, and low-end characteristics.

Output requirements:
- Return 3 to 5 bullet points.
- End with a final line in the form: "Conclusion: ...".
- Do not use markdown headings.
`.trim();
};

const buildVisualAnalysisPrompt = ({ peakWindows = [], song, venue, sourceAnalysis }) => `
You are reviewing still frames extracted from a short venue evidence clip.

Important:
- These frames were selected from timestamps where music energy was relatively high.
- Stay conservative. If the visuals do not clearly support a venue-scale playback claim, say "inconclusive".
- Do not invent equipment that is not visible.
- Small wall-mounted, shelf-mounted, or corner-mounted speakers in cafes/restaurants count as valid installed venue playback cues when actually visible.
- A laptop, AC unit, framed art, or a patron wearing earbuds does not by itself imply replay or private-home capture when strong venue cues are present.

Known context:
- Peak windows: ${summarizePeakWindows(peakWindows).join(', ') || 'unknown'}
- Matched song: ${song?.title ? `${song.title} - ${song.artist || 'Unknown Artist'}` : 'unknown'}
- Matched venue: ${venue?.name || 'unknown'}
- Audio source classifier: ${sourceAnalysis?.sourceClass || 'inconclusive'} (${sourceAnalysis?.confidence != null ? `${Math.round(Number(sourceAnalysis.confidence) * 100)}% confidence` : 'n/a'})

Look for:
- installed PA speakers, ceiling speakers, compact wall-mounted cafe speakers, DJ booth, mixer, stage, mic setup
- visible personal device playback like a phone, laptop, or tiny table speaker
- venue identity cues like signage, menu, branded walls, bar, tables, crowd, service area
- obstruction or weakness cues like floor-only framing, darkness, blur, blocked camera, irrelevant subject

Return strict JSON with this shape:
{
  "playbackContext": "likely_installed_pa|likely_small_portable_speaker|likely_personal_device|inconclusive",
  "confidence": 0.0,
  "summary": "one short paragraph",
  "visibleEquipment": ["..."],
  "venueIdentitySignals": ["..."],
  "obstructionFlags": ["..."],
  "frameObservations": [
    { "timestampSeconds": 0, "observation": "..." }
  ]
}
`.trim();

const parseModelJson = (value) => {
    if (!value) {
        return null;
    }

    const sanitized = value.replace(/```json|```/g, '').trim();
    return JSON.parse(sanitized);
};

const runCommand = (command, args = [], timeout = 2500) => new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => {
        if (error) {
            reject(error);
            return;
        }

        resolve({ stdout, stderr });
    });
});

const getFfmpegStatus = async () => {
    try {
        const { stdout, stderr } = await runCommand(ffmpegPath, ['-version']);
        const output = stdout || stderr || '';
        const versionLine = output.split('\n').find(Boolean) || 'ffmpeg available';

        return {
            configured: Boolean(ffmpegPath),
            available: true,
            version: versionLine.trim()
        };
    } catch (error) {
        return {
            configured: Boolean(ffmpegPath),
            available: false,
            error: error.message
        };
    }
};

const buildHealthPayload = async () => ({
    status: 'ok',
    message: 'Snitch API is running',
    timestamp: new Date().toISOString(),
    config: {
        allowed_origins: allowedOrigins,
        ffmpeg_path: ffmpegPath,
        auth_mode: 'local_jwt_totp'
    },
    services: {
        acrcloud: {
            required: true,
            configured: Boolean(config.host && config.access_key && config.access_secret)
        },
        foursquare: {
            required: false,
            configured: Boolean(config.foursquare_key)
        },
        gemini: {
            required: false,
            configured: Boolean(config.gemini_key)
        },
        google_places: {
            required: false,
            configured: Boolean(config.google_places_key)
        },
        storage: {
            required: true,
            configured: true,
            mode: 'local_filesystem'
        },
        auth: {
            required: true,
            configured: true,
            mode: 'local_jwt_totp'
        },
        ffmpeg: await getFfmpegStatus()
    }
});

const canonicalizePayload = (value) => {
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalizePayload(item)).join(',')}]`;
    }

    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizePayload(value[key])}`).join(',')}}`;
    }

    return JSON.stringify(value);
};

const PROVIDER_KEYS = {
    googleMaps: 'google_maps',
    foursquare: 'foursquare',
};

const normalizeVenueProvider = (value) => {
    if (!value) {
        return null;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['google', 'google_maps', 'google-places', 'google_places', 'maps'].includes(normalized)) {
        return PROVIDER_KEYS.googleMaps;
    }
    if (['foursquare', 'fsq'].includes(normalized)) {
        return PROVIDER_KEYS.foursquare;
    }

    return null;
};

const getAvailableVenueProviders = () => {
    const available = [];
    if (config.google_places_key) {
        available.push(PROVIDER_KEYS.googleMaps);
    }
    if (config.foursquare_key) {
        available.push(PROVIDER_KEYS.foursquare);
    }
    return available;
};

const getVenueProviderLabel = (provider) => (
    provider === PROVIDER_KEYS.googleMaps
        ? 'Google Maps'
        : provider === PROVIDER_KEYS.foursquare
            ? 'Foursquare'
            : 'Unknown'
);

const verifyInstallSignature = async ({ publicKey, payload, signature }) => {
    if (!publicKey || !signature) {
        return false;
    }

    const importedKey = await crypto.webcrypto.subtle.importKey(
        'spki',
        Buffer.from(publicKey, 'base64'),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
    );

    return crypto.webcrypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        importedKey,
        Buffer.from(signature, 'base64'),
        new TextEncoder().encode(canonicalizePayload(payload))
    );
};

// Function to identify audio using ACRCloud REST API
async function identifyAudio(audioBuffer, options = {}) {
    const current_date = new Date();
    const timestamp = Math.floor(current_date.getTime() / 1000);

    const stringToSign = `POST\n/v1/identify\n${config.access_key}\naudio\n1\n${timestamp}`;
    const signature = crypto.createHmac('sha1', config.access_secret)
        .update(Buffer.from(stringToSign, 'utf-8'))
        .digest()
        .toString('base64');

    const formData = new FormData();
    formData.append('sample', audioBuffer, {
        filename: options.filename || 'sample.webm',
        contentType: options.contentType || 'audio/webm'
    });
    formData.append('access_key', config.access_key);
    formData.append('data_type', 'audio');
    formData.append('signature_version', '1');
    formData.append('signature', signature);
    formData.append('sample_bytes', audioBuffer.length.toString());
    formData.append('timestamp', timestamp.toString());

    const url = `https://${config.host}/v1/identify`;

    const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders()
    });

    return await response.json();
}

async function resolveSongIdentity(audioBuffer, uploadMeta = {}) {
    const result = await identifyAudio(audioBuffer, uploadMeta);

    if (result.status.code !== 0) {
        return {
            ok: false,
            statusCode: result.status.code === 3001 ? 401 : 404,
            error: result.status.code === 3001 ? 'Authentication failed' : 'Song not recognized',
            details: result.status.msg,
            code: result.status.code
        };
    }

    const metadata = result.metadata;
    if (!metadata || !metadata.music || metadata.music.length === 0) {
        return {
            ok: false,
            statusCode: 404,
            error: 'No music found in audio'
        };
    }

    const song = metadata.music[0];
    const rightsText = song.external_metadata?.spotify?.album?.copyrights?.[0]?.text || null;
    const response = {
        title: song.title,
        artist: song.artists ? song.artists.map((artist) => artist.name).join(', ') : 'Unknown Artist',
        label: song.label || 'Unknown Label',
        matchScore: Number(song.score || 0),
        rights_org: parseRightsOrgFromText(rightsText),
        rights_text: rightsText,
        pro: parseRightsOrgFromText(rightsText),
        album: song.album?.name,
        release_date: song.release_date,
        cover: song.album?.cover || null,
        external_ids: song.external_ids,
        external_metadata: song.external_metadata
    };

    const needsLabel = !response.label || response.label === 'Unknown Label';
    const needsPRO = !response.rights_org;

    if ((needsLabel || needsPRO) && config.gemini_key) {
        try {
            const aiMetadata = await enrichMetadataWithAI(response.title, response.artist);
            if (needsLabel && aiMetadata?.label) {
                response.label = aiMetadata.label;
            }
            if (needsPRO && aiMetadata?.rights_org) {
                response.rights_org = aiMetadata.rights_org;
                response.pro = aiMetadata.rights_org;
            }
        } catch (error) {
            console.error('Song enrichment error:', error);
        }
    }

    return {
        ok: true,
        data: response
    };
}

const getDecodedWindowRms = (decoded, startSeconds, endSeconds) => {
    if (!decoded?.samples?.length || !decoded.sampleRate) {
        return 0;
    }

    const startSample = Math.max(0, Math.floor(startSeconds * decoded.sampleRate));
    const endSample = Math.min(decoded.samples.length, Math.ceil(endSeconds * decoded.sampleRate));
    if (endSample <= startSample) {
        return 0;
    }

    let sum = 0;
    for (let index = startSample; index < endSample; index += 1) {
        const value = decoded.samples[index];
        sum += value * value;
    }

    return Math.sqrt(sum / Math.max(1, endSample - startSample));
};

const buildWavSnippet = (decoded, startSeconds, endSeconds) => {
    const startSample = Math.max(0, Math.floor(startSeconds * decoded.sampleRate));
    const endSample = Math.min(decoded.samples.length, Math.ceil(endSeconds * decoded.sampleRate));
    return encodeMonoWav({
        sampleRate: decoded.sampleRate,
        samples: decoded.samples.slice(startSample, endSample),
    });
};

const buildFingerprintCandidates = ({
    audioBuffer,
    reference,
    deconstructionResult = null,
    includeRawSource = true,
}) => {
    const candidates = [];
    const vocalsDecoded = deconstructionResult?.stems?.vocals
        ? decodeMonoWav(deconstructionResult.stems.vocals.buffer)
        : null;
    const sources = [];

    if (deconstructionResult?.stems?.music) {
        sources.push({
            stem: 'music',
            bias: 1.35,
            buffer: deconstructionResult.stems.music.buffer,
        });
    }
    if (deconstructionResult?.stems?.other) {
        sources.push({
            stem: 'other',
            bias: 0.95,
            buffer: deconstructionResult.stems.other.buffer,
        });
    }
    if (includeRawSource && audioBuffer) {
        sources.push({
            stem: 'raw',
            bias: 0.45,
            buffer: audioBuffer,
        });
    }

    for (const source of sources) {
        const decoded = decodeMonoWav(source.buffer);
        const peakWindows = selectPeakWindows(source.buffer, {
            maxWindows: FINGERPRINT_MAX_WINDOWS_PER_SOURCE,
            windowSeconds: FINGERPRINT_WINDOW_SECONDS,
            hopSeconds: 0.5,
            minSpacingSeconds: FINGERPRINT_MIN_SPACING_SECONDS,
        });
        const fullVocalsRms = vocalsDecoded
            ? getDecodedWindowRms(vocalsDecoded, 0, decoded.durationSeconds)
            : 0;

        for (const window of peakWindows) {
            const sourceRms = getDecodedWindowRms(decoded, window.startSeconds, window.endSeconds);
            const vocalsRms = vocalsDecoded
                ? getDecodedWindowRms(vocalsDecoded, window.startSeconds, window.endSeconds)
                : 0;
            const score = (sourceRms * Math.max(window.relativeIntensity || 1, 1) * source.bias)
                / (1 + (vocalsRms * FINGERPRINT_VOCAL_PENALTY_WEIGHT));

            candidates.push({
                type: 'window',
                stem: source.stem,
                startSeconds: window.startSeconds,
                endSeconds: window.endSeconds,
                timestampSeconds: window.timestampSeconds,
                relativeIntensity: window.relativeIntensity,
                sourceRms: Number(sourceRms.toFixed(4)),
                vocalsRms: Number(vocalsRms.toFixed(4)),
                score: Number(score.toFixed(4)),
                buffer: buildWavSnippet(decoded, window.startSeconds, window.endSeconds),
                filename: `${reference}-${source.stem}-${window.rank}.wav`,
            });
        }

        const fullSourceRms = getDecodedWindowRms(decoded, 0, decoded.durationSeconds);
        candidates.push({
            type: 'full',
            stem: source.stem,
            startSeconds: 0,
            endSeconds: Number(decoded.durationSeconds.toFixed(2)),
            timestampSeconds: Number((decoded.durationSeconds / 2).toFixed(2)),
            relativeIntensity: 1,
            sourceRms: Number(fullSourceRms.toFixed(4)),
            vocalsRms: Number(fullVocalsRms.toFixed(4)),
            score: Number(((fullSourceRms * source.bias) / (1 + (fullVocalsRms * FINGERPRINT_VOCAL_PENALTY_WEIGHT))).toFixed(4)),
            buffer: source.buffer,
            filename: `${reference}-${source.stem}-full.wav`,
        });
    }

    const deduped = [];
    for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
        const overlapsExisting = deduped.some((entry) => (
            entry.stem === candidate.stem
            && entry.type === candidate.type
            && Math.abs(entry.timestampSeconds - candidate.timestampSeconds) < 1.2
        ));
        if (overlapsExisting) {
            continue;
        }
        deduped.push(candidate);
        if (deduped.length >= FINGERPRINT_MAX_ATTEMPTS) {
            break;
        }
    }

    return deduped;
};

const summarizeSongIdentityAttempts = (attempts = []) => attempts.map((attempt) => ({
    stem: attempt.stem,
    type: attempt.type,
    startSeconds: attempt.startSeconds,
    endSeconds: attempt.endSeconds,
    score: attempt.score,
    vocalsRms: attempt.vocalsRms,
    sourceRms: attempt.sourceRms,
    passLabel: attempt.passLabel || null,
    sourceType: attempt.sourceType || null,
    jobId: attempt.jobId || null,
    ok: attempt.ok,
    error: attempt.error || null,
    details: attempt.details || null,
    code: attempt.code ?? null,
}));

const resolveSongIdentityAcrossCandidates = async ({
    audioBuffer,
    reference,
    deconstructionResult = null,
    includeRawSource = true,
}) => {
    const candidates = buildFingerprintCandidates({
        audioBuffer,
        reference,
        deconstructionResult,
        includeRawSource,
    });
    const attempts = [];

    for (const candidate of candidates) {
        const maxCandidateAttempts = candidate.stem === 'music' && candidate.type === 'window'
            ? FINGERPRINT_WINDOW_RETRY_ATTEMPTS
            : 1;
        for (let attemptIndex = 0; attemptIndex < maxCandidateAttempts; attemptIndex += 1) {
            const result = await resolveSongIdentity(candidate.buffer, {
                filename: candidate.filename,
                contentType: 'audio/wav',
            });
            attempts.push({
                ...candidate,
                attemptIndex: attemptIndex + 1,
                ok: Boolean(result.ok),
                error: result.error || null,
                details: result.details || null,
                code: result.code ?? null,
            });
            if (result.ok) {
                return {
                    result,
                    matchedCandidate: candidate,
                    attempts,
                    candidates,
                };
            }
        }
    }

    return {
        result: { ok: false },
        matchedCandidate: null,
        attempts,
        candidates,
    };
};

const normalizeIsolationWav = (audioBuffer, options = {}) => {
    try {
        const decoded = decodeMonoWav(audioBuffer);
        if (!decoded?.samples?.length) {
            return null;
        }

        const targetPeak = Number(options.targetPeak || 0.92);
        const minGain = Number(options.minGain || 1.05);
        const maxGain = Number(options.maxGain || 3.2);
        let peak = 0;
        for (let index = 0; index < decoded.samples.length; index += 1) {
            peak = Math.max(peak, Math.abs(decoded.samples[index]));
        }
        if (peak <= 0) {
            return null;
        }

        const gain = Math.min(Math.max(targetPeak / peak, minGain), maxGain);
        if (!Number.isFinite(gain) || Math.abs(gain - 1) < 0.03) {
            return null;
        }

        const normalized = new Float32Array(decoded.samples.length);
        for (let index = 0; index < decoded.samples.length; index += 1) {
            normalized[index] = Math.max(-1, Math.min(1, decoded.samples[index] * gain));
        }

        return encodeMonoWav({
            sampleRate: decoded.sampleRate,
            samples: normalized,
        });
    } catch {
        return null;
    }
};

const buildIsolationPasses = ({ audioBuffer, reference }) => {
    const passes = [{
        label: 'original',
        audioBuffer,
        fileName: `${reference}.wav`,
    }];
    const leveled = normalizeIsolationWav(audioBuffer, {
        targetPeak: 0.92,
        minGain: 1.08,
        maxGain: 2.4,
    });
    if (leveled && Buffer.compare(leveled, audioBuffer) !== 0) {
        passes.push({
            label: 'leveled',
            audioBuffer: leveled,
            fileName: `${reference}-leveled.wav`,
        });
    }
    const boosted = normalizeIsolationWav(audioBuffer, {
        targetPeak: 0.98,
        minGain: 1.25,
        maxGain: 3.4,
    });
    if (
        boosted
        && Buffer.compare(boosted, audioBuffer) !== 0
        && (!leveled || Buffer.compare(boosted, leveled) !== 0)
    ) {
        passes.push({
            label: 'boosted',
            audioBuffer: boosted,
            fileName: `${reference}-boosted.wav`,
        });
    }
    return passes;
};

const scoreSongMatch = (song) => Number(song?.matchScore || 0);

const compareFingerprintRuns = (left, right) => {
    if (!left && !right) {
        return 0;
    }
    if (!left) {
        return -1;
    }
    if (!right) {
        return 1;
    }

    const leftSuccess = left.result?.ok ? 1 : 0;
    const rightSuccess = right.result?.ok ? 1 : 0;
    if (leftSuccess !== rightSuccess) {
        return leftSuccess > rightSuccess ? 1 : -1;
    }

    const leftSongScore = scoreSongMatch(left.result?.data);
    const rightSongScore = scoreSongMatch(right.result?.data);
    if (leftSongScore !== rightSongScore) {
        return leftSongScore > rightSongScore ? 1 : -1;
    }

    const leftCandidateScore = Number(left.matchedCandidate?.score || left.candidates?.[0]?.score || 0);
    const rightCandidateScore = Number(right.matchedCandidate?.score || right.candidates?.[0]?.score || 0);
    if (leftCandidateScore !== rightCandidateScore) {
        return leftCandidateScore > rightCandidateScore ? 1 : -1;
    }

    return 0;
};

const pickBetterFingerprintRun = (currentBest, nextRun) => (
    compareFingerprintRuns(nextRun, currentBest) > 0
        ? nextRun
        : currentBest
);

const buildBestSongIdentityRecord = ({ song, matchedCandidate = null, sourceType = 'current', jobId = null, passLabel = null }) => {
    if (!song?.title) {
        return null;
    }

    return {
        song,
        sourceType,
        jobId,
        passLabel,
        matchScore: scoreSongMatch(song),
        matchedAt: new Date().toISOString(),
        matchedCandidate: matchedCandidate
            ? {
                stem: matchedCandidate.stem,
                type: matchedCandidate.type,
                startSeconds: matchedCandidate.startSeconds,
                endSeconds: matchedCandidate.endSeconds,
                score: matchedCandidate.score,
            }
            : null,
    };
};

const pickBetterBestSongIdentityRecord = (currentBest, nextRecord) => {
    if (!nextRecord?.song?.title) {
        return currentBest || null;
    }
    if (!currentBest?.song?.title) {
        return nextRecord;
    }

    const nextScore = Number(nextRecord.matchScore || scoreSongMatch(nextRecord.song));
    const currentScore = Number(currentBest.matchScore || scoreSongMatch(currentBest.song));
    if (nextScore !== currentScore) {
        return nextScore > currentScore ? nextRecord : currentBest;
    }

    return nextRecord;
};

const saveStemAssetsFromDeconstruction = async ({
    submissionId,
    reference,
    deconstructionResult,
    metadata = {},
}) => Object.fromEntries(await Promise.all(
    Object.entries(deconstructionResult.stems).map(async ([stem, artifact]) => ([
        stem,
        await saveAsset({
            buffer: artifact.buffer,
            fileName: `${reference}-${stem}.wav`,
            mimeType: artifact.mimeType || 'audio/wav',
            kind: 'audio-stem',
            metadata: {
                submissionId,
                stem,
                source: deconstructionResult.provider,
                model: deconstructionResult.model,
                device: deconstructionResult.device,
                pythonJobId: deconstructionResult.jobId,
                ...metadata,
            },
        }),
    ]))
));

const evaluateFingerprintRun = async ({
    audioBuffer,
    reference,
    deconstructionResult,
    includeRawSource = true,
    sourceType = 'current',
    passLabel = null,
}) => {
    const fingerprinting = await resolveSongIdentityAcrossCandidates({
        audioBuffer,
        reference,
        deconstructionResult,
        includeRawSource,
    });

    return {
        ...fingerprinting,
        sourceType,
        passLabel,
        jobId: deconstructionResult?.jobId || null,
        fingerprintStem: fingerprinting.matchedCandidate?.stem === 'raw'
            ? null
            : (fingerprinting.matchedCandidate?.stem || null),
        attempts: fingerprinting.attempts.map((attempt) => ({
            ...attempt,
            sourceType,
            passLabel,
            jobId: deconstructionResult?.jobId || null,
        })),
        candidates: fingerprinting.candidates.map((candidate) => ({
            ...candidate,
            sourceType,
            passLabel,
            jobId: deconstructionResult?.jobId || null,
        })),
    };
};

const loadHistoricalStemJobs = async ({ data, submissionId }) => {
    const groups = new Map();
    for (const asset of data.assets.filter((entry) => (
        entry.kind === 'audio-stem'
        && entry.metadata?.submissionId === submissionId
    ))) {
        const jobId = asset.metadata?.pythonJobId || `asset-${asset.id}`;
        const group = groups.get(jobId) || {
            provider: asset.metadata?.source || 'demucs-historical',
            model: asset.metadata?.model || null,
            device: asset.metadata?.device || null,
            jobId,
            createdAt: asset.createdAt,
            stemAssets: {},
        };
        group.stemAssets[asset.metadata?.stem || asset.fileName] = asset;
        if (asset.createdAt > group.createdAt) {
            group.createdAt = asset.createdAt;
        }
        groups.set(jobId, group);
    }

    const loaded = [];
    const orderedGroups = [...groups.values()]
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .slice(0, 8);

    for (const group of orderedGroups) {
        const stems = {};
        for (const [stem, asset] of Object.entries(group.stemAssets)) {
            const absolutePath = await getAssetAbsolutePath(asset.id);
            if (!absolutePath) {
                continue;
            }
            stems[stem] = {
                buffer: await fs.readFile(absolutePath),
                mimeType: asset.mimeType || 'audio/wav',
                fileName: asset.fileName,
            };
        }

        const preferredStem = stems.music
            ? 'music'
            : stems.other
                ? 'other'
                : Object.keys(stems)[0] || null;
        if (!preferredStem) {
            continue;
        }

        loaded.push({
            provider: group.provider,
            model: group.model,
            device: group.device,
            jobId: group.jobId,
            preferredStem,
            stems,
        });
    }

    return loaded;
};

async function enrichMetadataWithAI(title, artist) {
    try {
        const genAI = new GoogleGenerativeAI(config.gemini_key);
        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

        const prompt = `
        Identified Song: "${title}" by "${artist}".
        I need the record label and the primary performing rights organization for this song.

        Return STRICT JSON only:
        {
            "label": "Record label or null",
            "rights_org": "PRO acronym like ASCAP, BMI, SESAC, GMR, PRS, or GEMA, or null"
        }
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text().replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(text);

        return {
            label: parsed.label || null,
            rights_org: normalizeRightsOrg(parsed.rights_org)
        };
    } catch (error) {
        console.error("AI Help Error:", error);
        return null;
    }
}

const withTimeout = async (promise, timeoutMs, label) => {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
};

const generateGeminiText = async ({ parts, label }) => {
    const genAI = new GoogleGenerativeAI(config.gemini_key);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await withTimeout(model.generateContent(parts), GEMINI_TIMEOUT_MS, label);
    const response = await withTimeout(result.response, GEMINI_TIMEOUT_MS, `${label} response`);
    return response.text().trim();
};

async function generateForensicReport({ audioBuffer, audioMimeType, frameDataUrl, mode, peakTime }) {
    const prompt = buildForensicPrompt({
        mode,
        peakTime,
        hasFrame: Boolean(frameDataUrl)
    });

    const parts = [
        {
            inlineData: {
                data: audioBuffer.toString('base64'),
                mimeType: audioMimeType || 'audio/wav'
            }
        },
        { text: prompt }
    ];

    const inlineFrame = parseInlineDataUrl(frameDataUrl);
    if (inlineFrame) {
        parts.unshift({
            inlineData: {
                data: inlineFrame.data,
                mimeType: inlineFrame.mimeType
            }
        });
    }

    return generateGeminiText({ parts, label: 'forensic report generation' });
}

async function generateVisualEvidenceAssessment({ frames = [], peakWindows = [], song, venue, sourceAnalysis }) {
    if (!frames.length) {
        return null;
    }

    const prompt = buildVisualAnalysisPrompt({
        peakWindows,
        song,
        venue,
        sourceAnalysis
    });

    const parts = [];
    frames.forEach((frame, index) => {
        parts.push({
            text: `Frame ${index + 1} was captured at ${frame.timestampSeconds.toFixed(2)} seconds.`
        });
        parts.push({
            inlineData: {
                data: frame.buffer.toString('base64'),
                mimeType: frame.mimeType || 'image/jpeg'
            }
        });
    });
    parts.push({ text: prompt });

    const text = await generateGeminiText({ parts, label: 'visual evidence assessment' });
    return sanitizeVisualAnalysis(parseModelJson(text), peakWindows);
}

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        res.json(await buildHealthPayload());
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Failed to build health payload',
            details: error.message
        });
    }
});

app.get('/python/health', async (req, res) => {
    try {
        const upstreamResponse = await fetch(`${pythonAiBaseUrl}/health`);
        await sendUpstreamResponse(res, upstreamResponse);
    } catch (error) {
        res.status(502).json({
            error: 'Python AI service is unreachable',
            details: error.message
        });
    }
});

app.post('/python/api/isolate', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' });
    }

    try {
        const formData = new FormData();
        formData.append('audio', req.file.buffer, {
            filename: req.file.originalname || 'input.webm',
            contentType: req.file.mimetype || 'application/octet-stream'
        });

        const upstreamResponse = await fetch(`${pythonAiBaseUrl}/api/isolate`, {
            method: 'POST',
            headers: formData.getHeaders(),
            body: formData
        });

        const contentType = upstreamResponse.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            await sendUpstreamResponse(res, upstreamResponse);
            return;
        }

        const payload = await upstreamResponse.json();
        if (payload?.stems && typeof payload.stems === 'object') {
            payload.stems = Object.fromEntries(
                Object.entries(payload.stems).map(([stem, url]) => [stem, rewritePythonStemUrl(req, url)])
            );
        }

        res.status(upstreamResponse.status).json(payload);
    } catch (error) {
        res.status(502).json({
            error: 'Python AI isolate proxy failed',
            details: error.message
        });
    }
});

app.get('/python/separated/:jobId/:fileName', async (req, res) => {
    try {
        const upstreamPath = `${pythonAiBaseUrl}/separated/${encodeURIComponent(req.params.jobId)}/${encodeURIComponent(req.params.fileName)}`;
        const upstreamResponse = await fetch(upstreamPath);
        await sendUpstreamResponse(res, upstreamResponse);
    } catch (error) {
        res.status(502).json({
            error: 'Python AI media proxy failed',
            details: error.message
        });
    }
});

const fetchBinaryPayload = async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch separated audio artifact: ${response.status} ${response.statusText}`);
    }

    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get('content-type') || 'audio/wav',
    };
};

const requestAudioDeconstruction = async ({ audioBuffer, fileName = 'input.wav', mimeType = 'audio/wav' }) => {
    const formData = new FormData();
    formData.append('audio', audioBuffer, {
        filename: fileName,
        contentType: mimeType,
    });

    const response = await fetch(`${pythonAiBaseUrl}/api/isolate`, {
        method: 'POST',
        headers: formData.getHeaders(),
        body: formData,
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(payload?.error || `Python AI isolate failed with status ${response.status}`);
    }

    if (!payload?.stems || typeof payload.stems !== 'object') {
        throw new Error('Python AI isolate response did not include any stems');
    }

    const stems = {};
    for (const [stem, stemUrl] of Object.entries(payload.stems)) {
        if (!stemUrl || typeof stemUrl !== 'string') {
            continue;
        }

        const artifact = await fetchBinaryPayload(stemUrl);
        stems[stem] = {
            ...artifact,
            fileName: `${stem}.wav`,
            sourceUrl: stemUrl,
        };
    }

    const preferredStem = stems.music
        ? 'music'
        : stems.other
            ? 'other'
            : Object.keys(stems)[0] || null;

    if (!preferredStem) {
        throw new Error('Python AI isolate response did not include any downloadable stems');
    }

    return {
        provider: 'demucs',
        model: payload.model || null,
        device: payload.device || null,
        jobId: payload.job_id || null,
        preferredStem,
        stems,
    };
};

const buildAudioDeconstructionRecord = ({
    attempted = false,
    deconstruction = null,
    savedStemAssets = {},
    fingerprintStem = null,
    peakSelectionStem = null,
    fingerprintCandidates = [],
    fingerprintAttempts = [],
    error = null,
    summaryOverride = null,
}) => {
    const stemNames = Object.keys(savedStemAssets);
    const status = deconstruction
        ? 'completed'
        : attempted
            ? 'failed'
            : 'skipped';
    const summary = summaryOverride
        || (deconstruction
            ? `Demucs separated ${stemNames.join(', ')}. ${peakSelectionStem ? `${peakSelectionStem} was used for peak selection. ` : ''}${fingerprintStem ? `${fingerprintStem} was used for song identification. ` : 'Raw extracted audio remained the fingerprinting fallback. '}${fingerprintCandidates.length ? `${fingerprintCandidates.length} fingerprint candidate(s) were ranked before ACRCloud lookup.` : ''}`.trim()
            : attempted
                ? `Audio deconstruction was attempted but unavailable. Raw extracted audio was used instead. ${error || ''}`.trim()
                : 'Audio deconstruction was skipped. Raw extracted audio was used throughout.');

    return {
        status,
        provider: deconstruction?.provider || 'demucs',
        model: deconstruction?.model || null,
        device: deconstruction?.device || null,
        jobId: deconstruction?.jobId || null,
        preferredStem: deconstruction?.preferredStem || null,
        peakSelectionStem: peakSelectionStem || null,
        fingerprintStem: fingerprintStem || null,
        usedForPeakSelection: Boolean(peakSelectionStem),
        usedForFingerprinting: Boolean(fingerprintStem),
        summary,
        error: error || null,
        fingerprintCandidates: fingerprintCandidates.map((candidate) => ({
            stem: candidate.stem,
            type: candidate.type,
            startSeconds: candidate.startSeconds,
            endSeconds: candidate.endSeconds,
            score: candidate.score,
            vocalsRms: candidate.vocalsRms,
            sourceRms: candidate.sourceRms,
        })),
        fingerprintAttempts: summarizeSongIdentityAttempts(fingerprintAttempts),
        stems: Object.entries(savedStemAssets).map(([stem, asset]) => ({
            stem,
            assetId: asset.id,
        })),
    };
};

const getStoredAudioDeconstructionAssetIds = (audioDeconstruction) => (
    Array.isArray(audioDeconstruction?.stems)
        ? audioDeconstruction.stems
            .map((stem) => stem?.assetId)
            .filter(Boolean)
        : []
);

const hasCompletedAudioDeconstruction = (audioDeconstruction) => (
    audioDeconstruction?.status === 'completed'
    && Array.isArray(audioDeconstruction?.stems)
    && audioDeconstruction.stems.length > 0
);

const backfillSubmissionAudioDeconstruction = async (submissionId) => {
    if (processingSubmissions.has(submissionId)) {
        throw new Error('Submission is already processing');
    }

    processingSubmissions.add(submissionId);

    try {
        const data = await readPlatformData();
        const submission = data.submissions.find((item) => item.id === submissionId);
        if (!submission) {
            throw new Error('Submission not found');
        }

        const previousAudioDeconstruction = submission.audioDeconstruction || null;
        const previousStemAssetIds = getStoredAudioDeconstructionAssetIds(previousAudioDeconstruction);
        const hadCompletedDeconstruction = hasCompletedAudioDeconstruction(previousAudioDeconstruction);

        const rawAsset = await ensureAssetRecord({
            assetId: submission.rawVideoAssetId,
            kind: 'raw-video',
            fileName: submission.fileName,
            mimeType: submission.uploadedMimeType || submission.mimeType,
            metadata: { submissionId },
        });
        const rawAssetPath = await getAssetAbsolutePath(submission.rawVideoAssetId);
        if (!rawAsset || !rawAssetPath) {
            throw new Error('Raw video asset missing');
        }

        const audioBuffer = await extractAudioFromFile(rawAssetPath);
        let deconstructionResult = null;
        let savedStemAssets = {};
        let fingerprintStem = null;
        let errorMessage = null;

        try {
            deconstructionResult = await requestAudioDeconstruction({
                audioBuffer,
                fileName: `${submission.reference || submission.id}.wav`,
                mimeType: 'audio/wav',
            });

            const stemAssetEntries = await Promise.all(Object.entries(deconstructionResult.stems).map(async ([stem, artifact]) => ([
                stem,
                await saveAsset({
                    buffer: artifact.buffer,
                    fileName: `${submission.reference || submission.id}-${stem}.wav`,
                    mimeType: artifact.mimeType || 'audio/wav',
                    kind: 'audio-stem',
                    metadata: {
                        submissionId,
                        stem,
                        source: deconstructionResult.provider,
                        model: deconstructionResult.model,
                        device: deconstructionResult.device,
                        pythonJobId: deconstructionResult.jobId,
                        backfilledFromAuthorityPrototype: true,
                    },
                }),
            ])));

            savedStemAssets = Object.fromEntries(stemAssetEntries);

            if (
                config.host
                && config.access_key
                && config.access_secret
                && deconstructionResult.preferredStem
                && deconstructionResult.stems[deconstructionResult.preferredStem]
            ) {
                try {
                    const fingerprintResult = await resolveSongIdentity(
                        deconstructionResult.stems[deconstructionResult.preferredStem].buffer,
                        {
                            filename: `${submission.reference || submission.id}-${deconstructionResult.preferredStem}.wav`,
                            contentType: 'audio/wav',
                        }
                    );

                    if (fingerprintResult.ok) {
                        fingerprintStem = deconstructionResult.preferredStem;
                    }
                } catch (error) {
                    console.warn('Audio deconstruction fingerprint check failed:', error.message);
                }
            }

            const audioDeconstruction = buildAudioDeconstructionRecord({
                attempted: true,
                deconstruction: deconstructionResult,
                savedStemAssets,
                fingerprintStem,
                peakSelectionStem: null,
                error: null,
                summaryOverride: `Demucs backfill stored ${Object.keys(savedStemAssets).join(', ')} for authority-side forensic review.${fingerprintStem ? ` ${fingerprintStem} was also validated through song identification.` : ''}`.trim(),
            });

            const updatedAt = new Date().toISOString();
            await mutatePlatformData((draft) => {
                const submissionRecord = draft.submissions.find((item) => item.id === submissionId);
                if (!submissionRecord) {
                    throw new Error('Submission not found');
                }

                submissionRecord.audioDeconstruction = audioDeconstruction;
                submissionRecord.updatedAt = updatedAt;
            });

            if (previousStemAssetIds.length) {
                await Promise.all(previousStemAssetIds.map((assetId) => removeAsset(assetId).catch(() => null)));
            }

            return {
                ok: true,
                preservedExisting: false,
                audioDeconstruction,
                error: null,
            };
        } catch (error) {
            errorMessage = error.message;
            const savedStemAssetIds = Object.values(savedStemAssets).map((asset) => asset?.id).filter(Boolean);
            if (savedStemAssetIds.length) {
                await Promise.all(savedStemAssetIds.map((assetId) => removeAsset(assetId).catch(() => null)));
            }
            const failedAudioDeconstruction = buildAudioDeconstructionRecord({
                attempted: true,
                deconstruction: null,
                savedStemAssets: {},
                fingerprintStem: null,
                peakSelectionStem: null,
                error: errorMessage,
                summaryOverride: `Audio deconstruction backfill failed. ${errorMessage}`.trim(),
            });

            if (!hadCompletedDeconstruction) {
                const updatedAt = new Date().toISOString();
                await mutatePlatformData((draft) => {
                    const submissionRecord = draft.submissions.find((item) => item.id === submissionId);
                    if (!submissionRecord) {
                        throw new Error('Submission not found');
                    }

                    submissionRecord.audioDeconstruction = failedAudioDeconstruction;
                    submissionRecord.updatedAt = updatedAt;
                });
            }

            return {
                ok: false,
                preservedExisting: hadCompletedDeconstruction,
                audioDeconstruction: hadCompletedDeconstruction ? previousAudioDeconstruction : failedAudioDeconstruction,
                error: errorMessage,
            };
        }
    } finally {
        processingSubmissions.delete(submissionId);
    }
};

// Song identification endpoint
app.post('/api/identify', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No audio file provided' });
        }

        console.log('Received audio file:', req.file.originalname, 'Size:', req.file.size);

        const resolved = await resolveSongIdentity(req.file.buffer, {
            filename: req.file.originalname,
            contentType: req.file.mimetype
        });

        if (!resolved.ok) {
            return res.status(resolved.statusCode).json({
                error: resolved.error,
                details: resolved.details,
                code: resolved.code
            });
        }

        res.json(resolved.data);

    } catch (error) {
        console.error('Error identifying song:', error);
        res.status(500).json({
            error: 'Failed to identify song',
            details: error.message
        });
    }
});

// Lyrics-based identification endpoint (fallback)
app.post('/api/identify-lyrics', async (req, res) => {
    try {
        const { lyrics } = req.body;

        if (!lyrics || lyrics.trim().length < 5) {
            return res.status(400).json({ error: 'Lyrics text is too short or missing' });
        }

        console.log('Received lyrics search request:', lyrics.substring(0, 50) + '...');

        // Simple keyword matching (in production, use Genius API)
        const mockSongDatabase = [
            { keywords: ['shape', 'you', 'mesmerize'], title: 'Shape of You', artist: 'Ed Sheeran', label: 'Atlantic Records', album: '÷ (Divide)' },
            { keywords: ['blinding', 'lights', 'vegas'], title: 'Blinding Lights', artist: 'The Weeknd', label: 'Republic Records', album: 'After Hours' },
            { keywords: ['levitating', 'moonlight'], title: 'Levitating', artist: 'Dua Lipa', label: 'Warner Records', album: 'Future Nostalgia' },
            { keywords: ['never', 'gonna', 'give'], title: 'Never Gonna Give You Up', artist: 'Rick Astley', label: 'RCA Records', album: 'Whenever You Need Somebody' }
        ];

        const lyricsLower = lyrics.toLowerCase();
        let bestMatch = null;
        let maxScore = 0;

        for (const song of mockSongDatabase) {
            let score = 0;
            for (const keyword of song.keywords) {
                if (lyricsLower.includes(keyword)) score++;
            }
            if (score > maxScore) {
                maxScore = score;
                bestMatch = song;
            }
        }

        if (!bestMatch || maxScore === 0) {
            return res.status(404).json({ error: 'No song found matching those lyrics' });
        }

        const mockPros = ["ASCAP", "BMI", "SESAC", "GMR"];
        const rightsOrg = mockPros[Math.floor(Math.random() * mockPros.length)];
        const response = {
            title: bestMatch.title,
            artist: bestMatch.artist,
            label: bestMatch.label,
            rights_org: rightsOrg,
            rights_text: rightsOrg,
            pro: rightsOrg,
            album: bestMatch.album,
            cover: null
        };

        console.log('Lyrics match:', response.title, 'by', response.artist);
        res.json(response);

    } catch (error) {
        console.error('Error in lyrics search:', error);
        res.status(500).json({ error: 'Lyrics search failed', details: error.message });
    }
});
const findFoursquareNearbyVenues = async ({ ll, hacc, altitude }) => {
    if (!config.foursquare_key) {
        const error = new Error('Foursquare is not configured on the server');
        error.status = 503;
        throw error;
    }

    console.log('Foursquare proxy request for:', ll, 'Accuracy:', hacc);

    let url = `https://places-api.foursquare.com/places/search?ll=${ll}&limit=15&radius=1000&sort=DISTANCE&categories=13000,10000,16000,19000&open_now=true`;
    if (hacc) url += `&hacc=${hacc}`;
    if (altitude) url += `&altitude=${altitude}`;

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${config.foursquare_key}`,
            Accept: 'application/json',
            'X-Places-Api-Version': '2025-06-17'
        }
    });

    if (response.status === 429) {
        const error = new Error('Foursquare credits exceeded');
        error.status = 429;
        throw error;
    }

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.message || 'Foursquare API failed');
        error.status = response.status;
        throw error;
    }

    const data = await response.json();
    return (data.results || []).map((fsq) => ({
        provider: PROVIDER_KEYS.foursquare,
        provider_label: getVenueProviderLabel(PROVIDER_KEYS.foursquare),
        place_provider_id: fsq.fsq_place_id || fsq.id || null,
        name: fsq.name,
        address: fsq.location?.formatted_address || 'Nearby',
        city: fsq.location?.locality || fsq.location?.region || null,
        latitude: fsq.geocodes?.main?.latitude ?? null,
        longitude: fsq.geocodes?.main?.longitude ?? null,
        distance: fsq.distance,
        categories: (fsq.categories || []).map((entry) => entry.name)
    }));
};

const findGoogleNearbyVenues = async ({ ll, hacc }) => {
    if (!config.google_places_key) {
        const error = new Error('Google Maps is not configured on the server');
        error.status = 503;
        throw error;
    }

    const [latRaw, lonRaw] = String(ll).split(',');
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const error = new Error('Latitude and longitude are required (ll=lat,lon)');
        error.status = 400;
        throw error;
    }

    const radius = Math.min(Math.max(Number(hacc || 120), 60), 1200);
    const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': config.google_places_key,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryTypeDisplayName,places.types,places.addressComponents'
        },
        body: JSON.stringify({
            maxResultCount: 15,
            includedTypes: ['restaurant', 'bar', 'night_club', 'cafe', 'hotel', 'shopping_mall'],
            rankPreference: 'DISTANCE',
            locationRestriction: {
                circle: {
                    center: {
                        latitude: lat,
                        longitude: lon
                    },
                    radius
                }
            }
        })
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.error?.message || payload.message || 'Google Places API failed');
        error.status = response.status;
        throw error;
    }

    const data = await response.json();
    return (data.places || []).map((place) => {
        const cityComponent = place.addressComponents?.find((component) => component.types?.includes('locality'));
        const target = {
            lat: place.location?.latitude ?? null,
            lon: place.location?.longitude ?? null,
        };

        return {
            provider: PROVIDER_KEYS.googleMaps,
            provider_label: getVenueProviderLabel(PROVIDER_KEYS.googleMaps),
            place_provider_id: place.id || null,
            name: place.displayName?.text || 'Nearby venue',
            address: place.formattedAddress || 'Nearby',
            city: cityComponent?.longText || null,
            latitude: place.location?.latitude ?? null,
            longitude: place.location?.longitude ?? null,
            distance: haversineDistanceMeters({ lat, lon }, target),
            categories: [
                place.primaryTypeDisplayName?.text,
                ...(place.types || [])
            ].filter(Boolean).slice(0, 4)
        };
    });
};

// Nearby Venues Proxy
app.get('/api/nearby-venues', async (req, res) => {
    try {
        const { ll, hacc, altitude } = req.query;
        const availableProviders = getAvailableVenueProviders();
        const requestedProvider = normalizeVenueProvider(req.query.provider);
        const provider = requestedProvider || availableProviders[0] || PROVIDER_KEYS.foursquare;

        if (!ll) {
            return res.status(400).json({ error: 'Latitude and longitude are required (ll=lat,lon)' });
        }

        if (!availableProviders.length) {
            return res.status(503).json({ error: 'No venue lookup providers are configured on the server' });
        }

        if (requestedProvider && !availableProviders.includes(requestedProvider)) {
            return res.status(503).json({ error: `${getVenueProviderLabel(requestedProvider)} is not configured on the server` });
        }

        const suggestions = provider === PROVIDER_KEYS.googleMaps
            ? await findGoogleNearbyVenues({ ll, hacc })
            : await findFoursquareNearbyVenues({ ll, hacc, altitude });

        res.json({
            provider,
            providerLabel: getVenueProviderLabel(provider),
            availableProviders,
            bestMatch: suggestions[0]?.name || null,
            suggestions
        });
    } catch (error) {
        console.error('Nearby venue lookup error:', error);
        res.status(error.status || 500).json({ error: error.message || 'Failed to fetch venues' });
    }
});

app.post('/api/forensic-report', upload.fields([{ name: 'audio', maxCount: 1 }]), async (req, res) => {
    try {
        if (!config.gemini_key) {
            return res.status(503).json({ error: 'Gemini API key is not configured on the server' });
        }

        const audioFile = req.files?.audio?.[0];
        if (!audioFile) {
            return res.status(400).json({ error: 'No audio snippet provided' });
        }

        const report = await generateForensicReport({
            audioBuffer: audioFile.buffer,
            audioMimeType: audioFile.mimetype,
            frameDataUrl: req.body.frame_data_url,
            mode: req.body.mode || 'detail',
            peakTime: Number(req.body.peak_time || 0)
        });

        res.json({ report });
    } catch (error) {
        console.error('Forensic report error:', error);
        res.status(500).json({ error: 'Failed to generate forensic report', details: error.message });
    }
});

app.post('/api/extract-audio', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded' });
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snitch-audio-'));
    const inputPath = path.join(tempDir, 'input' + path.extname(req.file.originalname));
    const outputPath = path.join(tempDir, 'output.wav');

    try {
        // Write uploaded file to temp location
        await fs.writeFile(inputPath, req.file.buffer);

        // Extract audio using FFmpeg
        await new Promise((resolve, reject) => {
            const ffmpeg = spawn(ffmpegPath, [
                '-i', inputPath,
                '-vn', // No video
                '-acodec', 'pcm_s16le', // PCM 16-bit
                '-ar', '44100', // Sample rate
                '-ac', '2', // Stereo
                '-f', 'wav', // WAV format
                outputPath
            ]);

            ffmpeg.stderr.on('data', (data) => {
                // FFmpeg outputs progress to stderr
                console.log(`FFmpeg: ${data.toString().trim()}`);
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`FFmpeg exited with code ${code}`));
                }
            });

            ffmpeg.on('error', reject);
        });

        // Read the extracted WAV file
        const wavBuffer = await fs.readFile(outputPath);

        // Clean up temp files
        await fs.unlink(inputPath);
        await fs.unlink(outputPath);
        await fs.rmdir(tempDir);

        // Return WAV binary
        res.set('Content-Type', 'audio/wav');
        res.set('Content-Length', wavBuffer.length);
        res.send(wavBuffer);

    } catch (error) {
        console.error('Audio extraction error:', error);

        // Clean up on error
        try {
            await fs.unlink(inputPath).catch(() => { });
            await fs.unlink(outputPath).catch(() => { });
            await fs.rmdir(tempDir).catch(() => { });
        } catch (cleanupError) {
            console.warn('Temp cleanup failed:', cleanupError.message);
        }

        res.status(500).json({ error: 'Failed to extract audio', details: error.message });
    }
});

const buildSignedSessionPayload = (payload) => ({
    captureSessionId: payload.captureSessionId,
    installId: payload.installId,
    localTime: payload.localTime,
    measuredOffsetMs: payload.measuredOffsetMs,
    geolocation: payload.geolocation,
    deviceSnapshot: payload.deviceSnapshot
});

const buildSignedFinalizePayload = (payload) => ({
    captureSessionId: payload.captureSessionId,
    submissionId: payload.submissionId,
    installId: payload.installId,
    mediaSha256: payload.mediaSha256,
    localEndTime: payload.localEndTime,
    measuredEndOffsetMs: payload.measuredEndOffsetMs,
    durationSeconds: payload.durationSeconds,
    geolocationEnd: payload.geolocationEnd
});

const cleanString = (value) => (value || '').trim().toLowerCase();
const normalizeMimeType = (mimeType) => String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
const inferMimeTypeFromFileName = (fileName) => {
    const extension = path.extname(fileName || '').toLowerCase();
    if (extension === '.webm') {
        return 'video/webm';
    }
    if (extension === '.mp4') {
        return 'video/mp4';
    }
    if (extension === '.mov' || extension === '.qt') {
        return 'video/quicktime';
    }
    return null;
};
const resolveAcceptedCaptureMimeType = ({ requestedMimeType, fallbackMimeType, fileName }) => {
    const normalizedRequested = normalizeMimeType(requestedMimeType);
    if (CAPTURE_POLICY.acceptedMimeTypes.includes(normalizedRequested)) {
        return normalizedRequested;
    }

    const normalizedFallback = normalizeMimeType(fallbackMimeType);
    if (CAPTURE_POLICY.acceptedMimeTypes.includes(normalizedFallback)) {
        return normalizedFallback;
    }

    const inferred = inferMimeTypeFromFileName(fileName);
    if (CAPTURE_POLICY.acceptedMimeTypes.includes(inferred)) {
        return inferred;
    }

    return null;
};
const isAcceptedCaptureMimeType = (mimeType) => CAPTURE_POLICY.acceptedMimeTypes.includes(normalizeMimeType(mimeType));

const deriveDeviceTrustBand = ({ abuseScore, startOffset, endOffset }) => {
    const maxSkew = Math.max(Math.abs(Number(startOffset || 0)), Math.abs(Number(endOffset || 0)));
    if (maxSkew > CLOCK_SKEW_TOLERANCE_MS || abuseScore >= 60) {
        return 'low';
    }
    if (abuseScore >= 25 || maxSkew > 2500) {
        return 'medium';
    }
    return 'high';
};

const getPresentationSignatureStatus = (submission) => {
    if (demoForceSignatureVerified) {
        return 'signed_and_verified';
    }

    return submission?.hasValidSignature ? 'signed_and_verified' : 'unsigned_or_unverified';
};

const scoreInstallAbuse = (install, submissions) => {
    const recentHour = submissions.filter((submission) => submission.installId === install.installId && Date.now() - new Date(submission.createdAt).getTime() < 60 * 60 * 1000).length;
    const recentDay = submissions.filter((submission) => submission.installId === install.installId && Date.now() - new Date(submission.createdAt).getTime() < 24 * 60 * 60 * 1000).length;
    let score = 0;

    if (recentHour > 3) {
        score += 25;
    }
    if (recentDay > 10) {
        score += 40;
    }
    if (install.submissionCount > 30) {
        score += 10;
    }

    return score;
};

const formatMatchedSong = (song) => {
    if (!song?.title) {
        return null;
    }

    return song.artist
        ? `${song.title} - ${song.artist}`
        : song.title;
};

const extractAudioFromFile = async (inputPath) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snitch-capture-'));
    const outputPath = path.join(tempDir, 'audio.wav');

    try {
        await new Promise((resolve, reject) => {
            const ffmpeg = spawn(ffmpegPath, [
                '-i', inputPath,
                '-vn',
                '-acodec', 'pcm_s16le',
                '-ar', '44100',
                '-ac', '1',
                '-f', 'wav',
                outputPath
            ]);

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`FFmpeg exited with code ${code}`));
                }
            });
            ffmpeg.on('error', reject);
        });

        return await fs.readFile(outputPath);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
};

const extractFrameAtTimestamp = async (inputPath, timestampSeconds) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snitch-frame-'));
    const outputPath = path.join(tempDir, 'frame.jpg');

    try {
        await new Promise((resolve, reject) => {
            const ffmpeg = spawn(ffmpegPath, [
                '-ss', `${Math.max(0, Number(timestampSeconds || 0)).toFixed(2)}`,
                '-i', inputPath,
                '-frames:v', '1',
                '-q:v', '2',
                outputPath
            ]);

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`FFmpeg frame extraction exited with code ${code}`));
                }
            });
            ffmpeg.on('error', reject);
        });

        return await fs.readFile(outputPath);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
};

const extractPeakFramesFromVideo = async (inputPath, peakWindows = []) => {
    const frames = [];

    for (const peakWindow of peakWindows) {
        try {
            const buffer = await extractFrameAtTimestamp(inputPath, peakWindow.timestampSeconds);
            frames.push({
                ...peakWindow,
                buffer,
                mimeType: 'image/jpeg',
                fileName: `peak-${peakWindow.rank}.jpg`
            });
        } catch (error) {
            console.warn(`Frame extraction failed at ${peakWindow.timestampSeconds}s:`, error.message);
        }
    }

    return frames;
};

const getStoredFrameAssetsForSubmission = (data, submission) => {
    const assetIds = Array.isArray(submission?.keyFrameAssetIds) && submission.keyFrameAssetIds.length
        ? submission.keyFrameAssetIds
        : Array.isArray(submission?.assetIds)
            ? submission.assetIds
            : [];

    return assetIds
        .map((assetId) => data.assets.find((asset) => asset.id === assetId) || null)
        .filter((asset) => asset?.kind === 'video-frame')
        .sort((left, right) => Number(left.metadata?.timestampSeconds || 0) - Number(right.metadata?.timestampSeconds || 0));
};

const buildStoredPeakWindows = ({ submission, reports = [], frameAssets = [] }) => {
    const existingPeakWindows = submission?.visualAnalysis?.peakWindows
        || reports.find((report) => Array.isArray(report.visualAnalysis?.peakWindows) && report.visualAnalysis.peakWindows.length)?.visualAnalysis?.peakWindows
        || null;
    if (existingPeakWindows?.length) {
        return existingPeakWindows;
    }

    return frameAssets.map((asset, index) => ({
        rank: Number(asset.metadata?.peakRank || index + 1),
        startSeconds: Number(asset.metadata?.startSeconds || asset.metadata?.timestampSeconds || 0),
        endSeconds: Number(asset.metadata?.endSeconds || asset.metadata?.timestampSeconds || 0),
        timestampSeconds: Number(asset.metadata?.timestampSeconds || 0),
        rms: Number(asset.metadata?.rms || 0),
        relativeIntensity: Number(asset.metadata?.relativeIntensity || 0),
        clipDurationSeconds: Number(asset.metadata?.clipDurationSeconds || submission?.durationSeconds || 0),
    }));
};

const loadStoredSubmissionFrames = async (data, submission) => {
    const frameAssets = getStoredFrameAssetsForSubmission(data, submission);
    const frames = [];

    for (const asset of frameAssets) {
        const assetPath = await getAssetAbsolutePath(asset.id);
        if (!assetPath) {
            continue;
        }

        try {
            const buffer = await fs.readFile(assetPath);
            frames.push({
                assetId: asset.id,
                buffer,
                mimeType: asset.mimeType || 'image/jpeg',
                fileName: asset.fileName || `${asset.id}.jpg`,
                timestampSeconds: Number(asset.metadata?.timestampSeconds || 0),
                rank: Number(asset.metadata?.peakRank || 0),
                relativeIntensity: Number(asset.metadata?.relativeIntensity || 0),
            });
        } catch (error) {
            console.warn(`Stored frame read failed for ${asset.id}:`, error.message);
        }
    }

    return {
        frameAssets,
        frames,
    };
};

const findGoogleNearbyVenue = async (geolocation) => {
    if (!config.google_places_key || !geolocation?.lat || !geolocation?.lon) {
        return null;
    }

    const suggestions = await findGoogleNearbyVenues({
        ll: `${Number(geolocation.lat)},${Number(geolocation.lon)}`,
        hacc: geolocation.accuracy
    });
    const place = suggestions[0];
    if (!place) {
        return null;
    }

    return {
        placeProviderId: place.place_provider_id,
        placeProvider: place.provider,
        name: place.name || 'Matched Venue',
        address: place.address || 'Unknown address',
        city: place.city || null,
        latitude: place.latitude ?? Number(geolocation.lat),
        longitude: place.longitude ?? Number(geolocation.lon)
    };
};

const upsertVenue = async (geolocation, selectedVenue = null) => mutatePlatformData(async (data) => {
    let nextVenue = null;

    if (selectedVenue?.name) {
        nextVenue = {
            placeProviderId: selectedVenue.placeProviderId || null,
            placeProvider: selectedVenue.provider || null,
            name: selectedVenue.name,
            address: selectedVenue.address || '',
            city: selectedVenue.city || null,
            latitude: selectedVenue.latitude != null ? Number(selectedVenue.latitude) : Number(geolocation?.lat ?? 0),
            longitude: selectedVenue.longitude != null ? Number(selectedVenue.longitude) : Number(geolocation?.lon ?? 0),
            fallbackKey: stableHash(`${cleanString(selectedVenue.name)}:${cleanString(selectedVenue.address || '')}`).slice(0, 12)
        };
    } else {
        try {
            nextVenue = await findGoogleNearbyVenue(geolocation);
        } catch (error) {
            console.warn('Google Places lookup failed:', error.message);
        }
    }

    if (!nextVenue && geolocation?.lat && geolocation?.lon) {
        const rounded = `${Number(geolocation.lat).toFixed(4)},${Number(geolocation.lon).toFixed(4)}`;
        const fallbackKey = stableHash(rounded).slice(0, 12);
        nextVenue = {
            placeProviderId: null,
            name: `Approx. Venue ${Number(geolocation.lat).toFixed(3)}, ${Number(geolocation.lon).toFixed(3)}`,
            address: rounded,
            city: null,
            latitude: Number(geolocation.lat),
            longitude: Number(geolocation.lon),
            fallbackKey
        };
    }

    if (!nextVenue) {
        return null;
    }

    const existing = data.venues.find((venue) => (
        nextVenue.placeProviderId
            ? venue.placeProviderId === nextVenue.placeProviderId
            : venue.fallbackKey === nextVenue.fallbackKey
    ));

    if (existing) {
        existing.name = nextVenue.name;
        existing.address = nextVenue.address;
        existing.city = nextVenue.city;
        existing.latitude = nextVenue.latitude;
        existing.longitude = nextVenue.longitude;
        existing.placeProvider = existing.placeProvider || nextVenue.placeProvider || null;
        existing.lastSeenAt = new Date().toISOString();
        return existing;
    }

    const venue = {
        id: crypto.randomUUID(),
        placeProviderId: nextVenue.placeProviderId,
        placeProvider: nextVenue.placeProvider || null,
        fallbackKey: nextVenue.fallbackKey || null,
        name: nextVenue.name,
        address: nextVenue.address,
        city: nextVenue.city,
        latitude: nextVenue.latitude,
        longitude: nextVenue.longitude,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString()
    };

    data.venues.push(venue);
    return venue;
});

const isSameCalendarMonth = (left, right) => {
    const leftDate = new Date(left);
    const rightDate = new Date(right);
    return leftDate.getUTCFullYear() === rightDate.getUTCFullYear()
        && leftDate.getUTCMonth() === rightDate.getUTCMonth();
};

const isDateWithinRange = (value, from, to) => {
    const target = new Date(value).getTime();
    if (from && target < new Date(from).getTime()) {
        return false;
    }
    if (to && target > new Date(to).getTime()) {
        return false;
    }
    return true;
};

const buildContributorPublicView = (contributor, data) => {
    if (!contributor) {
        return null;
    }

    const policy = getTrustTierPolicy(contributor.trustTier);
    const linkedInstalls = data.anonymousInstalls.filter((install) => install.contributorId === contributor.id).length;
    const currentMonthRewards = data.rewardLedger
        .filter((reward) => reward.contributorId === contributor.id && reward.status !== 'reversed' && isSameCalendarMonth(reward.createdAt, new Date().toISOString()))
        .reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0);

    return {
        id: contributor.id,
        displayName: contributor.displayName,
        trustTier: contributor.trustTier,
        trustTierLabel: policy.label,
        city: contributor.city || null,
        status: contributor.status,
        monthlyPayoutCapInr: policy.monthlyPayoutCapInr,
        linkedInstalls,
        currentMonthRewardsInr: currentMonthRewards
    };
};

const findContributorByInviteCode = (data, inviteCode) => {
    const normalized = normalizeInviteCode(inviteCode);
    if (!normalized) {
        return null;
    }
    return data.contributors.find((contributor) => contributor.status === 'active' && contributor.inviteCode === normalized) || null;
};

const getContributorByInstall = (data, installId) => {
    const install = data.anonymousInstalls.find((item) => item.installId === installId);
    if (!install?.contributorId) {
        return null;
    }
    return data.contributors.find((item) => item.id === install.contributorId) || null;
};

const getContributorMonthRewardTotal = (data, contributorId, referenceDate = new Date().toISOString()) => data.rewardLedger
    .filter((reward) => reward.contributorId === contributorId && reward.status !== 'reversed' && isSameCalendarMonth(reward.createdAt, referenceDate))
    .reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0);

const createRewardLedgerEntry = ({ data, caseRecord, report, contributor, stage, amountInr, createdAt, notes = '', metadata = {} }) => {
    if (!contributor || !amountInr) {
        return null;
    }

    const policy = getTrustTierPolicy(contributor.trustTier);
    const currentTotal = getContributorMonthRewardTotal(data, contributor.id, createdAt);
    const remainingCap = Math.max(policy.monthlyPayoutCapInr - currentTotal, 0);
    const finalAmount = Math.min(Number(amountInr || 0), remainingCap);

    if (!finalAmount) {
        return null;
    }

    const holdDays = stage === REWARD_STAGE_KEYS.outcomeBonus ? policy.outcomeHoldDays : policy.stage1HoldDays;

    const reward = {
        id: crypto.randomUUID(),
        reference: createReference('RWD'),
        caseId: caseRecord.id,
        reportId: report?.id || caseRecord.primaryReportId,
        submissionId: report?.submissionId || caseRecord.primarySubmissionId,
        contributorId: contributor.id,
        stage,
        amountInr: finalAmount,
        status: 'held',
        holdUntil: buildRewardHoldDate({ createdAt, holdDays }),
        trustTier: contributor.trustTier,
        monthlyPayoutCapInr: policy.monthlyPayoutCapInr,
        notes,
        metadata,
        createdAt,
        paidAt: null,
        reversedAt: null,
        reversalReason: null
    };
    data.rewardLedger.push(reward);
    return reward;
};

const reverseRewardEntriesForCase = (data, caseId, reason) => {
    data.rewardLedger.forEach((reward) => {
        if (reward.caseId === caseId && reward.status === 'held') {
            reward.status = 'reversed';
            reward.reversedAt = new Date().toISOString();
            reward.reversalReason = reason;
        }
    });
};

const findMerchantRecord = (data, venue) => {
    if (!venue) {
        return null;
    }

    return data.merchantMaster.find((merchant) => merchant.venueId === venue.id)
        || data.merchantMaster.find((merchant) => merchant.placeProviderId && merchant.placeProviderId === venue.placeProviderId)
        || data.merchantMaster.find((merchant) => cleanString(merchant.venueName) === cleanString(venue.name) && cleanString(merchant.address) === cleanString(venue.address))
        || null;
};

const ensureMerchantRecord = (data, venue) => {
    if (!venue) {
        return null;
    }

    const existing = findMerchantRecord(data, venue);
    if (existing) {
        existing.venueId = existing.venueId || venue.id;
        existing.placeProviderId = existing.placeProviderId || venue.placeProviderId || null;
        existing.venueName = existing.venueName || venue.name;
        existing.address = existing.address || venue.address || '';
        existing.city = existing.city || venue.city || null;
        existing.cityTier = existing.cityTier || getCityTier(existing.city || venue.city || '');
        existing.venueType = existing.venueType || inferVenueType(existing);
        existing.updatedAt = new Date().toISOString();
        return existing;
    }

    const merchant = {
        id: crypto.randomUUID(),
        venueId: venue.id,
        placeProviderId: venue.placeProviderId || null,
        venueName: venue.name,
        address: venue.address || '',
        city: venue.city || null,
        legalEntityName: null,
        gstin: null,
        cityTier: getCityTier(venue.city || ''),
        venueType: inferVenueType(venue),
        hotelStarClass: null,
        outletCount: 1,
        eventCapability: inferVenueType(venue) === 'event_property' ? 'event-led' : 'standard',
        rightsLayersApplicable: ['label', 'collective'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    data.merchantMaster.push(merchant);
    return merchant;
};

const resolveLicenseAssessment = (data, report, venue, capturedAt) => {
    if (!venue || !report.rightsOwnerOrgId) {
        return {
            status: 'unknown',
            source: 'unmatched-venue-or-org',
            validFrom: null,
            validTo: null,
            lastVerifiedAt: null
        };
    }

    const explicit = data.licenseStatus
        .filter((entry) => entry.venueId === venue.id && entry.orgId === report.rightsOwnerOrgId)
        .filter((entry) => isDateWithinRange(capturedAt, entry.validFrom || null, entry.validTo || null))
        .sort((left, right) => new Date(right.lastVerifiedAt || right.createdAt || 0) - new Date(left.lastVerifiedAt || left.createdAt || 0))[0];

    if (explicit) {
        return {
            status: explicit.status,
            source: explicit.evidenceSource || explicit.source || 'license-status',
            validFrom: explicit.validFrom || null,
            validTo: explicit.validTo || null,
            lastVerifiedAt: explicit.lastVerifiedAt || explicit.updatedAt || explicit.createdAt || null
        };
    }

    const coverage = data.venueCoverage.find((entry) => (
        entry.venueId === venue.id
        && entry.orgId === report.rightsOwnerOrgId
        && isDateWithinRange(capturedAt, entry.validFrom || null, entry.validTo || null)
    ));

    if (coverage) {
        return {
            status: 'licensed',
            source: coverage.source || 'venue-coverage',
            validFrom: coverage.validFrom || null,
            validTo: coverage.validTo || null,
            lastVerifiedAt: coverage.createdAt || null
        };
    }

    return {
        status: 'unknown',
        source: 'no-license-record',
        validFrom: null,
        validTo: null,
        lastVerifiedAt: null
    };
};

const resolveApplicableTariffs = (data, report, merchant, capturedAt) => {
    if (!merchant) {
        return [];
    }

    const venueType = merchant.venueType || inferVenueType(merchant);
    const cityTier = merchant.cityTier || getCityTier(merchant.city || '');

    return data.tariffTable.filter((tariff) => {
        if (tariff.orgId && tariff.orgId !== report.rightsOwnerOrgId) {
            return false;
        }
        if (tariff.rightsLayer && tariff.rightsLayer !== report.rightsType) {
            return false;
        }
        if (tariff.venueType && tariff.venueType !== venueType) {
            return false;
        }
        if (tariff.cityTier && tariff.cityTier !== cityTier) {
            return false;
        }
        return isDateWithinRange(capturedAt, tariff.effectiveFrom || null, tariff.effectiveTo || null);
    });
};

const findCaseForReport = (data, reportId) => data.caseLedger.find((entry) => entry.reportIds?.includes(reportId)) || null;

const buildCaseForReport = ({ data, report, submission, contributor, venue, createdAt }) => {
    const merchant = ensureMerchantRecord(data, venue);
    const licenseAssessment = resolveLicenseAssessment(data, report, venue, createdAt);
    const tariffs = resolveApplicableTariffs(data, report, merchant, createdAt);
    const valueModel = estimateRecoverableValue({
        merchant,
        tariffs,
        licenseStatus: licenseAssessment.status
    });
    const rewardEligible = Boolean(
        contributor
        && report.rightsOwnerOrgId
        && venue?.id
        && isStatusActionableForRewards(licenseAssessment.status)
    );
    const existingCase = data.caseLedger.find((entry) => (
        entry.venueId === venue?.id
        && entry.rightsOwnerOrgId === report.rightsOwnerOrgId
        && (Date.now() - new Date(entry.createdAt).getTime()) <= 30 * 24 * 60 * 60 * 1000
    )) || null;

    report.merchantMasterId = merchant?.id || null;
    report.licenseAssessment = licenseAssessment;
    report.estimatedRecoverableValueInr = valueModel.estimatedValueInr;
    report.rewardEligibility = rewardEligible;

    if (existingCase) {
        existingCase.reportIds = [...new Set([...(existingCase.reportIds || []), report.id])];
        existingCase.evidenceCount = existingCase.reportIds.length;
        existingCase.corroborationReportIds = [...new Set([...(existingCase.corroborationReportIds || []), report.id])];
        existingCase.updatedAt = createdAt;
        if (!existingCase.estimatedRecoverableValueInr || existingCase.estimatedRecoverableValueInr < valueModel.estimatedValueInr) {
            existingCase.estimatedRecoverableValueInr = valueModel.estimatedValueInr;
            existingCase.tariffIds = tariffs.map((tariff) => tariff.id);
            existingCase.collectionProbability = valueModel.collectionProbability;
            existingCase.nonComplianceMultiplier = valueModel.nonComplianceMultiplier;
            existingCase.planningBand = valueModel.planningBand.label;
        }

        report.caseId = existingCase.id;
        report.rewardDisposition = rewardEligible ? 'corroboration_manual_only' : 'not_reward_eligible';
        return { caseRecord: existingCase, merchant, rewardEligible: false, licenseAssessment };
    }

    const caseRecord = {
        id: crypto.randomUUID(),
        reference: createReference('CASE'),
        venueId: venue?.id || null,
        rightsOwnerOrgId: report.rightsOwnerOrgId,
        rightsType: report.rightsType,
        primaryContributorId: contributor?.id || null,
        primaryInstallId: submission.installId,
        primaryReportId: report.id,
        primarySubmissionId: submission.id,
        reportIds: [report.id],
        corroborationReportIds: [],
        evidenceCount: 1,
        merchantMasterId: merchant?.id || null,
        licenseStatus: licenseAssessment.status,
        licenseSource: licenseAssessment.source,
        rewardEligible,
        caseStatus: rewardEligible ? 'actionable' : licenseAssessment.status === 'licensed' ? 'licensed' : 'pending_license_verification',
        planningBand: valueModel.planningBand.label,
        estimatedRecoverableValueInr: valueModel.estimatedValueInr,
        realizedValueInr: 0,
        settlementSignedAt: null,
        outcomeType: null,
        tariffIds: tariffs.map((tariff) => tariff.id),
        collectionProbability: valueModel.collectionProbability,
        nonComplianceMultiplier: valueModel.nonComplianceMultiplier,
        createdAt,
        updatedAt: createdAt
    };
    data.caseLedger.push(caseRecord);

    report.caseId = caseRecord.id;
    report.rewardDisposition = rewardEligible ? 'primary' : 'not_reward_eligible';
    return { caseRecord, merchant, rewardEligible, licenseAssessment };
};

const ensureStageRewardsForCase = ({ data, caseRecord, report, contributor, merchant, createdAt, verdict }) => {
    if (!caseRecord.rewardEligible || !contributor) {
        return;
    }

    const existingStage1 = data.rewardLedger.find((reward) => reward.caseId === caseRecord.id && reward.stage === REWARD_STAGE_KEYS.qualifiedProof && reward.status !== 'reversed');
    if (!existingStage1) {
        createRewardLedgerEntry({
            data,
            caseRecord,
            report,
            contributor,
            stage: REWARD_STAGE_KEYS.qualifiedProof,
            amountInr: getStageOneAmount(),
            createdAt,
            notes: 'Stage 1 qualified proof hold'
        });
    }

    if (verdict === 'confirmed') {
        const existingStage2 = data.rewardLedger.find((reward) => reward.caseId === caseRecord.id && reward.stage === REWARD_STAGE_KEYS.confirmedActionable && reward.status !== 'reversed');
        if (!existingStage2) {
            createRewardLedgerEntry({
                data,
                caseRecord,
                report,
                contributor,
                stage: REWARD_STAGE_KEYS.confirmedActionable,
                amountInr: getStageTwoAmount(merchant),
                createdAt,
                notes: 'Stage 2 analyst-confirmed actionable proof'
            });
        }
    }
};

const getRewardBreakdownForCase = (data, caseId) => {
    const rewards = data.rewardLedger.filter((reward) => reward.caseId === caseId);
    return {
        rewards,
        heldAmountInr: rewards.filter((reward) => reward.status === 'held').reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0),
        paidAmountInr: rewards.filter((reward) => reward.status === 'paid').reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0),
        reversedAmountInr: rewards.filter((reward) => reward.status === 'reversed').reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0)
    };
};

const findOrCreateVenueFromRecord = (data, record) => {
    let venue = null;

    if (record.venue_id) {
        venue = data.venues.find((item) => item.id === record.venue_id) || null;
    }

    if (!venue && record.place_provider_id) {
        venue = data.venues.find((item) => item.placeProviderId === record.place_provider_id) || null;
    }

    if (!venue && record.venue_name) {
        venue = data.venues.find((item) => (
            cleanString(item.name) === cleanString(record.venue_name)
            && cleanString(item.address) === cleanString(record.address || item.address || '')
        )) || null;
    }

    if (!venue && record.venue_name) {
        venue = {
            id: crypto.randomUUID(),
            placeProviderId: record.place_provider_id || null,
            fallbackKey: stableHash(`${cleanString(record.venue_name)}:${cleanString(record.address || '')}`).slice(0, 12),
            name: record.venue_name,
            address: record.address || '',
            city: record.city || null,
            latitude: record.latitude ? Number(record.latitude) : null,
            longitude: record.longitude ? Number(record.longitude) : null,
            createdAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString()
        };
        data.venues.push(venue);
    }

    return venue;
};

const buildRewardProgramResponse = (data, contributor) => {
    const publicContributor = buildContributorPublicView(contributor, data);
    return {
        mode: 'invite_only',
        rewardsEligible: Boolean(publicContributor),
        contributor: publicContributor,
        criteria: [
            'Evidence must pass quality checks',
            'Venue must be matched with confidence',
            'Relevant rights layer must apply',
            'Venue must be unlicensed or expired for the matched rights owner',
            'Duplicates and low-value corroboration do not auto-pay'
        ]
    };
};

const buildCaseView = (data, caseRecord) => {
    if (!caseRecord) {
        return null;
    }

    const merchant = caseRecord.merchantMasterId ? data.merchantMaster.find((item) => item.id === caseRecord.merchantMasterId) || null : null;
    const contributor = caseRecord.primaryContributorId ? data.contributors.find((item) => item.id === caseRecord.primaryContributorId) || null : null;
    const rewardBreakdown = getRewardBreakdownForCase(data, caseRecord.id);

    return {
        ...caseRecord,
        merchant,
        contributor: buildContributorPublicView(contributor, data),
        rewardSummary: {
            heldAmountInr: rewardBreakdown.heldAmountInr,
            paidAmountInr: rewardBreakdown.paidAmountInr,
            reversedAmountInr: rewardBreakdown.reversedAmountInr
        },
        rewards: rewardBreakdown.rewards
    };
};

const buildRewardsOverview = (data) => {
    const totalEstimatedRecoverableValueInr = data.caseLedger.reduce((sum, entry) => sum + Number(entry.estimatedRecoverableValueInr || 0), 0);
    const totalRealizedValueInr = data.caseLedger.reduce((sum, entry) => sum + Number(entry.realizedValueInr || 0), 0);
    const heldRewardsInr = data.rewardLedger.filter((reward) => reward.status === 'held').reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0);
    const paidRewardsInr = data.rewardLedger.filter((reward) => reward.status === 'paid').reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0);
    const actionableCases = data.caseLedger.filter((entry) => entry.rewardEligible).length;
    const confirmedCases = data.caseLedger.filter((entry) => {
        const primaryReport = data.reports.find((report) => report.id === entry.primaryReportId);
        return primaryReport?.analystStatus === 'confirmed';
    }).length;
    const duplicateRate = data.caseLedger.length
        ? Number((data.caseLedger.filter((entry) => (entry.corroborationReportIds || []).length > 0).length / data.caseLedger.length).toFixed(2))
        : 0;
    const confirmationRate = actionableCases ? Number((confirmedCases / actionableCases).toFixed(2)) : 0;
    const unlicensedHitRate = data.reports.length
        ? Number((data.caseLedger.filter((entry) => entry.licenseStatus === 'unlicensed' || entry.licenseStatus === 'expired').length / data.reports.length).toFixed(2))
        : 0;

    return {
        summary: {
            contributors: data.contributors.length,
            linkedInstalls: data.anonymousInstalls.filter((install) => install.contributorId).length,
            actionableCases,
            totalEstimatedRecoverableValueInr,
            totalRealizedValueInr,
            heldRewardsInr,
            paidRewardsInr,
            duplicateRate,
            confirmationRate,
            unlicensedHitRate
        },
        contributors: data.contributors
            .map((contributor) => buildContributorPublicView(contributor, data))
            .sort((left, right) => right.currentMonthRewardsInr - left.currentMonthRewardsInr),
        recentCases: data.caseLedger
            .slice()
            .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
            .slice(0, 10)
            .map((entry) => buildCaseView(data, entry)),
        recentRewards: data.rewardLedger
            .slice()
            .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
            .slice(0, 10)
    };
};

const buildFallbackForensicSummary = (song, submission) => [
    `- Clip captured for ${submission.durationSeconds.toFixed(1)} seconds.`,
    song?.title ? `- Identified track candidate: ${song.title} by ${song.artist}.` : '- Track identification is unavailable.',
    `- Recorder clock skew stayed within ${Math.round(Math.max(Math.abs(submission.measuredStartOffsetMs || 0), Math.abs(submission.measuredEndOffsetMs || 0)))}ms.`,
    `Conclusion: Evidence package is ready for analyst review.`
].join('\n');

const findMatchedTracks = (data, song) => data.catalogTracks.filter((track) => (
    cleanString(track.title) === cleanString(song?.title) &&
    cleanString(track.artist) === cleanString(song?.artist)
));

const buildReportTargets = (data, song, venue) => {
    const targets = [];
    const matchedTracks = findMatchedTracks(data, song);

    for (const track of matchedTracks) {
        targets.push({
            rightsOwnerOrgId: track.orgId,
            rightsType: 'label',
            matchedTrackId: track.id,
            matchedTrackConfidence: 0.95
        });
    }

    for (const org of data.orgs.filter((item) => item.type === 'collective')) {
        const orgCode = cleanString(org.portalSettings?.proCode || org.name);
        const songCode = cleanString(song?.rights_org);
        const hasVenueCoverage = venue && data.venueCoverage.some((coverage) => coverage.orgId === org.id && coverage.venueId === venue.id);

        if (orgCode && songCode && orgCode === songCode) {
            targets.push({
                rightsOwnerOrgId: org.id,
                rightsType: 'collective',
                matchedTrackId: null,
                matchedTrackConfidence: 0.7
            });
        } else if (hasVenueCoverage) {
            targets.push({
                rightsOwnerOrgId: org.id,
                rightsType: 'collective',
                matchedTrackId: null,
                matchedTrackConfidence: 0.45
            });
        }
    }

    if (!targets.length) {
        targets.push({
            rightsOwnerOrgId: null,
            rightsType: null,
            matchedTrackId: null,
            matchedTrackConfidence: 0.25
        });
    }

    const deduped = new Map();
    for (const target of targets) {
        const key = `${target.rightsOwnerOrgId || 'unassigned'}:${target.rightsType || 'unknown'}`;
        if (!deduped.has(key) || deduped.get(key).matchedTrackConfidence < target.matchedTrackConfidence) {
            deduped.set(key, target);
        }
    }

    return [...deduped.values()];
};

const processSubmission = async (submissionId) => {
    if (processingSubmissions.has(submissionId)) {
        return;
    }

    processingSubmissions.add(submissionId);

    try {
        await mutatePlatformData((data) => {
            const submission = data.submissions.find((item) => item.id === submissionId);
            if (submission) {
                submission.status = 'processing';
                submission.processingStartedAt = new Date().toISOString();
            }
        });

        const data = await readPlatformData();
        const submission = data.submissions.find((item) => item.id === submissionId);
        if (!submission) {
            throw new Error('Submission not found');
        }

        const rawAsset = await ensureAssetRecord({
            assetId: submission.rawVideoAssetId,
            kind: 'raw-video',
            fileName: submission.fileName,
            mimeType: submission.uploadedMimeType || submission.mimeType,
            metadata: { submissionId }
        });
        const rawAssetPath = await getAssetAbsolutePath(submission.rawVideoAssetId);
        if (!rawAsset || !rawAssetPath) {
            throw new Error('Raw video asset missing');
        }

        // Verify the uploaded file matches the hash the client committed to at finalize.
        if (submission.mediaSha256) {
            const rawFileBuffer = await fs.readFile(rawAssetPath);
            const computedHash = crypto.createHash('sha256').update(rawFileBuffer).digest('hex');
            if (computedHash !== submission.mediaSha256) {
                await mutatePlatformData((data) => {
                    const s = data.submissions.find((item) => item.id === submissionId);
                    if (s) {
                        s.integrityFlag = 'hash_mismatch';
                        s.integrityComputedHash = computedHash;
                    }
                });
                throw new Error(`Media integrity check failed: hash mismatch (expected ${submission.mediaSha256.slice(0, 12)}…)`);
            }
        }

        const audioBuffer = await extractAudioFromFile(rawAssetPath);
        let analysisAudioBuffer = audioBuffer;
        let analysisAudioFileName = `${submission.reference}.wav`;
        let analysisStem = null;
        let fingerprintStem = null;
        let audioDeconstruction = null;
        let deconstructionResult = null;
        let savedStemAssets = {};
        let audioDeconstructionError = null;
        let selectedIsolationPass = 'raw_only';
        let currentFingerprintRun = null;
        let historicalFingerprintRun = null;
        let historicalJobCount = 0;
        let allFingerprintAttempts = [];
        let allFingerprintCandidates = [];

        try {
            const isolationPasses = buildIsolationPasses({
                audioBuffer,
                reference: submission.reference,
            });
            let firstDeconstructionError = null;

            for (const pass of isolationPasses) {
                try {
                    const passDeconstruction = await requestAudioDeconstruction({
                        audioBuffer: pass.audioBuffer,
                        fileName: pass.fileName,
                        mimeType: 'audio/wav',
                    });
                    let passRun = {
                        result: { ok: false },
                        matchedCandidate: null,
                        attempts: [],
                        candidates: [],
                        fingerprintStem: null,
                        sourceType: 'current',
                        passLabel: pass.label,
                        jobId: passDeconstruction.jobId || null,
                    };

                    if (config.host && config.access_key && config.access_secret) {
                        passRun = await evaluateFingerprintRun({
                            audioBuffer,
                            reference: submission.reference,
                            deconstructionResult: passDeconstruction,
                            includeRawSource: true,
                            sourceType: 'current',
                            passLabel: pass.label,
                        });
                    }

                    passRun.deconstructionResult = passDeconstruction;
                    allFingerprintAttempts.push(...passRun.attempts);
                    allFingerprintCandidates.push(...passRun.candidates);
                    currentFingerprintRun = pickBetterFingerprintRun(currentFingerprintRun, passRun);
                } catch (error) {
                    if (!firstDeconstructionError) {
                        firstDeconstructionError = error;
                    }
                }
            }

            if (currentFingerprintRun?.deconstructionResult) {
                deconstructionResult = currentFingerprintRun.deconstructionResult;
                selectedIsolationPass = currentFingerprintRun.passLabel || 'original';
                savedStemAssets = await saveStemAssetsFromDeconstruction({
                    submissionId,
                    reference: submission.reference,
                    deconstructionResult,
                });

                if (deconstructionResult.preferredStem && deconstructionResult.stems[deconstructionResult.preferredStem]) {
                    analysisStem = deconstructionResult.preferredStem;
                    analysisAudioBuffer = deconstructionResult.stems[analysisStem].buffer;
                    analysisAudioFileName = `${submission.reference}-${analysisStem}.wav`;
                }
            } else if (firstDeconstructionError) {
                throw firstDeconstructionError;
            }
        } catch (error) {
            audioDeconstructionError = error.message;
            console.warn('Audio deconstruction unavailable:', error.message);
        }

        const peakWindows = selectPeakWindows(analysisAudioBuffer);
        let sourceAnalysis = null;
        try {
            sourceAnalysis = analyzeAudioSource(audioBuffer, {
                mode: submission.sourceClassifierMode || DEFAULT_SOURCE_CLASSIFIER_MODE,
            });
        } catch (error) {
            console.warn('Audio source analysis failed:', error.message);
        }

        const extractedFrames = await extractPeakFramesFromVideo(rawAssetPath, peakWindows);
        const representativeFrameDataUrl = extractedFrames[0]
            ? bufferToDataUrl(extractedFrames[0].buffer, extractedFrames[0].mimeType)
            : null;

        const audioAsset = await saveAsset({
            buffer: audioBuffer,
            fileName: `${submission.reference}.wav`,
            mimeType: 'audio/wav',
            kind: 'derived-audio',
            metadata: { submissionId }
        });

        const frameAssets = await Promise.all(extractedFrames.map((frame) => saveAsset({
            buffer: frame.buffer,
            fileName: `${submission.reference}-peak-${frame.rank}.jpg`,
            mimeType: frame.mimeType,
            kind: 'video-frame',
            metadata: {
                submissionId,
                timestampSeconds: frame.timestampSeconds,
                peakRank: frame.rank,
                relativeIntensity: frame.relativeIntensity,
            }
        })));

        let songIdentity = { ok: false };
        let songIdentityCandidates = allFingerprintCandidates;
        let songIdentityAttempts = allFingerprintAttempts;
        let bestSongIdentityRecord = submission.bestSongIdentity || null;
        let chosenFingerprintRun = currentFingerprintRun;
        if (config.host && config.access_key && config.access_secret) {
            if (!chosenFingerprintRun) {
                const rawFallbackRun = await evaluateFingerprintRun({
                    audioBuffer,
                    reference: submission.reference,
                    deconstructionResult: null,
                    includeRawSource: true,
                    sourceType: 'raw_fallback',
                    passLabel: 'raw_fallback',
                });
                chosenFingerprintRun = rawFallbackRun;
                allFingerprintAttempts.push(...rawFallbackRun.attempts);
                allFingerprintCandidates.push(...rawFallbackRun.candidates);
                songIdentityCandidates = rawFallbackRun.candidates;
                songIdentityAttempts = rawFallbackRun.attempts;
            }

            if (!chosenFingerprintRun?.result?.ok) {
                const historicalStemJobs = await loadHistoricalStemJobs({ data, submissionId });
                historicalJobCount = historicalStemJobs.length;
                for (const historicalJob of historicalStemJobs) {
                    const historicalRun = await evaluateFingerprintRun({
                        audioBuffer,
                        reference: submission.reference,
                        deconstructionResult: historicalJob,
                        includeRawSource: false,
                        sourceType: 'historical',
                        passLabel: historicalJob.jobId || 'historical',
                    });
                    allFingerprintAttempts.push(...historicalRun.attempts);
                    historicalFingerprintRun = pickBetterFingerprintRun(historicalFingerprintRun, historicalRun);
                }
            }

            chosenFingerprintRun = pickBetterFingerprintRun(chosenFingerprintRun, historicalFingerprintRun);
            songIdentity = chosenFingerprintRun?.result || { ok: false };
            songIdentityCandidates = currentFingerprintRun?.candidates || songIdentityCandidates;
            songIdentityAttempts = allFingerprintAttempts;
            if (chosenFingerprintRun?.matchedCandidate) {
                fingerprintStem = chosenFingerprintRun.matchedCandidate.stem === 'raw'
                    ? null
                    : chosenFingerprintRun.matchedCandidate.stem;
            }

            if (chosenFingerprintRun?.result?.ok) {
                bestSongIdentityRecord = pickBetterBestSongIdentityRecord(
                    bestSongIdentityRecord,
                    buildBestSongIdentityRecord({
                        song: chosenFingerprintRun.result.data,
                        matchedCandidate: chosenFingerprintRun.matchedCandidate,
                        sourceType: chosenFingerprintRun.sourceType,
                        jobId: chosenFingerprintRun.jobId,
                        passLabel: chosenFingerprintRun.passLabel,
                    })
                );
            }

            if (!songIdentity.ok && bestSongIdentityRecord?.song?.title) {
                songIdentity = {
                    ok: true,
                    data: bestSongIdentityRecord.song,
                };
                fingerprintStem = bestSongIdentityRecord?.matchedCandidate?.stem === 'raw'
                    ? null
                    : (bestSongIdentityRecord?.matchedCandidate?.stem || fingerprintStem);
            }
        }

        const song = songIdentity.ok ? songIdentity.data : null;
        audioDeconstruction = buildAudioDeconstructionRecord({
            attempted: Boolean(deconstructionResult || audioDeconstructionError),
            deconstruction: deconstructionResult,
            savedStemAssets,
            fingerprintStem,
            peakSelectionStem: analysisStem,
            fingerprintCandidates: songIdentityCandidates,
            fingerprintAttempts: songIdentityAttempts,
            error: audioDeconstructionError,
            summaryOverride: deconstructionResult
                ? `Demucs ${selectedIsolationPass} pass separated ${Object.keys(savedStemAssets).join(', ')}. ${analysisStem ? `${analysisStem} was used for peak selection. ` : ''}${fingerprintStem ? `${fingerprintStem} produced the strongest fingerprint result. ` : 'No current-pass fingerprint resolved cleanly. '}${historicalJobCount ? `${historicalJobCount} historical stem job(s) were also checked.` : ''}`.trim()
                : null,
        });
        const venue = await upsertVenue(submission.geolocationEnd || submission.geolocationStart, submission.selectedVenue || null);
        const forensicSummary = config.gemini_key
            ? await generateForensicReport({
                audioBuffer,
                audioMimeType: 'audio/wav',
                mode: 'summary',
                peakTime: peakWindows[0]?.timestampSeconds ?? submission.durationSeconds / 2,
                frameDataUrl: representativeFrameDataUrl,
            }).catch(() => buildFallbackForensicSummary(song, submission))
            : buildFallbackForensicSummary(song, submission);
        const visualAnalysis = config.gemini_key
            ? await generateVisualEvidenceAssessment({
                frames: extractedFrames,
                peakWindows,
                song,
                venue,
                sourceAnalysis,
            }).catch(() => buildFallbackVisualAnalysis({ peakWindows, sourceAnalysis, frames: extractedFrames }))
            : buildFallbackVisualAnalysis({ peakWindows, sourceAnalysis, frames: extractedFrames });

        await mutatePlatformData(async (draft) => {
            const submissionRecord = draft.submissions.find((item) => item.id === submissionId);
            const install = draft.anonymousInstalls.find((item) => item.installId === submissionRecord.installId);
            const targets = buildReportTargets(draft, song, venue);
            const contributor = install?.contributorId
                ? draft.contributors.find((item) => item.id === install.contributorId) || null
                : null;
            const reportCreatedAt = new Date().toISOString();
            let applicationAssessment = null;

            draft.reports = draft.reports.filter((report) => report.submissionId !== submissionId);

            const newReports = targets.map((target) => ({
                id: crypto.randomUUID(),
                reference: createReference('REP'),
                submissionId,
                venueId: venue?.id || null,
                placeProviderId: venue?.placeProviderId || null,
                matchedTrackId: target.matchedTrackId,
                matchedTrackConfidence: target.matchedTrackConfidence,
                rightsOwnerOrgId: target.rightsOwnerOrgId,
                rightsType: target.rightsType,
                title: song?.title || 'Unknown Track',
                artist: song?.artist || 'Unknown Artist',
                label: song?.label || 'Unknown Label',
                rightsOrg: song?.rights_org || null,
                forensicSummary,
                sourceAnalysis,
                visualAnalysis: {
                    ...visualAnalysis,
                    peakWindows,
                },
                applicationAssessment: null,
                deviceTrustBand: deriveDeviceTrustBand({
                    abuseScore: install?.abuseScore || 0,
                    startOffset: submissionRecord.measuredStartOffsetMs,
                    endOffset: submissionRecord.measuredEndOffsetMs
                }),
                merchantMasterId: null,
                caseId: null,
                rewardEligibility: false,
                rewardDisposition: 'pending_license_verification',
                estimatedRecoverableValueInr: 0,
                licenseAssessment: {
                    status: 'unknown',
                    source: 'pending'
                },
                analystStatus: 'unreviewed',
                exportStatus: 'not_exported',
                createdAt: reportCreatedAt,
                updatedAt: reportCreatedAt
            }));

            for (const report of newReports) {
                const { caseRecord, merchant, rewardEligible } = buildCaseForReport({
                    data: draft,
                    report,
                    submission: submissionRecord,
                    contributor,
                    venue,
                    createdAt: reportCreatedAt
                });

                if (!applicationAssessment) {
                    const context = buildApplicationAssessmentContext({
                        data: draft,
                        report,
                        submission: submissionRecord,
                        venue,
                        merchant,
                        caseRecord,
                        contributor,
                        sourceAnalysis,
                        visualAnalysis: {
                            ...visualAnalysis,
                            peakWindows,
                        },
                        forensicSummary,
                        radioEvidence: submissionRecord.radioEvidence || null,
                    });

                    applicationAssessment = config.gemini_key
                        ? await generateApplicationAssessment({
                            context,
                            frames: extractedFrames,
                            generateText: generateGeminiText,
                        }).catch(() => buildFallbackApplicationAssessment(context))
                        : buildFallbackApplicationAssessment(context);
                }

                report.applicationAssessment = applicationAssessment;

                if (rewardEligible) {
                    ensureStageRewardsForCase({
                        data: draft,
                        caseRecord,
                        report,
                        contributor,
                        merchant,
                        createdAt: reportCreatedAt
                    });
                }
            }

            draft.reports.push(...newReports);
            submissionRecord.status = 'ready';
            submissionRecord.processingCompletedAt = new Date().toISOString();
            submissionRecord.derivedAudioAssetId = audioAsset.id;
            submissionRecord.audioDeconstruction = audioDeconstruction;
            submissionRecord.keyFrameAssetIds = frameAssets.map((asset) => asset.id);
            submissionRecord.reportIds = newReports.map((report) => report.id);
            submissionRecord.songIdentity = song;
            submissionRecord.songIdentityAttempts = summarizeSongIdentityAttempts(songIdentityAttempts);
            submissionRecord.bestSongIdentity = bestSongIdentityRecord;
            submissionRecord.matchedSong = formatMatchedSong(song);
            submissionRecord.venueId = venue?.id || null;
            submissionRecord.matchedVenue = venue?.name || submissionRecord.matchedVenue || null;
            submissionRecord.sourceAnalysis = sourceAnalysis;
            submissionRecord.visualAnalysis = {
                ...visualAnalysis,
                peakWindows,
            };
            submissionRecord.applicationAssessment = applicationAssessment;
            submissionRecord.processingError = null;
        });
    } catch (error) {
        console.error('Submission processing failed:', error);
        await mutatePlatformData((data) => {
            const submission = data.submissions.find((item) => item.id === submissionId);
            if (submission) {
                submission.status = 'failed';
                submission.processingError = error.message;
            }
        });
    } finally {
        processingSubmissions.delete(submissionId);
    }
};

const queueSubmissionProcessing = (submissionId) => {
    setTimeout(() => {
        processSubmission(submissionId).catch((error) => {
            console.error('Queued submission processing failed:', error);
        });
    }, 0);
};

const pickFirstDefined = (...values) => values.find((value) => value !== undefined);

const parseMaybeJson = (value) => {
    if (value == null) {
        return null;
    }

    if (typeof value === 'object') {
        return value;
    }

    if (typeof value !== 'string') {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

const pickBooleanLike = (value) => (value === true || value === false ? value : null);
const pickNumberLike = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};
const pickStringLike = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const SOURCE_REVIEW_LABELS = new Set([
    'likely_pa_system',
    'likely_small_speaker',
    'likely_personal_device',
    'inconclusive'
]);

const normalizeSourceReviewInput = (payload) => {
    const reviewedClass = pickStringLike(
        pickFirstDefined(
            payload?.reviewedClass,
            payload?.reviewed_class,
            payload?.label,
            payload?.sourceClass,
            payload?.source_class
        )
    );

    if (!reviewedClass) {
        throw new Error('Source review label is required');
    }

    if (!SOURCE_REVIEW_LABELS.has(reviewedClass)) {
        throw new Error(`Invalid source review label: ${reviewedClass}`);
    }

    return {
        reviewedClass,
        notes: String(pickFirstDefined(payload?.notes, payload?.note, '') || '').trim(),
    };
};

const getSourceReviewsForReport = (data, reportId) => (Array.isArray(data.sourceReviews)
    ? data.sourceReviews
        .filter((item) => item.reportId === reportId)
        .sort((left, right) => new Date(right.reviewedAt || 0) - new Date(left.reviewedAt || 0))
    : []);

const createSourceReviewEntry = ({ report, reviewerId, input, reviewedAt }) => {
    const predictedClass = report.sourceAnalysis?.sourceClass || null;
    return {
        id: crypto.randomUUID(),
        reportId: report.id,
        reviewerId,
        reviewedClass: input.reviewedClass,
        notes: input.notes || '',
        reviewedAt,
        predictedClass,
        predictedConfidence: report.sourceAnalysis?.confidence ?? null,
        predictedScore: report.sourceAnalysis?.score ?? null,
        predictedModelVersion: report.sourceAnalysis?.modelVersion || null,
        analystStatusAtReview: report.analystStatus || null,
        isOverride: Boolean(predictedClass) && input.reviewedClass !== predictedClass,
    };
};

const toIdentifierList = (value) => (Array.isArray(value) ? value : [value])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);

const findReportByIdentifier = (data, identifier) => data.reports.find((report) => report.id === identifier || report.reference === identifier) || null;

const findSubmissionByIdentifier = (data, identifier) => data.submissions.find((submission) => submission.id === identifier || submission.reference === identifier) || null;

const buildSongContextForAssessment = (submission, report) => submission?.songIdentity || {
    title: report?.title || 'Unknown Track',
    artist: report?.artist || 'Unknown Artist',
    label: report?.label || 'Unknown Label',
};

const shouldUseGeminiForRescore = (useGemini = true) => useGemini && Boolean(config.gemini_key);

async function recomputeSubmissionAssessments({
    data,
    submission,
    refreshVisualAnalysis = true,
    useGemini = true,
    requestedAt = new Date().toISOString(),
}) {
    if (!submission) {
        throw new Error('Submission is required for rescore.');
    }

    const relatedReports = data.reports.filter((report) => report.submissionId === submission.id);
    if (!relatedReports.length) {
        throw new Error(`No reports found for submission ${submission.reference || submission.id}.`);
    }

    const contributor = submission.installId ? getContributorByInstall(data, submission.installId) : null;
    const sourceAnalysis = submission.sourceAnalysis || relatedReports.find((report) => report.sourceAnalysis)?.sourceAnalysis || null;
    const primaryReport = relatedReports[0];
    const primaryVenue = primaryReport?.venueId ? data.venues.find((venue) => venue.id === primaryReport.venueId) || null : null;
    const merchant = primaryReport?.merchantMasterId
        ? data.merchantMaster.find((entry) => entry.id === primaryReport.merchantMasterId) || null
        : null;
    const song = buildSongContextForAssessment(submission, primaryReport);
    const { frameAssets, frames } = await loadStoredSubmissionFrames(data, submission);
    const peakWindows = buildStoredPeakWindows({ submission, reports: relatedReports, frameAssets });

    let visualAnalysis = submission.visualAnalysis
        || primaryReport.visualAnalysis
        || buildFallbackVisualAnalysis({ peakWindows, sourceAnalysis, frames });
    let visualAnalysisRefreshed = false;

    if (refreshVisualAnalysis) {
        let refreshedVisualAnalysis = null;

        if (shouldUseGeminiForRescore(useGemini) && frames.length) {
            refreshedVisualAnalysis = await generateVisualEvidenceAssessment({
                frames,
                peakWindows,
                song,
                venue: primaryVenue,
                sourceAnalysis,
            }).catch((error) => {
                console.warn(`Visual rescore failed for ${submission.reference || submission.id}:`, error.message);
                return null;
            });
        }

        const normalizedRefresh = refreshedVisualAnalysis
            ? {
                ...refreshedVisualAnalysis,
                peakWindows,
            }
            : null;

        if (normalizedRefresh && !looksLikeDegenerateVisualRefresh(normalizedRefresh)) {
            visualAnalysis = normalizedRefresh;
            visualAnalysisRefreshed = true;
        } else if (!visualAnalysis) {
            visualAnalysis = {
                ...buildFallbackVisualAnalysis({ peakWindows, sourceAnalysis, frames }),
                peakWindows,
            };
        } else if (!visualAnalysis.peakWindows?.length) {
            visualAnalysis = {
                ...visualAnalysis,
                peakWindows,
            };
        }
    } else if (!visualAnalysis.peakWindows?.length) {
        visualAnalysis = {
            ...visualAnalysis,
            peakWindows,
        };
    }

    const reportSummaries = [];

    for (const report of relatedReports) {
        const venue = report.venueId ? data.venues.find((entry) => entry.id === report.venueId) || null : primaryVenue;
        const reportMerchant = report.merchantMasterId
            ? data.merchantMaster.find((entry) => entry.id === report.merchantMasterId) || null
            : merchant;
        const caseRecord = findCaseForReport(data, report.id);
        const context = buildApplicationAssessmentContext({
            data,
            report,
            submission,
            venue,
            merchant: reportMerchant,
            caseRecord,
            contributor,
            sourceAnalysis: report.sourceAnalysis || sourceAnalysis,
            visualAnalysis,
            forensicSummary: report.forensicSummary || '',
            radioEvidence: submission.radioEvidence || null,
        });

        const applicationAssessment = shouldUseGeminiForRescore(useGemini)
            ? await generateApplicationAssessment({ context, frames, generateText: generateGeminiText }).catch((error) => {
                console.warn(`Application rescore failed for ${report.reference || report.id}:`, error.message);
                return buildFallbackApplicationAssessment(context);
            })
            : buildFallbackApplicationAssessment(context);

        report.visualAnalysis = visualAnalysis;
        report.applicationAssessment = applicationAssessment;
        report.updatedAt = requestedAt;

        reportSummaries.push({
            reportId: report.id,
            reference: report.reference,
            locationContext: applicationAssessment.locationContext,
            recommendedDisposition: applicationAssessment.recommendedDisposition,
            privateSpaceRisk: applicationAssessment.privateSpaceRisk,
            replayRisk: applicationAssessment.replayRisk,
            farmingRisk: applicationAssessment.farmingRisk,
            modelVersion: applicationAssessment.modelVersion,
        });
    }

    submission.visualAnalysis = visualAnalysis;
    submission.applicationAssessment = relatedReports[0]?.applicationAssessment || submission.applicationAssessment || null;
    submission.updatedAt = requestedAt;

    return {
        submissionId: submission.id,
        submissionReference: submission.reference || null,
        reportCount: relatedReports.length,
        visualAnalysisRefreshed,
        visualAnalysisModelVersion: visualAnalysis?.modelVersion || null,
        frameCount: frames.length,
        reports: reportSummaries,
    };
}

export const rescoreStoredEvidence = async ({
    reportIdentifiers = [],
    submissionIdentifiers = [],
    refreshVisualAnalysis = true,
    useGemini = true,
} = {}) => mutatePlatformData(async (data) => {
    const targetSubmissionIds = new Set();

    toIdentifierList(reportIdentifiers).forEach((identifier) => {
        const report = findReportByIdentifier(data, identifier);
        if (!report) {
            throw new Error(`Report ${identifier} was not found.`);
        }
        targetSubmissionIds.add(report.submissionId);
    });

    toIdentifierList(submissionIdentifiers).forEach((identifier) => {
        const submission = findSubmissionByIdentifier(data, identifier);
        if (!submission) {
            throw new Error(`Submission ${identifier} was not found.`);
        }
        targetSubmissionIds.add(submission.id);
    });

    if (!targetSubmissionIds.size) {
        throw new Error('Provide at least one report or submission identifier to rescore.');
    }

    const requestedAt = new Date().toISOString();
    const summaries = [];

    for (const submissionId of targetSubmissionIds) {
        const submission = data.submissions.find((entry) => entry.id === submissionId) || null;
        summaries.push(await recomputeSubmissionAssessments({
            data,
            submission,
            refreshVisualAnalysis,
            useGemini,
            requestedAt,
        }));
    }

    return {
        rescoredAt: requestedAt,
        submissionCount: summaries.length,
        reportCount: summaries.reduce((sum, entry) => sum + Number(entry.reportCount || 0), 0),
        summaries,
    };
});

const buildVenueHistorySummary = (data, report) => {
    const sameVenueReports = data.reports.filter((item) => item.venueId === report.venueId);
    const reports30Days = sameVenueReports.filter((item) => Date.now() - new Date(item.createdAt).getTime() <= 30 * 24 * 60 * 60 * 1000).length;
    const reports90Days = sameVenueReports.filter((item) => Date.now() - new Date(item.createdAt).getTime() <= 90 * 24 * 60 * 60 * 1000).length;

    return {
        reports30Days,
        reports90Days,
        totalReportsAtVenue: sameVenueReports.length
    };
};

const buildEvidencePackage = (req, data, { report, submission, venue, merchant, org, caseRecord, reviews, rawAsset, audioAsset }) => {
    const contributor = submission?.installId ? getContributorByInstall(data, submission.installId) : null;
    const sourceAnalysis = report.sourceAnalysis || submission?.sourceAnalysis || null;
    const sourceReview = report.sourceReview || null;
    const visualAnalysis = report.visualAnalysis || submission?.visualAnalysis || null;
    const radioEvidence = submission?.radioEvidence || null;
    const locationDelta = buildLocationDelta({ submission, venue, candidateVenues: data.venues || [] });
    const applicationAssessment = report.applicationAssessment
        || submission?.applicationAssessment
        || buildFallbackApplicationAssessment(buildApplicationAssessmentContext({
            data,
            report,
            submission,
            venue,
            merchant,
            caseRecord,
            contributor,
            sourceAnalysis,
            visualAnalysis,
            forensicSummary: report.forensicSummary || '',
            radioEvidence,
        }));
    const wifiEvidence = getLatestRadioEntry(radioEvidence, 'wifi');
    const bluetoothEvidence = getLatestRadioEntry(radioEvidence, 'bluetooth');
    const keyFrameAssets = Array.isArray(submission?.keyFrameAssetIds)
        ? submission.keyFrameAssetIds
            .map((assetId) => data.assets.find((item) => item.id === assetId) || null)
            .filter(Boolean)
        : [];
    const audioDeconstructionAssets = Array.isArray(submission?.audioDeconstruction?.stems)
        ? submission.audioDeconstruction.stems
            .map((entry) => {
                const asset = entry?.assetId ? data.assets.find((item) => item.id === entry.assetId) || null : null;
                if (!asset) {
                    return null;
                }

                return {
                    stem: entry.stem || asset.metadata?.stem || null,
                    asset,
                };
            })
            .filter(Boolean)
        : [];
    const captureIntegrity = buildCaptureIntegritySignals({
        req,
        submission,
        report,
        rawAsset,
        audioAsset,
        buildAssetUrl,
        signatureStatus: getPresentationSignatureStatus(submission),
    });
    const radioContext = {
        collectionVersion: radioEvidence?.collectionVersion || null,
        limitations: radioEvidence?.limitations || [],
        wifi: wifiEvidence ? {
            ...wifiEvidence,
            summary: summarizeRadioEntry(wifiEvidence),
        } : null,
        bluetooth: bluetoothEvidence ? {
            ...bluetoothEvidence,
            summary: summarizeRadioEntry(bluetoothEvidence),
        } : null,
    };
    const audioIdentification = buildAudioIdentificationSignals({ submission, report, formatMatchedSong });
    const audioDeconstruction = submission?.audioDeconstruction ? {
        status: submission.audioDeconstruction.status || 'unknown',
        provider: submission.audioDeconstruction.provider || 'demucs',
        model: submission.audioDeconstruction.model || null,
        device: submission.audioDeconstruction.device || null,
        jobId: submission.audioDeconstruction.jobId || null,
        preferredStem: submission.audioDeconstruction.preferredStem || null,
        peakSelectionStem: submission.audioDeconstruction.peakSelectionStem || null,
        fingerprintStem: submission.audioDeconstruction.fingerprintStem || null,
        usedForPeakSelection: Boolean(submission.audioDeconstruction.usedForPeakSelection),
        usedForFingerprinting: Boolean(submission.audioDeconstruction.usedForFingerprinting),
        summary: submission.audioDeconstruction.summary || '',
        error: submission.audioDeconstruction.error || null,
        artifacts: audioDeconstructionAssets.map(({ stem, asset }) => ({
            stem,
            assetId: asset.id,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
            url: buildAssetUrl(req, asset),
        })),
    } : null;
    const sourceAssessment = sourceAnalysis ? {
        ...sourceAnalysis,
        requestedMode: submission?.sourceClassifierMode || sourceAnalysis.classifierMode || null,
        analystNote: sourceAnalysis.explanation?.[0] || null,
        reviewedSource: sourceReview ? {
            reviewedClass: sourceReview.reviewedClass,
            notes: sourceReview.notes || '',
            reviewedAt: sourceReview.reviewedAt || null,
            reviewerId: sourceReview.reviewerId || null,
            isOverride: Boolean(sourceReview.isOverride),
        } : null,
    } : null;
    const visualContext = visualAnalysis ? {
        ...visualAnalysis,
        peakWindows: visualAnalysis.peakWindows || [],
        frames: keyFrameAssets.map((asset) => ({
            assetId: asset.id,
            timestampSeconds: asset.metadata?.timestampSeconds ?? null,
            peakRank: asset.metadata?.peakRank ?? null,
            relativeIntensity: asset.metadata?.relativeIntensity ?? null,
            mimeType: asset.mimeType,
            url: buildAssetUrl(req, asset),
        })),
    } : (keyFrameAssets.length ? {
        peakWindows: [],
        frames: keyFrameAssets.map((asset) => ({
            assetId: asset.id,
            timestampSeconds: asset.metadata?.timestampSeconds ?? null,
            peakRank: asset.metadata?.peakRank ?? null,
            relativeIntensity: asset.metadata?.relativeIntensity ?? null,
            mimeType: asset.mimeType,
            url: buildAssetUrl(req, asset),
        })),
    } : null);
    const venueContext = {
        selectedVenue: submission?.selectedVenue || null,
        matchedVenue: venue ? {
            id: venue.id,
            name: venue.name,
            address: venue.address,
            city: venue.city || null,
            latitude: venue.latitude ?? null,
            longitude: venue.longitude ?? null,
            placeProviderId: venue.placeProviderId || null,
            placeProvider: venue.placeProvider || null,
        } : null,
        merchant: merchant ? {
            id: merchant.id,
            venueName: merchant.venueName,
            legalEntityName: merchant.legalEntityName || null,
            gstin: merchant.gstin || null,
            cityTier: merchant.cityTier || null,
            venueType: merchant.venueType || null,
            outletCount: merchant.outletCount || null,
            eventCapability: merchant.eventCapability || null,
        } : null,
        venueHistory: buildVenueHistorySummary(data, report),
    };
    const rightsAndCaseContext = {
        org: org ? {
            id: org.id,
            name: org.name,
            type: org.type,
            slug: org.slug,
        } : null,
        rightsType: report.rightsType || null,
        rightsOrg: report.rightsOrg || null,
        licenseAssessment: report.licenseAssessment || null,
        analystStatus: report.analystStatus || null,
        estimatedRecoverableValueInr: report.estimatedRecoverableValueInr || 0,
        rewardEligibility: Boolean(report.rewardEligibility),
        rewardDisposition: report.rewardDisposition || null,
        case: caseRecord ? {
            id: caseRecord.id,
            reference: caseRecord.reference,
            caseStatus: caseRecord.caseStatus,
            licenseStatus: caseRecord.licenseStatus,
            evidenceCount: caseRecord.evidenceCount,
            planningBand: caseRecord.planningBand,
        } : null,
    };
    const reviewTrail = {
        analystReviews: reviews.map((review) => ({
            id: review.id,
            reviewerId: review.reviewerId,
            verdict: review.verdict,
            tags: review.tags || [],
            notes: review.notes || '',
            reviewedAt: review.reviewedAt,
        })),
        sourceReviews: getSourceReviewsForReport(data, report.id).map((review) => ({
            id: review.id,
            reviewerId: review.reviewerId,
            reviewedClass: review.reviewedClass,
            notes: review.notes || '',
            reviewedAt: review.reviewedAt,
            predictedClass: review.predictedClass || null,
            predictedConfidence: review.predictedConfidence ?? null,
            predictedScore: review.predictedScore ?? null,
            predictedModelVersion: review.predictedModelVersion || null,
            isOverride: Boolean(review.isOverride),
        })),
    };
    const historicalEvidence = buildHistoricalEvidenceContext({
        data,
        report,
        submission,
        venue,
        caseRecord,
        reviews,
    });
    const venueIdentityScore = scoreVenueIdentity({
        locationDelta,
        visualContext: visualContext || {},
        radioContext,
        venueContext,
        historicalEvidence,
    });
    const evidenceStrengthScore = scoreEvidenceStrength({
        captureIntegrity,
        audioIdentification,
        audioDeconstruction,
        sourceAssessment,
        visualContext: visualContext || {},
        rightsAndCaseContext,
        historicalEvidence,
    });
    const venueAttributionPreview = inferSharedVenueAttribution({
        evidencePackage: {
            locationDelta,
            visualContext: visualContext || {},
        },
        matchedVenue: venueContext.matchedVenue,
        selectedVenue: venueContext.selectedVenue,
    });
    const legalReadinessScore = scoreLegalReadiness({
        venueIdentityScore,
        evidenceStrengthScore,
        venueAttribution: venueAttributionPreview,
        applicationLayer: applicationAssessment,
        historicalEvidence,
    });

    return {
        packageVersion: 'evidence-package-v2',
        captureIntegrity,
        radioContext,
        audioIdentification,
        audioDeconstruction,
        sourceAssessment,
        visualContext,
        locationDelta,
        historicalEvidence,
        scoring: {
            modelVersion: 'venue-evidence-scoring-v1',
            venueIdentityScore,
            evidenceStrengthScore,
            legalReadinessScore,
        },
        applicationLayer: applicationAssessment ? {
            ...applicationAssessment,
        } : null,
        venueContext,
        rightsAndCaseContext,
        contributorContext: buildContributorPublicView(contributor, data),
        reviewTrail,
    };
};

const buildReportView = (req, data, report) => {
    const org = report.rightsOwnerOrgId ? data.orgs.find((item) => item.id === report.rightsOwnerOrgId) || null : null;
    const submission = data.submissions.find((item) => item.id === report.submissionId) || null;
    const venue = report.venueId ? data.venues.find((item) => item.id === report.venueId) || null : null;
    const rawAsset = submission?.rawVideoAssetId ? data.assets.find((item) => item.id === submission.rawVideoAssetId) || null : null;
    const audioAsset = submission?.derivedAudioAssetId ? data.assets.find((item) => item.id === submission.derivedAudioAssetId) || null : null;
    const reviews = data.analystReviews.filter((item) => item.reportId === report.id);
    const sourceReviews = getSourceReviewsForReport(data, report.id);
    const merchant = report.merchantMasterId ? data.merchantMaster.find((item) => item.id === report.merchantMasterId) || null : null;
    const caseRecord = findCaseForReport(data, report.id);
    const evidencePackage = buildEvidencePackage(req, data, {
        report,
        submission,
        venue,
        merchant,
        org,
        caseRecord,
        reviews,
        rawAsset,
        audioAsset
    });

    return {
        ...report,
        org,
        venue,
        merchant,
        case: buildCaseView(data, caseRecord),
        reviews,
        sourceReviews,
        evidencePackage,
        submission: submission ? {
            ...submission,
            rawVideoUrl: rawAsset ? buildAssetUrl(req, rawAsset) : null,
            derivedAudioUrl: audioAsset ? buildAssetUrl(req, audioAsset) : null
        } : null
    };
};

const PROTOTYPE_CASE_STAGES = ['New', 'Under Review', 'Agent Assignment', 'Ready For Legal', 'Recovery In Progress', 'Closed'];
const PROTOTYPE_STAGE_TRANSITIONS = {
    'New': ['Under Review'],
    'Under Review': ['Agent Assignment', 'Ready For Legal', 'Recovery In Progress', 'Closed'],
    'Agent Assignment': ['Under Review', 'Recovery In Progress', 'Agent Assignment'],
    'Ready For Legal': ['Under Review', 'Closed', 'Ready For Legal'],
    'Recovery In Progress': ['Under Review', 'Closed', 'Ready For Legal', 'Recovery In Progress'],
    'Closed': ['Under Review'],
};

const isPrototypeCaseStage = (value) => PROTOTYPE_CASE_STAGES.includes(value);

const normalizePrototypeAssetUrl = (value) => {
    if (!value || typeof value !== 'string') {
        return value || '';
    }

    try {
        const parsed = new URL(value);
        return `${parsed.pathname}${parsed.search || ''}`;
    } catch {
        return value;
    }
};

const splitPrototypeArtists = (value) => {
    const raw = String(value || '').trim();
    if (!raw) {
        return ['Unknown Artist'];
    }

    const artists = raw
        .split(/\s*,\s*/)
        .map((entry) => entry.trim())
        .filter(Boolean);

    return artists.length ? artists : [raw];
};

const getPrototypeCaseRecordByIdentifier = (data, identifier) => data.caseLedger.find((entry) => (
    entry.reference === identifier || entry.id === identifier
)) || null;

const getPrimaryReportForCaseRecord = (data, caseRecord) => {
    if (!caseRecord) {
        return null;
    }

    return (
        data.reports.find((report) => report.id === caseRecord.primaryReportId)
        || data.reports.find((report) => caseRecord.reportIds?.includes?.(report.id))
        || null
    );
};

const derivePrototypeStageFromCase = ({ caseRecord, primaryReport }) => {
    if (isPrototypeCaseStage(caseRecord?.authorityStage)) {
        return caseRecord.authorityStage;
    }

    const caseStatus = String(caseRecord?.caseStatus || '').toLowerCase();
    const analystStatus = String(primaryReport?.analystStatus || '').toLowerCase();

    if (
        caseStatus === 'realized'
        || caseStatus === 'licensed'
        || caseStatus === 'rejected'
        || Number(caseRecord?.realizedValueInr || 0) > 0
    ) {
        return 'Closed';
    }

    if (caseStatus === 'confirmed_actionable') {
        return 'Ready For Legal';
    }

    if (caseStatus === 'actionable' || analystStatus === 'confirmed') {
        return 'Under Review';
    }

    return 'New';
};

const buildPrototypeDefaultAuditTrail = ({ caseRecord, primaryReport, stage }) => {
    const createdAt = caseRecord?.createdAt || primaryReport?.createdAt || new Date().toISOString();
    const updatedAt = caseRecord?.updatedAt || primaryReport?.updatedAt || createdAt;
    const trail = [
        {
            id: `AUD-INIT-${caseRecord.id}`,
            timestamp: createdAt,
            action: 'Case Created',
            actor: 'System',
            newStage: 'New',
            details: 'Imported from the capture evidence pipeline.',
        },
    ];

    if (stage !== 'New') {
        trail.push({
            id: `AUD-SYNC-${caseRecord.id}`,
            timestamp: updatedAt,
            action: 'Stage Synced',
            actor: 'System',
            previousStage: 'New',
            newStage: stage,
            details: `Derived from legacy case state ${caseRecord.caseStatus || primaryReport?.analystStatus || 'unknown'}.`,
        });
    }

    return trail;
};

const getPrototypeAuditTrailForCase = ({ caseRecord, primaryReport, stage }) => {
    if (Array.isArray(caseRecord?.authorityAuditTrail) && caseRecord.authorityAuditTrail.length) {
        return caseRecord.authorityAuditTrail;
    }

    return buildPrototypeDefaultAuditTrail({ caseRecord, primaryReport, stage });
};

const ensurePrototypeAuditTrail = ({ caseRecord, primaryReport }) => {
    const stage = derivePrototypeStageFromCase({ caseRecord, primaryReport });
    if (!Array.isArray(caseRecord.authorityAuditTrail) || !caseRecord.authorityAuditTrail.length) {
        caseRecord.authorityAuditTrail = buildPrototypeDefaultAuditTrail({ caseRecord, primaryReport, stage });
    }
    return stage;
};

const appendEnforcementAuditEvent = ({ caseRecord, primaryReport, eventType, actorId = 'Admin', previousValue = null, newValue = null, source = 'authority', notes = '', captureId = null }) => {
    ensurePrototypeAuditTrail({ caseRecord, primaryReport });
    const occurredAt = new Date().toISOString();
    const entry = {
        id: crypto.randomUUID(),
        event_type: eventType,
        action: eventType,
        actor: actorId,
        actor_id: actorId,
        occurred_at: occurredAt,
        timestamp: occurredAt,
        case_id: caseRecord.id,
        capture_id: captureId || caseRecord.primarySubmissionId || null,
        previous_value: previousValue,
        new_value: newValue,
        source,
        notes,
        details: notes || eventType,
    };
    caseRecord.authorityAuditTrail.push(entry);
    caseRecord.updatedAt = occurredAt;
    return entry;
};

const getPrototypeCaseViewByIdentifier = (req, data, identifier) => {
    const caseRecord = getPrototypeCaseRecordByIdentifier(data, identifier);
    return caseRecord ? buildPrototypeCaseView(req, data, caseRecord) : null;
};

const buildPrototypeCaseView = (req, data, caseRecord) => {
    const primaryReport = getPrimaryReportForCaseRecord(data, caseRecord);
    if (!primaryReport) {
        return null;
    }

    const reportView = buildReportView(req, data, primaryReport);
    const stage = derivePrototypeStageFromCase({ caseRecord, primaryReport });
    const auditTrail = getPrototypeAuditTrailForCase({ caseRecord, primaryReport, stage });
    const evidencePackage = reportView?.evidencePackage || {};
    const capture = evidencePackage?.captureIntegrity || {};
    const audio = evidencePackage?.audioIdentification || {};
    const source = evidencePackage?.sourceAssessment || null;
    const visual = evidencePackage?.visualContext || {};
    const radioContext = evidencePackage?.radioContext || {
        collectionVersion: null,
        limitations: [],
        wifi: null,
        bluetooth: null,
    };
    const venueContext = evidencePackage?.venueContext || {};
    const matchedVenue = venueContext?.matchedVenue || reportView?.venue || null;
    const selectedVenue = venueContext?.selectedVenue || reportView?.submission?.selectedVenue || null;
    const venueAttribution = inferSharedVenueAttribution({
        evidencePackage,
        matchedVenue,
        selectedVenue,
    });
    const contributorPoint = capture?.geolocation?.end || capture?.geolocation?.start || null;
    const latitude = Number(
        matchedVenue?.latitude
        ?? selectedVenue?.latitude
        ?? contributorPoint?.lat
        ?? 20.5937
    );
    const longitude = Number(
        matchedVenue?.longitude
        ?? selectedVenue?.longitude
        ?? contributorPoint?.lon
        ?? 78.9629
    );
    const rawVideoUrl = normalizePrototypeAssetUrl(capture?.assets?.rawVideo?.url);
    const frameUrls = (visual?.frames || []).map((frame) => normalizePrototypeAssetUrl(frame.url)).filter(Boolean);
    const qualityScore = derivePrototypeQualityScore({ reportView, caseRecord });
    const pastOffences = Math.max(
        0,
        data.caseLedger.filter((entry) => entry.venueId === caseRecord.venueId && entry.reference !== caseRecord.reference).length,
    );
    const recoverableValue = Number(caseRecord?.estimatedRecoverableValueInr || reportView?.estimatedRecoverableValueInr || 0);
    const rightsAssociation = [
        evidencePackage?.rightsAndCaseContext?.org?.name,
        reportView?.rightsType,
    ].filter(Boolean).join(' / ') || 'Rights Context Pending';
    const vaultId = `${caseRecord.reference}-VAULT-1`;
    const audioDeconstruction = evidencePackage?.audioDeconstruction ? {
        ...evidencePackage.audioDeconstruction,
        artifacts: (evidencePackage.audioDeconstruction.artifacts || []).map((artifact) => ({
            ...artifact,
            url: normalizePrototypeAssetUrl(artifact.url),
        })),
    } : null;
    const existingAudit = Array.isArray(caseRecord?.authorityAuditTrail) ? caseRecord.authorityAuditTrail : [];
    const hasBeenSentToAgent = stage === 'Agent Assignment'
        || existingAudit.some((entry) => entry?.newStage === 'Agent Assignment');
    const assignmentType = caseRecord?.authorityAssignmentType
        || (stage === 'Agent Assignment' ? 'Agent' : null)
        || (stage === 'Ready For Legal' ? 'Lawyer' : null)
        || undefined;

    const licenseResolution = buildLicenseResolution({ caseRecord, report: primaryReport });
    const prototypeCase = {
        id: caseRecord.reference,
        isNew: stage === 'New',
        timestamp: reportView?.createdAt || caseRecord?.createdAt || new Date().toISOString(),
        location: {
            name: matchedVenue?.name || selectedVenue?.name || reportView?.submission?.matchedVenue || 'Venue Unresolved',
            lat: Number.isFinite(latitude) ? latitude : 20.5937,
            lng: Number.isFinite(longitude) ? longitude : 78.9629,
            city: matchedVenue?.city || selectedVenue?.city || 'Unknown City',
            address: matchedVenue?.address || selectedVenue?.address || 'Address unavailable',
            phone: 'Not available',
            email: 'Not available',
        },
        pastOffences,
        expectedFine: recoverableValue,
        musicLabel: audio?.label || reportView?.label || evidencePackage?.rightsAndCaseContext?.org?.name || 'Unknown Label',
        videoProofUrl: rawVideoUrl || '',
        aiExplanation: reportView?.forensicSummary || '',
        trustGates: {
            mediaHashKey: Boolean(capture?.mediaSha256),
            payloadSignature: capture?.signatureStatus === 'signed_and_verified',
            clockSkewDetection: capture?.clockSkewStatus === 'clear',
            geofencingContinuity: evidencePackage?.locationDelta?.withinAccuracyEnvelope !== false,
            deviceTrustBand: String(capture?.device?.deviceTrustBand || '').toLowerCase() === 'high',
        },
        songAssessment: {
            title: audio?.title || reportView?.title || 'Unknown Track',
            artists: splitPrototypeArtists(audio?.artist || reportView?.artist),
            labelOwner: audio?.label || reportView?.label || evidencePackage?.rightsAndCaseContext?.org?.name || 'Unknown Label',
            isrc: audio?.isrc || 'Unavailable',
            upc: audio?.upc || 'Unavailable',
            rightsAssociation,
        },
        absoluteProof: {
            smallVideoUrl: rawVideoUrl || '',
            venueImages: frameUrls,
            obstructionFlags: (visual?.obstructionFlags || []).join('. ') || 'No major obstruction flags.',
            performanceContext: visual?.summary || reportView?.forensicSummary || 'Evidence context is still being synthesized.',
        },
        locationDelta: evidencePackage?.locationDelta || null,
        radioContext,
        venueAttribution,
        scoring: evidencePackage?.scoring || null,
        historicalEvidence: evidencePackage?.historicalEvidence || null,
        venueContext: {
            selectedVenue,
            matchedVenue,
        },
        audioDeconstruction,
        sourceAssessment: source,
        evidenceVaults: [
            {
                id: vaultId,
                name: 'Evidence Vault 1',
                timestamp: reportView?.createdAt || caseRecord?.createdAt || new Date().toISOString(),
                videoUrl: rawVideoUrl || '',
                images: frameUrls,
                notes: visual?.summary || reportView?.forensicSummary || 'Primary evidence package imported from the backend.',
                moreProofRequested: false,
            },
        ],
        selectedVaultIds: [vaultId],
        chainOfCustody: buildPrototypeChainOfCustody({ reportView, caseRecord }),
        stage,
        qualityScore,
        recoverableValue,
        assignedTo: caseRecord?.authorityAssignedTo || undefined,
        notes: caseRecord?.authorityNotes || undefined,
        assignmentType,
        agentResolutionNote: caseRecord?.authorityAgentResolutionNote || undefined,
        agentActionTaken: caseRecord?.authorityAgentActionTaken || undefined,
        hasBeenSentToAgent,
        resolvedByAgentName: caseRecord?.authorityResolvedByAgentName || undefined,
        auditTrail,
        comments: [],
        unreadComments: false,
        unreadMajorChanges: stage === 'New',
    };
    const venueResolution = buildVenueResolutionModel(prototypeCase);
    const readiness = evaluateCaseReadiness({ caseView: prototypeCase, licenseResolution });

    return {
        ...prototypeCase,
        licenseResolution,
        venueResolution,
        readiness,
        readiness_score: readiness.readiness_score,
        readiness_band: readiness.readiness_band,
        readiness_reasons: readiness.readiness_reasons,
        next_actions: readiness.next_actions,
        prosecution_strength_score: readiness.prosecution_strength_score,
        prosecution_strength_label: readiness.prosecution_strength_label,
        prosecution_strength_reasons: readiness.prosecution_strength_reasons,
    };
};

const filterReportsForUser = (data, portalUser) => {
    if (portalUser.isPlatformAdmin) {
        return data.reports;
    }

    return data.reports.filter((report) => report.rightsOwnerOrgId === portalUser.orgId);
};

const computeRepeatOffenderScore = (reports) => {
    const now = Date.now();
    let score = 0;
    const songs = new Set();

    for (const report of reports) {
        const ageDays = (now - new Date(report.createdAt).getTime()) / (24 * 60 * 60 * 1000);
        if (ageDays <= 90 && report.analystStatus === 'confirmed') {
            score += 5;
        } else if (ageDays <= 30 && report.analystStatus === 'unreviewed' && report.matchedTrackConfidence >= 0.7) {
            score += 2;
        }
        if (ageDays <= 90) {
            songs.add(`${cleanString(report.title)}::${cleanString(report.artist)}`);
        }
    }

    score += songs.size;
    return score;
};

const buildDashboardPayload = (data, reports, portalUser) => {
    const reportsByVenue = new Map();
    const reportsBySong = new Map();
    const reportsByCity = new Map();
    const now = Date.now();
    const visibleCaseIds = new Set(reports.map((report) => report.caseId).filter(Boolean));
    const visibleCases = data.caseLedger.filter((entry) => visibleCaseIds.has(entry.id));
    const visibleRewards = data.rewardLedger.filter((reward) => visibleCases.some((entry) => entry.id === reward.caseId));

    for (const report of reports) {
        const venue = report.venueId ? data.venues.find((item) => item.id === report.venueId) || null : null;
        const venueKey = venue?.id || 'unmatched';
        const venueBucket = reportsByVenue.get(venueKey) || { venue, reports: [] };
        venueBucket.reports.push(report);
        reportsByVenue.set(venueKey, venueBucket);

        const songKey = `${report.title}::${report.artist}`;
        reportsBySong.set(songKey, (reportsBySong.get(songKey) || 0) + 1);

        const cityKey = venue?.city || 'Unknown';
        reportsByCity.set(cityKey, (reportsByCity.get(cityKey) || 0) + 1);
    }

    const topRepeatOffenders = [...reportsByVenue.values()]
        .map(({ venue, reports: venueReports }) => ({
            venue,
            reportCount: venueReports.length,
            confirmedCount: venueReports.filter((report) => report.analystStatus === 'confirmed').length,
            lastSeenAt: venueReports.reduce((latest, report) => latest > report.createdAt ? latest : report.createdAt, venueReports[0]?.createdAt || null),
            repeatOffenderScore: computeRepeatOffenderScore(venueReports),
            uniqueSongs: new Set(venueReports.map((report) => `${report.title}::${report.artist}`)).size
        }))
        .sort((left, right) => right.repeatOffenderScore - left.repeatOffenderScore)
        .slice(0, 10);

    const topSongs = [...reportsBySong.entries()]
        .map(([key, count]) => {
            const [title, artist] = key.split('::');
            return { title, artist, count };
        })
        .sort((left, right) => right.count - left.count)
        .slice(0, 10);

    const topCities = [...reportsByCity.entries()]
        .map(([city, count]) => ({ city, count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 10);

    const reportsLastDays = (days) => reports.filter((report) => now - new Date(report.createdAt).getTime() <= days * 24 * 60 * 60 * 1000).length;
    const casePackets = portalUser.isPlatformAdmin
        ? data.casePackets
        : data.casePackets.filter((packet) => packet.orgId === portalUser.orgId);

    return {
        totals: {
            totalReports: reports.length,
            confirmedReports: reports.filter((report) => report.analystStatus === 'confirmed').length,
            uniqueVenues: new Set(reports.map((report) => report.venueId || 'unmatched')).size,
            exportedCasePackets: casePackets.length,
            eligibleCases: visibleCases.filter((entry) => entry.rewardEligible).length,
            estimatedRecoverableValueInr: visibleCases.reduce((sum, entry) => sum + Number(entry.estimatedRecoverableValueInr || 0), 0),
            realizedValueInr: visibleCases.reduce((sum, entry) => sum + Number(entry.realizedValueInr || 0), 0),
            heldRewardLiabilityInr: visibleRewards.filter((reward) => reward.status === 'held').reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0),
            confirmationRate: reports.length ? Number((reports.filter((report) => report.analystStatus === 'confirmed').length / reports.length).toFixed(2)) : 0,
            reportsLast7Days: reportsLastDays(7),
            reportsLast30Days: reportsLastDays(30),
            reportsLast90Days: reportsLastDays(90)
        },
        topRepeatOffenders,
        topSongs,
        topCities
    };
};

const getImportPayload = (req) => req.file?.buffer || req.body.csv || '';

const getMobileUserInstalls = (data, mobileUserId) => data.anonymousInstalls.filter((install) => install.mobileUserId === mobileUserId);

const getMobileUserSubmissions = (data, mobileUserId) => {
    const installIds = new Set(getMobileUserInstalls(data, mobileUserId).map((install) => install.installId));
    return data.submissions.filter((submission) => installIds.has(submission.installId));
};

const getMobileSubmissionRewardTotals = (data, submissionId) => ({
    held: data.rewardLedger
        .filter((reward) => reward.submissionId === submissionId && reward.status === 'held')
        .reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0),
    paid: data.rewardLedger
        .filter((reward) => reward.submissionId === submissionId && reward.status === 'paid')
        .reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0),
    reversed: data.rewardLedger
        .filter((reward) => reward.submissionId === submissionId && reward.status === 'reversed')
        .reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0),
});

const getMobileSubmissionRewardState = (data, submission) => {
    const totals = getMobileSubmissionRewardTotals(data, submission.id);
    if (totals.paid > 0) {
        return 'paid';
    }
    if (totals.held > 0) {
        return 'held';
    }
    if (totals.reversed > 0) {
        return 'reversed';
    }
    return submission.rewardState || 'pending';
};

const buildMobileSubmissionSummary = (data, submission) => {
    const rewardTotals = getMobileSubmissionRewardTotals(data, submission.id);
    const sourceAnalysis = submission.sourceAnalysis || null;
    const radioEvidence = submission.radioEvidence || null;
    const wifiEvidence = getLatestRadioEntry(radioEvidence, 'wifi');
    const bluetoothEvidence = getLatestRadioEntry(radioEvidence, 'bluetooth');
    return {
        submission_id: submission.id,
        reference_id: submission.reference,
        status: submission.status,
        created_at: submission.createdAt,
        duration_seconds: Number(submission.durationSeconds || 0),
        file_size: Number(submission.fileSize || 0),
        media_hash: submission.mediaSha256 || null,
        start_lat: submission.geolocationStart?.lat ?? null,
        start_lng: submission.geolocationStart?.lon ?? null,
        start_accuracy: submission.geolocationStart?.accuracy ?? null,
        end_lat: submission.geolocationEnd?.lat ?? null,
        end_lng: submission.geolocationEnd?.lon ?? null,
        end_accuracy: submission.geolocationEnd?.accuracy ?? null,
        device_model: submission.deviceModel || submission.deviceSnapshot?.deviceModel || null,
        app_version: submission.appVersion || null,
        business_name: submission.businessName || null,
        gstin: submission.gstin || null,
        note: submission.note || null,
        selected_venue_name: submission.selectedVenue?.name || null,
        selected_venue_address: submission.selectedVenue?.address || null,
        selected_venue_place_provider_id: submission.selectedVenue?.placeProviderId || null,
        selected_venue_provider: submission.selectedVenue?.provider || null,
        matched_venue: submission.matchedVenue || null,
        matched_song: submission.matchedSong || formatMatchedSong(submission.songIdentity) || null,
        analyst_result: submission.analystResult || null,
        source_classifier_mode: submission.sourceClassifierMode || null,
        source_model_version: sourceAnalysis?.modelVersion || null,
        source_class: sourceAnalysis?.sourceClass || null,
        source_confidence: sourceAnalysis?.confidence ?? null,
        source_score: sourceAnalysis?.score ?? null,
        source_summary: sourceAnalysis?.explanation?.[0] || null,
        radio_evidence: radioEvidence,
        wifi_status: wifiEvidence?.status || null,
        wifi_summary: summarizeRadioEntry(wifiEvidence),
        bluetooth_status: bluetoothEvidence?.status || null,
        bluetooth_summary: summarizeRadioEntry(bluetoothEvidence),
        reward_state: getMobileSubmissionRewardState(data, submission),
        reward_amount: rewardTotals.paid || rewardTotals.held || 0,
        rejection_reason: submission.processingError || null,
    };
};

const buildMobileTrustPayload = (data, mobileUser) => {
    const submissions = getMobileUserSubmissions(data, mobileUser.id);
    const confirmedCount = submissions.filter((submission) => (
        submission.status === 'confirmed_actionable'
        || submission.status === 'paid'
    )).length;
    const confirmationRate = submissions.length
        ? Number(((confirmedCount / submissions.length) * 100).toFixed(0))
        : 0;
    const limits = {
        new: { daily_limit: 3, hold_days: 14 },
        trusted: { daily_limit: 10, hold_days: 7 },
        'high-trust': { daily_limit: 25, hold_days: 3 },
        restricted: { daily_limit: 0, hold_days: 30 },
        banned: { daily_limit: 0, hold_days: 0 },
    };

    return {
        trust_tier: mobileUser.trustTier || 'new',
        limits: limits[mobileUser.trustTier] || limits.new,
        submission_count: submissions.length,
        confirmed_count: confirmedCount,
        confirmation_rate: confirmationRate,
        restrictions: mobileUser.restrictions || [],
    };
};

const buildMobileRewardsPayload = (data, mobileUser) => {
    const submissions = getMobileUserSubmissions(data, mobileUser.id);
    const submissionIds = new Set(submissions.map((submission) => submission.id));
    const rewards = data.rewardLedger.filter((reward) => submissionIds.has(reward.submissionId));

    return {
        pending: rewards.filter((reward) => reward.status === 'pending').reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0),
        held: rewards.filter((reward) => reward.status === 'held').reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0),
        paid: rewards.filter((reward) => reward.status === 'paid').reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0),
        ...buildMobileTrustPayload(data, mobileUser),
        reward_items: rewards
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map((reward) => ({
                reference_id: submissions.find((submission) => submission.id === reward.submissionId)?.reference || reward.submissionId,
                stage: reward.stage || 'stage_1',
                amount: Number(reward.amountInr || 0),
                state: reward.status,
            })),
    };
};

app.post('/api/auth/login', async (req, res) => {
    try {
        const session = await loginPortalUser(req.body);
        res.json(session);
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.portalUser });
});

app.get('/api/auth/demo-accounts', async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ error: 'Unavailable in production' });
    }

    const accounts = await listDemoUsers();
    res.json({
        accounts: accounts.map((account) => ({
            ...account,
            currentTotpCode: getCurrentTotpCode(account.totpSecret),
            currentTotpExpiresAt: new Date(getTotpExpiryEpochMs()).toISOString()
        }))
    });
});

app.post('/api/mobile/auth/signup', async (req, res) => {
    try {
        const session = await signupMobileUser(req.body);
        res.json(session);
    } catch (error) {
        const status = error.message === 'Email already registered' ? 409 : 400;
        res.status(status).json({ error: error.message });
    }
});

app.post('/api/mobile/auth/login', async (req, res) => {
    try {
        const session = await loginMobileUser(req.body);
        res.json(session);
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

app.get('/api/mobile/auth/me', requireMobileAuth, (req, res) => {
    res.json({ user: toMobileUserPublic(req.mobileUser) });
});

app.get('/api/health', async (req, res) => {
    try {
        res.json(await buildHealthPayload());
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Failed to build health payload',
            details: error.message
        });
    }
});

app.get('/api/user/profile', requireMobileAuth, async (req, res) => {
    const data = await readPlatformData();
    const installs = getMobileUserInstalls(data, req.mobileUser.id);
    const trust = buildMobileTrustPayload(data, req.mobileUser);

    res.json({
        ...toMobileUserPublic(req.mobileUser),
        install_count: installs.length,
        install_ids: installs.map((install) => install.installId),
        submission_count: trust.submission_count,
        confirmed_count: trust.confirmed_count,
    });
});

app.get('/api/user/trust', requireMobileAuth, async (req, res) => {
    const data = await readPlatformData();
    res.json(buildMobileTrustPayload(data, req.mobileUser));
});

app.get('/api/user/rewards', requireMobileAuth, async (req, res) => {
    const data = await readPlatformData();
    res.json(buildMobileRewardsPayload(data, req.mobileUser));
});

app.get('/api/user/submissions', requireMobileAuth, async (req, res) => {
    const data = await readPlatformData();
    const requestedStatus = String(req.query.status || 'all');
    const normalizedStatus = requestedStatus.replace(/\s+/g, '_');
    let submissions = getMobileUserSubmissions(data, req.mobileUser.id);

    if (requestedStatus && requestedStatus !== 'all') {
        submissions = submissions.filter((submission) => (
            submission.status === requestedStatus
            || submission.status === normalizedStatus
            || submission.status.replace(/_/g, ' ') === requestedStatus
        ));
    }

    res.json(
        submissions
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map((submission) => buildMobileSubmissionSummary(data, submission))
    );
});

app.post('/api/mobile/capture/install', requireMobileAuth, async (req, res) => {
    const payload = req.body || {};
    const device_model = pickFirstDefined(payload.device_model, payload.deviceModel);
    const os_version = pickFirstDefined(payload.os_version, payload.osVersion);
    const app_version = pickFirstDefined(payload.app_version, payload.appVersion);
    const public_key = pickFirstDefined(payload.public_key, payload.publicKey);
    const now = new Date().toISOString();
    const nextDeviceKeyId = crypto.randomUUID();

    const install = await mutatePlatformData((data) => {
        const existing = data.anonymousInstalls.find((item) => item.mobileUserId === req.mobileUser.id && item.deviceModel === device_model) || null;
        if (existing) {
            existing.osVersion = os_version || existing.osVersion || null;
            existing.appVersion = app_version || existing.appVersion || null;
            existing.lastSeenAt = now;
            existing.publicKey = public_key || existing.publicKey || null;
            existing.deviceKeyId = existing.deviceKeyId || nextDeviceKeyId;
            existing.mobileUserId = req.mobileUser.id;
            existing.captureMode = existing.captureMode || 'mobile_pilot';
            return existing;
        }

        const nextInstall = {
            installId: crypto.randomUUID(),
            publicKey: public_key || null,
            deviceProfileHash: stableHash({ device_model, os_version, app_version }),
            userAgentHash: stableHash(req.headers['user-agent'] || ''),
            ipHash: hashIp(req.ip),
            firstSeenAt: now,
            lastSeenAt: now,
            submissionCount: 0,
            abuseScore: 0,
            appVersion: app_version || 'unknown',
            deviceTraits: { device_model, os_version, app_version },
            contributorId: null,
            mobileUserId: req.mobileUser.id,
            deviceModel: device_model || null,
            osVersion: os_version || null,
            deviceKeyId: nextDeviceKeyId,
            captureMode: 'mobile_pilot',
        };
        data.anonymousInstalls.push(nextInstall);
        return nextInstall;
    });

    res.json({
        install_id: install.installId,
        device_key_id: install.deviceKeyId,
        registered_at: now,
    });
});

app.post('/api/mobile/capture/session', requireMobileAuth, async (req, res) => {
    const payload = req.body || {};
    const install_id = pickFirstDefined(payload.install_id, payload.installId);
    const location_lat = pickFirstDefined(payload.location_lat, payload.locationLat);
    const location_lng = pickFirstDefined(payload.location_lng, payload.locationLng);
    const data = await readPlatformData();
    const install = data.anonymousInstalls.find((item) => item.installId === install_id && item.mobileUserId === req.mobileUser.id);
    if (!install) {
        return res.status(404).json({ error: 'Install not found' });
    }

    const now = new Date();
    const session = await mutatePlatformData((draft) => {
        const nextSession = {
            id: crypto.randomUUID(),
            installId: install_id,
            mobileUserId: req.mobileUser.id,
            sessionNonce: crypto.randomBytes(12).toString('hex'),
            issuedServerTime: now.toISOString(),
            startServerTime: null,
            endServerTime: null,
            measuredStartOffsetMs: null,
            measuredEndOffsetMs: null,
            geolocationStart: location_lat != null && location_lng != null
                ? { lat: Number(location_lat), lon: Number(location_lng), capturedAt: now.toISOString() }
                : null,
            geolocationEnd: null,
            status: 'session_created',
            createdAt: now.toISOString(),
        };
        draft.captureSessions.push(nextSession);
        return nextSession;
    });

    res.json({
        session_id: session.id,
        server_time: session.issuedServerTime,
        expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    });
});

app.post('/api/mobile/capture/session/:id/start', requireMobileAuth, async (req, res) => {
    const sessionId = req.params.id;
    const result = await mutatePlatformData((data) => {
        const session = data.captureSessions.find((item) => item.id === sessionId && item.mobileUserId === req.mobileUser.id);
        if (!session) {
            throw new Error('Session not found');
        }

        session.status = 'recording_started';
        session.startServerTime = new Date().toISOString();
        return session;
    }).catch((error) => ({ error }));

    if (result.error) {
        return res.status(404).json({ error: result.error.message });
    }

    res.json({ status: 'recording', session_id: sessionId });
});

app.post('/api/mobile/capture/submissions', requireMobileAuth, async (req, res) => {
    const body = req.body || {};
    const payload = {
        session_id: pickFirstDefined(body.session_id, body.sessionId),
        install_id: pickFirstDefined(body.install_id, body.installId),
        device_key_id: pickFirstDefined(body.device_key_id, body.deviceKeyId),
        local_start_time: pickFirstDefined(body.local_start_time, body.localStartTime),
        local_end_time: pickFirstDefined(body.local_end_time, body.localEndTime),
        server_offset_start_ms: pickFirstDefined(body.server_offset_start_ms, body.serverOffsetStartMs),
        server_offset_end_ms: pickFirstDefined(body.server_offset_end_ms, body.serverOffsetEndMs),
        start_lat: pickFirstDefined(body.start_lat, body.startLat),
        start_lng: pickFirstDefined(body.start_lng, body.startLng),
        start_accuracy: pickFirstDefined(body.start_accuracy, body.startAccuracy),
        end_lat: pickFirstDefined(body.end_lat, body.endLat),
        end_lng: pickFirstDefined(body.end_lng, body.endLng),
        end_accuracy: pickFirstDefined(body.end_accuracy, body.endAccuracy),
        media_hash: pickFirstDefined(body.media_hash, body.mediaHash),
        file_size: pickFirstDefined(body.file_size, body.fileSize),
        mime_type: pickFirstDefined(body.mime_type, body.mimeType),
        file_name: pickFirstDefined(body.file_name, body.fileName),
        app_version: pickFirstDefined(body.app_version, body.appVersion),
        os_version: pickFirstDefined(body.os_version, body.osVersion),
        device_model: pickFirstDefined(body.device_model, body.deviceModel),
        note: body.note,
        business_name: pickFirstDefined(body.business_name, body.businessName),
        gstin: body.gstin,
        duration_seconds: pickFirstDefined(body.duration_seconds, body.durationSeconds),
        selected_venue_name: pickFirstDefined(body.selected_venue_name, body.selectedVenueName),
        selected_venue_address: pickFirstDefined(body.selected_venue_address, body.selectedVenueAddress),
        selected_venue_place_provider_id: pickFirstDefined(body.selected_venue_place_provider_id, body.selectedVenuePlaceProviderId),
        selected_venue_provider: pickFirstDefined(body.selected_venue_provider, body.selectedVenueProvider),
        selected_venue_city: pickFirstDefined(body.selected_venue_city, body.selectedVenueCity),
        selected_venue_latitude: pickFirstDefined(body.selected_venue_latitude, body.selectedVenueLatitude),
        selected_venue_longitude: pickFirstDefined(body.selected_venue_longitude, body.selectedVenueLongitude),
        radio_evidence: pickFirstDefined(body.radio_evidence, body.radioEvidence),
        source_classifier_mode: pickFirstDefined(body.source_classifier_mode, body.sourceClassifierMode),
    };
    const createdAt = new Date().toISOString();
    const data = await readPlatformData();
    const session = data.captureSessions.find((item) => item.id === payload.session_id && item.mobileUserId === req.mobileUser.id);
    const install = data.anonymousInstalls.find((item) => item.installId === payload.install_id && item.mobileUserId === req.mobileUser.id);

    if (!session || !install) {
        return res.status(404).json({ error: 'Submission context is invalid' });
    }

    const submission = await mutatePlatformData((draft) => {
        const selectedVenue = payload.selected_venue_name ? {
            placeProviderId: payload.selected_venue_place_provider_id || null,
            provider: normalizeVenueProvider(payload.selected_venue_provider) || null,
            name: payload.selected_venue_name,
            address: payload.selected_venue_address || '',
            city: payload.selected_venue_city || null,
            latitude: payload.selected_venue_latitude != null ? Number(payload.selected_venue_latitude) : null,
            longitude: payload.selected_venue_longitude != null ? Number(payload.selected_venue_longitude) : null
        } : null;

        const nextSubmission = {
            id: crypto.randomUUID(),
            reference: createReference('SC'),
            captureSessionId: payload.session_id,
            installId: payload.install_id,
            mobileUserId: req.mobileUser.id,
            rawVideoAssetId: null,
            derivedAudioAssetId: null,
            audioDeconstruction: null,
            mediaSha256: payload.media_hash || null,
            durationSeconds: Number(payload.duration_seconds || 0),
            geolocationStart: payload.start_lat != null && payload.start_lng != null
                ? {
                    lat: Number(payload.start_lat),
                    lon: Number(payload.start_lng),
                    accuracy: payload.start_accuracy != null ? Number(payload.start_accuracy) : null,
                    capturedAt: payload.local_start_time || createdAt
                }
                : null,
            geolocationEnd: payload.end_lat != null && payload.end_lng != null
                ? {
                    lat: Number(payload.end_lat),
                    lon: Number(payload.end_lng),
                    accuracy: payload.end_accuracy != null ? Number(payload.end_accuracy) : null,
                    capturedAt: payload.local_end_time || createdAt
                }
                : null,
            radioEvidence: normalizeRadioEvidence(payload.radio_evidence),
            consentVersion: 'snitchv1-mobile',
            status: 'received',
            uploadToken: crypto.randomBytes(16).toString('hex'),
            mimeType: payload.mime_type || 'video/mp4',
            fileName: payload.file_name || `${createReference('CAPTURE')}.mp4`,
            fileSize: Number(payload.file_size || 0),
            localStartTime: payload.local_start_time || null,
            localEndTime: payload.local_end_time || null,
            measuredStartOffsetMs: Number(payload.server_offset_start_ms || 0),
            measuredEndOffsetMs: Number(payload.server_offset_end_ms || 0),
            appVersion: payload.app_version || null,
            deviceModel: payload.device_model || null,
            osVersion: payload.os_version || null,
            note: payload.note || null,
            businessName: payload.business_name || null,
            gstin: payload.gstin || null,
            selectedVenue,
            matchedVenue: selectedVenue?.name || payload.business_name || null,
            sourceClassifierMode: normalizeSourceClassifierMode(payload.source_classifier_mode, DEFAULT_SOURCE_CLASSIFIER_MODE),
            rewardState: 'pending',
            rewardAmountInr: 0,
            createdAt,
            reportIds: [],
            source: 'snitchv1_mobile_pilot',
            hasValidSignature: false,
        };
        draft.submissions.push(nextSubmission);
        install.submissionCount = Number(install.submissionCount || 0) + 1;
        install.lastSeenAt = createdAt;
        const mobileUser = draft.mobileUsers.find((item) => item.id === req.mobileUser.id);
        if (mobileUser) {
            mobileUser.submissionCount = Number(mobileUser.submissionCount || 0) + 1;
            mobileUser.updatedAt = createdAt;
        }
        return nextSubmission;
    });

    res.json({
        submission_id: submission.id,
        reference_id: submission.reference,
        status: submission.status,
        created_at: submission.createdAt,
    });
});

app.post('/api/mobile/capture/submissions/:id/upload', requireMobileAuth, upload.single('video'), async (req, res) => {
    const submissionId = req.params.id;
    if (!req.file) {
        return res.status(400).json({ error: 'Video file is required' });
    }
    if (req.file.size > CAPTURE_POLICY.maxUploadBytes) {
        return res.status(400).json({ error: `Video exceeds ${CAPTURE_POLICY.maxUploadBytes} byte upload limit` });
    }

    const existingData = await readPlatformData();
    const existingSubmission = existingData.submissions.find((item) => item.id === submissionId && item.mobileUserId === req.mobileUser.id);
    if (!existingSubmission) {
        return res.status(404).json({ error: 'Submission not found' });
    }

    if (existingSubmission.rawVideoAssetId) {
        const existingAsset = await ensureAssetRecord({
            assetId: existingSubmission.rawVideoAssetId,
            kind: 'raw-video',
            fileName: existingSubmission.fileName,
            mimeType: existingSubmission.uploadedMimeType || existingSubmission.mimeType,
            metadata: { submissionId },
        });
        if (existingAsset) {
            return res.json({
                status: 'uploaded',
                submission_id: submissionId,
                asset_id: existingAsset.id,
                asset_url: buildAssetUrl(req, existingAsset),
                already_uploaded: true,
            });
        }
    }

    const acceptedMimeType = resolveAcceptedCaptureMimeType({
        requestedMimeType: req.file.mimetype,
        fallbackMimeType: existingSubmission.mimeType,
        fileName: req.file.originalname || existingSubmission.fileName,
    });
    if (!acceptedMimeType) {
        return res.status(400).json({ error: `Unsupported video type: ${req.file.mimetype}` });
    }

    const asset = await saveAsset({
        buffer: req.file.buffer,
        fileName: req.file.originalname || existingSubmission.fileName || `${existingSubmission.reference}.mp4`,
        mimeType: acceptedMimeType,
        kind: 'raw-video',
        metadata: { submissionId, source: 'snitchv1_mobile_pilot' },
    });

    const result = await mutatePlatformData((data) => {
        const submission = data.submissions.find((item) => item.id === submissionId && item.mobileUserId === req.mobileUser.id);
        if (!submission) {
            throw new Error('Submission not found');
        }
        submission.rawVideoAssetId = asset.id;
        submission.uploadedMimeType = acceptedMimeType;
        submission.fileName = req.file.originalname || submission.fileName;
        submission.fileSize = req.file.size;
        submission.status = 'uploaded';
        submission.updatedAt = new Date().toISOString();
        return submission;
    }).catch((error) => ({ error }));

    if (result.error) {
        return res.status(404).json({ error: result.error.message });
    }

    res.json({
        status: 'uploaded',
        submission_id: submissionId,
        asset_id: asset.id,
        asset_url: buildAssetUrl(req, asset),
        already_uploaded: false,
    });
});

app.post('/api/mobile/capture/submissions/:id/finalize', requireMobileAuth, async (req, res) => {
    const submissionId = req.params.id;
    const media_hash = pickFirstDefined(req.body?.media_hash, req.body?.mediaHash);
    const result = await mutatePlatformData((data) => {
        const submission = data.submissions.find((item) => item.id === submissionId && item.mobileUserId === req.mobileUser.id);
        if (!submission) {
            throw new Error('Submission not found');
        }
        if (!submission.rawVideoAssetId) {
            throw new Error('Raw video must be uploaded before finalize');
        }

        submission.mediaSha256 = media_hash || submission.mediaSha256 || null;
        submission.status = 'processing';
        submission.finalizedAt = new Date().toISOString();
        submission.processingStartedAt = new Date().toISOString();
        submission.processingError = null;
        return submission;
    }).catch((error) => ({ error }));

    if (result.error) {
        return res.status(404).json({ error: result.error.message });
    }

    queueSubmissionProcessing(submissionId);

    res.json({
        submission_id: result.id,
        reference_id: result.reference,
        status: result.status,
        created_at: result.createdAt,
    });
});

app.get('/api/mobile/capture/submissions/:id/status', requireMobileAuth, async (req, res) => {
    const data = await readPlatformData();
    const submission = data.submissions.find((item) => item.id === req.params.id && item.mobileUserId === req.mobileUser.id);
    if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
    }

    res.set('Cache-Control', 'no-store');
    res.json(buildMobileSubmissionSummary(data, submission));
});

const buildTimeSyncPayload = () => {
    const now = new Date();
    return {
        serverTime: now.toISOString(),
        server_time: now.toISOString(),
        unix_ms: now.getTime(),
        clockSkewToleranceMs: CLOCK_SKEW_TOLERANCE_MS
    };
};

app.get('/api/capture/time', async (req, res) => {
    res.json(buildTimeSyncPayload());
});

app.post('/api/capture/time', async (req, res) => {
    res.json(buildTimeSyncPayload());
});

app.get('/api/mobile/capture/time', async (req, res) => {
    res.json(buildTimeSyncPayload());
});

app.post('/api/mobile/capture/time', async (req, res) => {
    res.json(buildTimeSyncPayload());
});

app.post('/api/capture/install', async (req, res) => {
    const { installId, publicKey, deviceTraits, appVersion, inviteCode } = req.body;

    if (!publicKey) {
        return res.status(400).json({ error: 'Public key is required' });
    }

    const now = new Date().toISOString();
    const finalInstallId = installId || crypto.randomUUID();

    const response = await mutatePlatformData((data) => {
        const contributor = inviteCode ? findContributorByInviteCode(data, inviteCode) : null;
        if (inviteCode && !contributor) {
            throw new Error('Invite code is invalid or inactive');
        }

        let install = data.anonymousInstalls.find((item) => item.installId === finalInstallId);
        if (!install) {
            install = {
                installId: finalInstallId,
                publicKey,
                deviceProfileHash: stableHash(deviceTraits || {}),
                userAgentHash: stableHash(req.headers['user-agent'] || ''),
                ipHash: hashIp(req.ip),
                firstSeenAt: now,
                lastSeenAt: now,
                submissionCount: 0,
                abuseScore: 0,
                appVersion: appVersion || 'unknown',
                deviceTraits: deviceTraits || {},
                contributorId: contributor?.id || null
            };
            data.anonymousInstalls.push(install);
        } else {
            install.publicKey = publicKey;
            install.deviceProfileHash = stableHash(deviceTraits || {});
            install.userAgentHash = stableHash(req.headers['user-agent'] || '');
            install.ipHash = hashIp(req.ip);
            install.lastSeenAt = now;
            install.deviceTraits = deviceTraits || install.deviceTraits;
            install.appVersion = appVersion || install.appVersion;
            install.contributorId = contributor?.id || install.contributorId || null;
        }

        install.abuseScore = scoreInstallAbuse(install, data.submissions);
        const linkedContributor = install.contributorId
            ? data.contributors.find((item) => item.id === install.contributorId) || null
            : null;

        return {
            installId: install.installId,
            abuseState: {
                status: install.abuseScore >= 60 ? 'restricted' : install.abuseScore >= 25 ? 'watch' : 'clear',
                score: install.abuseScore
            },
            capturePolicy: CAPTURE_POLICY,
            rewardsProgram: buildRewardProgramResponse(data, linkedContributor)
        };
    }).catch((error) => ({ error }));

    if (response.error) {
        return res.status(400).json({ error: response.error.message });
    }

    res.json(response);
});

app.post('/api/capture/session', async (req, res) => {
    const { installId } = req.body;
    if (!installId) {
        return res.status(400).json({ error: 'installId is required' });
    }

    const now = new Date().toISOString();
    const session = await mutatePlatformData((data) => {
        const install = data.anonymousInstalls.find((item) => item.installId === installId);
        if (!install) {
            throw new Error('Unknown install');
        }

        const newSession = {
            id: crypto.randomUUID(),
            installId,
            sessionNonce: crypto.randomBytes(12).toString('hex'),
            issuedServerTime: now,
            startServerTime: null,
            endServerTime: null,
            measuredStartOffsetMs: null,
            measuredEndOffsetMs: null,
            geolocationStart: null,
            geolocationEnd: null,
            status: 'session_created',
            createdAt: now
        };
        data.captureSessions.push(newSession);
        return newSession;
    }).catch((error) => ({ error }));

    if (session.error) {
        return res.status(404).json({ error: session.error.message });
    }

    res.json({
        captureSessionId: session.id,
        sessionNonce: session.sessionNonce,
        serverTime: session.issuedServerTime,
        clockSkewToleranceMs: CLOCK_SKEW_TOLERANCE_MS,
        capturePolicy: CAPTURE_POLICY,
        uploadPolicy: {
            maxUploadBytes: CAPTURE_POLICY.maxUploadBytes,
            acceptedMimeTypes: CAPTURE_POLICY.acceptedMimeTypes
        }
    });
});

app.post('/api/capture/session/:id/start', async (req, res) => {
    const payload = req.body;
    const sessionId = req.params.id;

    const result = await mutatePlatformData(async (data) => {
        const session = data.captureSessions.find((item) => item.id === sessionId);
        const install = data.anonymousInstalls.find((item) => item.installId === payload.installId);
        if (!session || !install) {
            throw new Error('Capture session not found');
        }
        if (session.installId !== payload.installId) {
            throw new Error('Install does not own this capture session');
        }

        const isValidSignature = await verifyInstallSignature({
            publicKey: install.publicKey,
            payload: buildSignedSessionPayload({
                captureSessionId: sessionId,
                installId: payload.installId,
                localTime: payload.localTime,
                measuredOffsetMs: payload.measuredOffsetMs,
                geolocation: payload.geolocation,
                deviceSnapshot: payload.deviceSnapshot
            }),
            signature: payload.signature
        });

        if (!isValidSignature) {
            throw new Error('Invalid session signature');
        }

        session.startServerTime = new Date().toISOString();
        session.measuredStartOffsetMs = Number(payload.measuredOffsetMs || 0);
        session.geolocationStart = payload.geolocation || null;
        session.deviceSnapshot = payload.deviceSnapshot || null;
        session.localStartTime = payload.localTime || null;
        session.status = 'recording_started';

        return session;
    }).catch((error) => ({ error }));

    if (result.error) {
        return res.status(400).json({ error: result.error.message });
    }

    res.json({ ok: true, captureSessionId: result.id, startedAt: result.startServerTime });
});

app.post('/api/capture/submissions', async (req, res) => {
    const { captureSessionId, installId, mimeType, fileName } = req.body;
    const sourceClassifierMode = normalizeSourceClassifierMode(
        pickFirstDefined(req.body?.sourceClassifierMode, req.body?.source_classifier_mode),
        DEFAULT_SOURCE_CLASSIFIER_MODE
    );

    const submission = await mutatePlatformData((data) => {
        const session = data.captureSessions.find((item) => item.id === captureSessionId);
        const install = data.anonymousInstalls.find((item) => item.installId === installId);
        if (!session || !install) {
            throw new Error('Capture session not found');
        }
        if (session.installId !== installId) {
            throw new Error('Install does not own this capture session');
        }
        if (session.status !== 'recording_started') {
            throw new Error('Capture session must be started before creating a submission');
        }
        if (mimeType && !isAcceptedCaptureMimeType(mimeType)) {
            throw new Error(`Unsupported capture MIME type: ${mimeType}`);
        }

        const newSubmission = {
            id: crypto.randomUUID(),
            reference: createReference('SUB'),
            captureSessionId,
            installId,
            rawVideoAssetId: null,
            derivedAudioAssetId: null,
            audioDeconstruction: null,
            mediaSha256: null,
            durationSeconds: null,
            geolocationStart: session.geolocationStart,
            geolocationEnd: null,
            consentVersion: '2026-03-07',
            status: 'session_created',
            uploadToken: crypto.randomBytes(16).toString('hex'),
            mimeType,
            fileName,
            sourceClassifierMode,
            createdAt: new Date().toISOString(),
            reportIds: [],
            hasValidSignature: false
        };
        data.submissions.push(newSubmission);
        return newSubmission;
    }).catch((error) => ({ error }));

    if (submission.error) {
        return res.status(400).json({ error: submission.error.message });
    }

    res.json({
        submissionId: submission.id,
        reference: submission.reference,
        uploadUrl: `/api/capture/submissions/${submission.id}/upload`,
        uploadToken: submission.uploadToken
    });
});

app.post('/api/capture/submissions/:id/upload', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Video file is required' });
    }
    if (req.file.size > CAPTURE_POLICY.maxUploadBytes) {
        return res.status(400).json({ error: `Video exceeds ${CAPTURE_POLICY.maxUploadBytes} byte upload limit` });
    }

    const submissionId = req.params.id;
    const uploadToken = req.headers['x-upload-token'];
    if (!uploadToken) {
        return res.status(401).json({ error: 'Upload token is required' });
    }

    const data = await readPlatformData();
    const existingSubmission = data.submissions.find((item) => item.id === submissionId);
    if (!existingSubmission || existingSubmission.uploadToken !== uploadToken) {
        return res.status(400).json({ error: 'Invalid upload token' });
    }

    if (existingSubmission.rawVideoAssetId) {
        const existingAsset = await ensureAssetRecord({
            assetId: existingSubmission.rawVideoAssetId,
            kind: 'raw-video',
            fileName: existingSubmission.fileName,
            mimeType: existingSubmission.uploadedMimeType || existingSubmission.mimeType,
            metadata: { submissionId }
        });
        if (existingAsset) {
            return res.json({
                assetId: existingAsset.id,
                assetUrl: buildAssetUrl(req, existingAsset),
                submissionId: existingSubmission.id,
                alreadyUploaded: true
            });
        }
    }

    const acceptedMimeType = resolveAcceptedCaptureMimeType({
        requestedMimeType: req.file.mimetype,
        fallbackMimeType: existingSubmission.mimeType,
        fileName: req.file.originalname || existingSubmission.fileName
    });
    if (!acceptedMimeType) {
        return res.status(400).json({ error: `Unsupported video type: ${req.file.mimetype}` });
    }

    const asset = await saveAsset({
        buffer: req.file.buffer,
        fileName: req.file.originalname || existingSubmission.fileName || `${existingSubmission.reference}.webm`,
        mimeType: acceptedMimeType,
        kind: 'raw-video',
        metadata: { submissionId }
    });

    const submission = await mutatePlatformData(async (draft) => {
        const submissionRecord = draft.submissions.find((item) => item.id === submissionId);
        if (!submissionRecord || submissionRecord.uploadToken !== uploadToken) {
            throw new Error('Invalid upload token');
        }
        if (submissionRecord.rawVideoAssetId) {
            const currentAsset = draft.assets.find((existingAsset) => existingAsset.id === submissionRecord.rawVideoAssetId)
                || (submissionRecord.rawVideoAssetId === asset.id ? asset : null);
            if (currentAsset) {
                return { submissionRecord, asset: currentAsset, alreadyUploaded: true };
            }
        }

        submissionRecord.rawVideoAssetId = asset.id;
        submissionRecord.uploadedMimeType = acceptedMimeType;
        submissionRecord.status = 'uploaded';
        return { submissionRecord, asset };
    }).catch((error) => ({ error }));

    if (submission.error) {
        return res.status(400).json({ error: submission.error.message });
    }

    res.json({
        assetId: submission.asset.id,
        assetUrl: buildAssetUrl(req, submission.asset),
        submissionId: submission.submissionRecord.id,
        alreadyUploaded: Boolean(submission.alreadyUploaded)
    });
});

app.post('/api/capture/submissions/:id/finalize', async (req, res) => {
    const submissionId = req.params.id;
    const payload = req.body;

    const result = await mutatePlatformData(async (data) => {
        const submission = data.submissions.find((item) => item.id === submissionId);
        const session = data.captureSessions.find((item) => item.id === payload.captureSessionId);
        const install = data.anonymousInstalls.find((item) => item.installId === payload.installId);

        if (!submission || !session || !install) {
            throw new Error('Submission context is invalid');
        }
        if (submission.captureSessionId !== payload.captureSessionId || submission.installId !== payload.installId) {
            throw new Error('Submission does not belong to this install/session');
        }
        if (session.installId !== payload.installId) {
            throw new Error('Install does not own this capture session');
        }
        if (!submission.rawVideoAssetId) {
            throw new Error('Raw video must be uploaded before finalize');
        }
        if (session.status !== 'recording_started' && session.status !== 'uploaded') {
            throw new Error('Capture session is not ready to finalize');
        }

        const durationSeconds = Number(payload.durationSeconds);
        if (Number.isNaN(durationSeconds) || durationSeconds < CAPTURE_POLICY.minSeconds || durationSeconds > CAPTURE_POLICY.maxSeconds + 0.5) {
            throw new Error(`Recording must be between ${CAPTURE_POLICY.minSeconds} and ${CAPTURE_POLICY.maxSeconds} seconds`);
        }

        const isValidSignature = await verifyInstallSignature({
            publicKey: install.publicKey,
            payload: buildSignedFinalizePayload({
                captureSessionId: payload.captureSessionId,
                submissionId,
                installId: payload.installId,
                mediaSha256: payload.mediaSha256,
                localEndTime: payload.localEndTime,
                measuredEndOffsetMs: payload.measuredEndOffsetMs,
                durationSeconds,
                geolocationEnd: payload.geolocationEnd
            }),
            signature: payload.signature
        });

        if (!isValidSignature) {
            throw new Error('Invalid finalize signature');
        }

        session.endServerTime = new Date().toISOString();
        session.measuredEndOffsetMs = Number(payload.measuredEndOffsetMs || 0);
        session.geolocationEnd = payload.geolocationEnd || null;
        session.status = 'uploaded';

        install.submissionCount += 1;
        install.lastSeenAt = new Date().toISOString();
        install.abuseScore = scoreInstallAbuse(install, data.submissions);

        submission.mediaSha256 = payload.mediaSha256;
        submission.durationSeconds = durationSeconds;
        submission.localStartTime = payload.localStartTime || null;
        submission.localEndTime = payload.localEndTime;
        submission.measuredStartOffsetMs = Number(payload.measuredStartOffsetMs || session.measuredStartOffsetMs || 0);
        submission.measuredEndOffsetMs = Number(payload.measuredEndOffsetMs || 0);
        submission.geolocationEnd = payload.geolocationEnd || null;
        submission.gpsTrack = Array.isArray(payload.gpsTrack) && payload.gpsTrack.length >= 2
            ? payload.gpsTrack
            : null;
        submission.gpsTrackAnalysis = submission.gpsTrack ? analyzeGpsTrack(submission.gpsTrack) : null;
        submission.clockSkewFlag = Math.max(
            Math.abs(Number(payload.measuredStartOffsetMs || session.measuredStartOffsetMs || 0)),
            Math.abs(Number(payload.measuredEndOffsetMs || 0))
        ) > CLOCK_SKEW_TOLERANCE_MS;
        submission.status = install.abuseScore >= 80 ? 'rejected_abuse' : 'processing';
        submission.hasValidSignature = true;
        submission.finalizedAt = new Date().toISOString();

        return {
            submission,
            abuseScore: install.abuseScore
        };
    }).catch((error) => ({ error }));

    if (result.error) {
        return res.status(400).json({ error: result.error.message });
    }

    if (result.submission.status === 'processing') {
        queueSubmissionProcessing(submissionId);
    }

    res.json({
        submissionId,
        reference: result.submission.reference,
        status: result.submission.status,
        abuseScore: result.abuseScore
    });
});

app.get('/api/capture/submissions/:id/status', async (req, res) => {
    const data = await readPlatformData();
    const submission = data.submissions.find((item) => item.id === req.params.id);

    if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
    }

    const contributor = getContributorByInstall(data, submission.installId);
    const cases = data.caseLedger.filter((entry) => entry.primarySubmissionId === submission.id || entry.reportIds?.some((reportId) => submission.reportIds?.includes(reportId)));
    const rewardSummary = {
        eligibleCases: cases.filter((entry) => entry.rewardEligible).length,
        estimatedRecoverableValueInr: cases.reduce((sum, entry) => sum + Number(entry.estimatedRecoverableValueInr || 0), 0),
        heldAmountInr: data.rewardLedger
            .filter((reward) => reward.submissionId === submission.id && reward.status === 'held')
            .reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0),
        paidAmountInr: data.rewardLedger
            .filter((reward) => reward.submissionId === submission.id && reward.status === 'paid')
            .reduce((sum, reward) => sum + Number(reward.amountInr || 0), 0)
    };

    res.set('Cache-Control', 'no-store');
    res.json({
        submissionId: submission.id,
        reference: submission.reference,
        status: submission.status,
        reportIds: submission.reportIds || [],
        processingError: submission.processingError || null,
        finalizedAt: submission.finalizedAt || null,
        clockSkewFlag: Boolean(submission.clockSkewFlag),
        rewardsProgram: buildRewardProgramResponse(data, contributor),
        rewardSummary,
        cases: cases.map((entry) => buildCaseView(data, entry))
    });
});

app.post('/api/capture/submissions/:id/retry', async (req, res) => {
    const submissionId = req.params.id;
    const data = await readPlatformData();
    const submission = data.submissions.find((item) => item.id === submissionId);

    if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
    }
    if (!['failed', 'uploaded'].includes(submission.status)) {
        return res.status(400).json({ error: `Submission cannot be retried from status: ${submission.status}` });
    }

    const repairedAsset = await ensureAssetRecord({
        assetId: submission.rawVideoAssetId,
        kind: 'raw-video',
        fileName: submission.fileName,
        mimeType: submission.uploadedMimeType || submission.mimeType,
        metadata: { submissionId }
    });
    if (!repairedAsset) {
        return res.status(400).json({ error: 'Submission has no recoverable raw video asset' });
    }

    await mutatePlatformData((draft) => {
        const submissionRecord = draft.submissions.find((item) => item.id === submissionId);
        if (!submissionRecord) {
            throw new Error('Submission not found');
        }

        submissionRecord.status = 'processing';
        submissionRecord.processingError = null;
        submissionRecord.processingStartedAt = new Date().toISOString();
    }).catch((error) => ({ error }));

    queueSubmissionProcessing(submissionId);

    res.json({
        submissionId: submission.id,
        reference: submission.reference,
        status: 'processing'
    });
});

app.get('/api/portal/dashboard', requireAuth, async (req, res) => {
    const data = await readPlatformData();
    const reports = filterReportsForUser(data, req.portalUser);
    res.json({
        org: req.portalUser.org,
        ...buildDashboardPayload(data, reports, req.portalUser)
    });
});

app.get('/api/portal/reports', requireAuth, async (req, res) => {
    const data = await readPlatformData();
    let reports = filterReportsForUser(data, req.portalUser);

    if (req.query.status) {
        reports = reports.filter((report) => report.analystStatus === req.query.status);
    }
    if (req.query.venueId) {
        reports = reports.filter((report) => report.venueId === req.query.venueId);
    }

    res.json({
        reports: reports
            .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
            .map((report) => buildReportView(req, data, report))
    });
});

app.get('/api/portal/reports/:id', requireAuth, async (req, res) => {
    const data = await readPlatformData();
    const report = filterReportsForUser(data, req.portalUser).find((item) => item.id === req.params.id);
    if (!report) {
        return res.status(404).json({ error: 'Report not found' });
    }

    res.json({ report: buildReportView(req, data, report) });
});

app.post('/api/portal/reports/:id/review', requireAuth, async (req, res) => {
    const result = await mutatePlatformData((data) => {
        const visible = filterReportsForUser(data, req.portalUser);
        const report = visible.find((item) => item.id === req.params.id);
        if (!report) {
            throw new Error('Report not found');
        }

        report.analystStatus = req.body.verdict;
        report.updatedAt = new Date().toISOString();

        const review = {
            id: crypto.randomUUID(),
            reportId: report.id,
            reviewerId: req.portalUser.sub,
            verdict: req.body.verdict,
            tags: req.body.tags || [],
            notes: req.body.notes || '',
            reviewedAt: new Date().toISOString()
        };
        data.analystReviews.push(review);

        const caseRecord = report.caseId ? data.caseLedger.find((entry) => entry.id === report.caseId) || null : null;
        if (caseRecord) {
            caseRecord.updatedAt = new Date().toISOString();
            if (req.body.verdict === 'confirmed') {
                caseRecord.caseStatus = caseRecord.rewardEligible ? 'confirmed_actionable' : caseRecord.caseStatus;
                const contributor = caseRecord.primaryContributorId
                    ? data.contributors.find((item) => item.id === caseRecord.primaryContributorId) || null
                    : null;
                const merchant = caseRecord.merchantMasterId
                    ? data.merchantMaster.find((item) => item.id === caseRecord.merchantMasterId) || null
                    : null;
                ensureStageRewardsForCase({
                    data,
                    caseRecord,
                    report,
                    contributor,
                    merchant,
                    createdAt: new Date().toISOString(),
                    verdict: 'confirmed'
                });
            } else if (req.body.verdict === 'rejected' && caseRecord.primaryReportId === report.id) {
                caseRecord.caseStatus = 'rejected';
                reverseRewardEntriesForCase(data, caseRecord.id, 'Primary report rejected during analyst review');
            }
        }
        return report;
    }).catch((error) => ({ error }));

    if (result.error) {
        return res.status(404).json({ error: result.error.message });
    }

    res.json({ ok: true, reportId: result.id, analystStatus: result.analystStatus });
});

app.post('/api/portal/reports/:id/source-review', requireAuth, async (req, res) => {
    let sourceReviewInput;
    try {
        sourceReviewInput = normalizeSourceReviewInput(req.body);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    const result = await mutatePlatformData((data) => {
        const visible = filterReportsForUser(data, req.portalUser);
        const report = visible.find((item) => item.id === req.params.id);
        if (!report) {
            throw new Error('Report not found');
        }

        const reviewedAt = new Date().toISOString();
        const sourceReview = createSourceReviewEntry({
            report,
            reviewerId: req.portalUser.sub,
            input: sourceReviewInput,
            reviewedAt,
        });

        data.sourceReviews.push(sourceReview);
        report.sourceReview = sourceReview;
        report.updatedAt = reviewedAt;

        return {
            reportId: report.id,
            sourceReview,
        };
    }).catch((error) => ({ error }));

    if (result.error) {
        return res.status(404).json({ error: result.error.message });
    }

    res.json({
        ok: true,
        reportId: result.reportId,
        sourceReview: result.sourceReview,
    });
});

app.get('/api/portal/venues/:id', requireAuth, async (req, res) => {
    const data = await readPlatformData();
    const reports = filterReportsForUser(data, req.portalUser).filter((report) => report.venueId === req.params.id);
    const venue = data.venues.find((item) => item.id === req.params.id);
    const coverage = data.venueCoverage.filter((item) => item.venueId === req.params.id);
    const merchant = data.merchantMaster.find((item) => item.venueId === req.params.id) || null;
    const licenseStatuses = data.licenseStatus.filter((item) => item.venueId === req.params.id);
    const cases = data.caseLedger.filter((entry) => entry.venueId === req.params.id);

    if (!venue) {
        return res.status(404).json({ error: 'Venue not found' });
    }

    res.json({
        venue,
        merchant,
        coverage,
        licenseStatuses,
        metrics: {
            totalReports: reports.length,
            confirmedReports: reports.filter((report) => report.analystStatus === 'confirmed').length,
            repeatOffenderScore: computeRepeatOffenderScore(reports),
            uniqueSongs: new Set(reports.map((report) => `${report.title}::${report.artist}`)).size,
            lastSeenAt: reports.reduce((latest, report) => latest > report.createdAt ? latest : report.createdAt, venue.lastSeenAt || null)
        },
        reports: reports.map((report) => buildReportView(req, data, report)),
        cases: cases.map((entry) => buildCaseView(data, entry))
    });
});

app.post('/api/portal/case-packets', requireAuth, async (req, res) => {
    const reportIds = req.body.reportIds || [];
    if (!Array.isArray(reportIds) || !reportIds.length) {
        return res.status(400).json({ error: 'reportIds is required' });
    }

    const data = await readPlatformData();
    const reports = filterReportsForUser(data, req.portalUser).filter((report) => reportIds.includes(report.id));
    if (!reports.length) {
        return res.status(404).json({ error: 'No reports available for export' });
    }

    const exportReports = reports.map((report) => {
        const view = buildReportView(req, data, report);
        return {
            ...view,
            venueHistory: buildVenueHistorySummary(data, report)
        };
    });
    const exportedAt = new Date().toISOString();
    const exportPayload = {
        casePacketVersion: 'case-packet-v2',
        exportedAt,
        exportedBy: {
            userId: req.portalUser.sub,
            orgId: req.portalUser.orgId,
        },
        reportCount: exportReports.length,
        reports: exportReports,
    };

    const asset = await saveAsset({
        buffer: Buffer.from(JSON.stringify(exportPayload, null, 2)),
        fileName: `case-packet-${Date.now()}.json`,
        mimeType: 'application/json',
        kind: 'case-packets',
        metadata: { reportIds, casePacketVersion: exportPayload.casePacketVersion, reportCount: exportReports.length }
    });

    const casePacket = await mutatePlatformData((draft) => {
        const packet = {
            id: crypto.randomUUID(),
            orgId: req.portalUser.orgId,
            reportIds,
            exportAssetId: asset.id,
            exportedBy: req.portalUser.sub,
            exportedAt
        };
        draft.casePackets.push(packet);
        draft.reports.forEach((report) => {
            if (reportIds.includes(report.id)) {
                report.exportStatus = 'exported';
                report.updatedAt = new Date().toISOString();
            }
        });
        return packet;
    });

    res.json({
        casePacketId: casePacket.id,
        exportUrl: buildAssetUrl(req, asset)
    });
});

app.post('/api/portal/cases/:id/outcome', requireAuth, async (req, res) => {
    const realizedValueInr = Number(req.body.realizedValueInr || 0);
    if (!Number.isFinite(realizedValueInr) || realizedValueInr <= 0) {
        return res.status(400).json({ error: 'realizedValueInr must be a positive number' });
    }

    const result = await mutatePlatformData((data) => {
        const visibleReportIds = new Set(filterReportsForUser(data, req.portalUser).map((report) => report.id));
        const caseRecord = data.caseLedger.find((entry) => entry.id === req.params.id && entry.reportIds?.some((reportId) => visibleReportIds.has(reportId)));
        if (!caseRecord) {
            throw new Error('Case not found');
        }
        if (!caseRecord.rewardEligible) {
            throw new Error('Case is not reward eligible');
        }

        caseRecord.realizedValueInr = realizedValueInr;
        caseRecord.settlementSignedAt = req.body.settlementSignedAt || new Date().toISOString().slice(0, 10);
        caseRecord.outcomeType = req.body.outcomeType || 'license_signed';
        caseRecord.caseStatus = 'realized';
        caseRecord.updatedAt = new Date().toISOString();

        const primaryReport = data.reports.find((report) => report.id === caseRecord.primaryReportId) || null;
        const contributor = caseRecord.primaryContributorId
            ? data.contributors.find((item) => item.id === caseRecord.primaryContributorId) || null
            : null;
        const merchant = caseRecord.merchantMasterId
            ? data.merchantMaster.find((item) => item.id === caseRecord.merchantMasterId) || null
            : null;
        const existingReward = data.rewardLedger.find((reward) => reward.caseId === caseRecord.id && reward.stage === REWARD_STAGE_KEYS.outcomeBonus && reward.status !== 'reversed');

        if (!existingReward && contributor && merchant) {
            createRewardLedgerEntry({
                data,
                caseRecord,
                report: primaryReport,
                contributor,
                stage: REWARD_STAGE_KEYS.outcomeBonus,
                amountInr: calculateOutcomeBonus({ merchant, realizedValueInr }),
                createdAt: new Date().toISOString(),
                notes: 'Stage 3 realized outcome bonus',
                metadata: {
                    outcomeType: caseRecord.outcomeType
                }
            });
        }

        return caseRecord;
    }).catch((error) => ({ error }));

    if (result.error) {
        return res.status(400).json({ error: result.error.message });
    }

    const data = await readPlatformData();
    const updatedCase = data.caseLedger.find((entry) => entry.id === result.id) || null;
    res.json({ case: buildCaseView(data, updatedCase) });
});

app.get('/api/authority-prototype/cases', async (req, res) => {
    const data = await readPlatformData();
    const cases = data.caseLedger
        .map((caseRecord) => buildPrototypeCaseView(req, data, caseRecord))
        .filter(Boolean)
        .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));

    res.json({
        cases,
        generatedAt: new Date().toISOString(),
    });
});

app.get('/api/authority-prototype/cases/:id/readiness', async (req, res) => {
    const data = await readPlatformData();
    const caseView = getPrototypeCaseViewByIdentifier(req, data, req.params.id);
    if (!caseView) {
        return res.status(404).json({ error: 'Case not found' });
    }
    res.json({
        case_id: caseView.id,
        readiness_score: caseView.readiness_score,
        readiness_band: caseView.readiness_band,
        readiness_label: caseView.readiness?.readiness_label,
        readiness_reasons: caseView.readiness_reasons,
        next_actions: caseView.next_actions,
        prosecution_strength_score: caseView.prosecution_strength_score,
        prosecution_strength_label: caseView.prosecution_strength_label,
        prosecution_strength_reasons: caseView.prosecution_strength_reasons,
        gates: caseView.readiness?.gates || null,
    });
});

app.get('/api/cases/:id/readiness', async (req, res) => {
    const data = await readPlatformData();
    const caseView = getPrototypeCaseViewByIdentifier(req, data, req.params.id);
    if (!caseView) return res.status(404).json({ error: 'Case not found' });
    res.json(caseView.readiness);
});

app.get('/api/authority-prototype/cases/:id/litigation-eligibility', async (req, res) => {
    const data = await readPlatformData();
    const caseView = getPrototypeCaseViewByIdentifier(req, data, req.params.id);
    if (!caseView) {
        return res.status(404).json({ error: 'Case not found' });
    }
    res.json(evaluateLitigationEligibility({ caseView, licenseResolution: caseView.licenseResolution }));
});

app.get('/api/cases/:id/litigation-eligibility', async (req, res) => {
    const data = await readPlatformData();
    const caseView = getPrototypeCaseViewByIdentifier(req, data, req.params.id);
    if (!caseView) return res.status(404).json({ error: 'Case not found' });
    res.json(evaluateLitigationEligibility({ caseView, licenseResolution: caseView.licenseResolution }));
});

app.post('/api/authority-prototype/cases/:id/litigation-submit', async (req, res) => {
    const actorId = String(req.body?.actorId || req.body?.actorRole || 'Admin').trim() || 'Admin';
    const data = await readPlatformData();
    const caseView = getPrototypeCaseViewByIdentifier(req, data, req.params.id);
    if (!caseView) {
        return res.status(404).json({ error: 'Case not found' });
    }
    const eligibility = evaluateLitigationEligibility({ caseView, licenseResolution: caseView.licenseResolution });
    if (!eligibility.can_send_to_litigation) {
        return res.status(409).json({
            error: 'Case is blocked from litigation submission',
            ...eligibility,
        });
    }

    await mutatePlatformData((draft) => {
        const caseRecord = getPrototypeCaseRecordByIdentifier(draft, req.params.id);
        const primaryReport = getPrimaryReportForCaseRecord(draft, caseRecord);
        if (!caseRecord || !primaryReport) throw new Error('Case not found');
        caseRecord.litigationSubmittedAt = new Date().toISOString();
        caseRecord.litigationSubmittedBy = actorId;
        appendEnforcementAuditEvent({
            caseRecord,
            primaryReport,
            eventType: 'Litigation Submission',
            actorId,
            previousValue: null,
            newValue: { litigationSubmittedAt: caseRecord.litigationSubmittedAt },
            source: 'litigation-submit',
            notes: 'Case submitted to litigation after server-side eligibility check.',
        });
    });

    const updatedData = await readPlatformData();
    res.json({
        ok: true,
        eligibility,
        case: getPrototypeCaseViewByIdentifier(req, updatedData, req.params.id),
    });
});

app.post('/api/cases/:id/litigation-submit', async (req, res) => {
    req.url = `/api/authority-prototype/cases/${req.params.id}/litigation-submit`;
    app._router.handle(req, res);
});

app.get('/api/authority-prototype/cases/:id/license-resolution', async (req, res) => {
    const data = await readPlatformData();
    const caseRecord = getPrototypeCaseRecordByIdentifier(data, req.params.id);
    const primaryReport = getPrimaryReportForCaseRecord(data, caseRecord);
    if (!caseRecord || !primaryReport) {
        return res.status(404).json({ error: 'Case not found' });
    }
    res.json(buildLicenseResolution({ caseRecord, report: primaryReport }));
});

app.get('/api/cases/:id/license-resolution', async (req, res) => {
    const data = await readPlatformData();
    const caseRecord = getPrototypeCaseRecordByIdentifier(data, req.params.id);
    const primaryReport = getPrimaryReportForCaseRecord(data, caseRecord);
    if (!caseRecord || !primaryReport) return res.status(404).json({ error: 'Case not found' });
    res.json(buildLicenseResolution({ caseRecord, report: primaryReport }));
});

app.post('/api/authority-prototype/cases/:id/license-resolution', async (req, res) => {
    const nextStatus = normalizeLicenseStatus(req.body?.license_status || req.body?.licenseStatus);
    const actorId = String(req.body?.actorId || req.body?.actorRole || 'Admin').trim() || 'Admin';
    const source = String(req.body?.source || req.body?.license_source || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const registryLookupId = req.body?.registry_lookup_id || req.body?.registryLookupId || null;
    const registrySnapshot = req.body?.registry_response_snapshot || req.body?.registryResponseSnapshot || null;

    if (!Object.values(LICENSE_STATUSES).includes(nextStatus)) {
        return res.status(400).json({ error: 'Invalid license status' });
    }
    if (!source) {
        return res.status(400).json({ error: 'License resolution source is required' });
    }
    if ([LICENSE_STATUSES.LICENSED, LICENSE_STATUSES.UNLICENSED].includes(nextStatus) && !notes) {
        return res.status(400).json({ error: 'Manual attestation notes are required for resolved license statuses' });
    }

    const result = await mutatePlatformData((draft) => {
        const caseRecord = getPrototypeCaseRecordByIdentifier(draft, req.params.id);
        const primaryReport = getPrimaryReportForCaseRecord(draft, caseRecord);
        if (!caseRecord || !primaryReport) throw new Error('Case not found');
        const previousValue = buildLicenseResolution({ caseRecord, report: primaryReport });
        const checkedAt = new Date().toISOString();
        caseRecord.licenseResolution = {
            license_status: nextStatus,
            license_source: source,
            license_checked_at: checkedAt,
            license_checked_by: actorId,
            manual_attestation: {
                actor_id: actorId,
                occurred_at: checkedAt,
                source,
                notes,
            },
            registry_lookup_id: registryLookupId,
            registry_response_snapshot: registrySnapshot,
        };
        caseRecord.licenseStatus = nextStatus.toLowerCase();
        caseRecord.licenseSource = source;
        appendEnforcementAuditEvent({
            caseRecord,
            primaryReport,
            eventType: 'Rights Status Changed',
            actorId,
            previousValue,
            newValue: caseRecord.licenseResolution,
            source,
            notes,
        });
        return caseRecord;
    }).catch((error) => ({ error }));

    if (result.error) {
        return res.status(400).json({ error: result.error.message });
    }

    const data = await readPlatformData();
    res.json({
        ok: true,
        licenseResolution: buildLicenseResolution({
            caseRecord: getPrototypeCaseRecordByIdentifier(data, req.params.id),
            report: getPrimaryReportForCaseRecord(data, getPrototypeCaseRecordByIdentifier(data, req.params.id)),
        }),
        case: getPrototypeCaseViewByIdentifier(req, data, req.params.id),
    });
});

app.post('/api/cases/:id/license-resolution', async (req, res) => {
    req.url = `/api/authority-prototype/cases/${req.params.id}/license-resolution`;
    app._router.handle(req, res);
});

const buildVenueCaptureRows = (req, data, venueId) => data.reports
    .filter((report) => report.venueId === venueId)
    .map((report) => {
        const submission = data.submissions.find((entry) => entry.id === report.submissionId) || null;
        const caseRecord = report.caseId ? data.caseLedger.find((entry) => entry.id === report.caseId) || null : null;
        const rawAsset = submission?.rawVideoAssetId ? data.assets.find((entry) => entry.id === submission.rawVideoAssetId) || null : null;
        return {
            capture_id: submission?.id || null,
            submission_reference: submission?.reference || null,
            report_id: report.id,
            report_reference: report.reference || null,
            case_id: caseRecord?.reference || caseRecord?.id || null,
            captured_at: report.createdAt || submission?.createdAt || null,
            status: report.analystStatus || report.status || 'unresolved',
            confirmed: ['confirmed', 'verified', 'actionable'].includes(String(report.analystStatus || '').toLowerCase()),
            song: report.title || submission?.songIdentity?.title || null,
            artist: report.artist || submission?.songIdentity?.artist || null,
            video_url: rawAsset ? buildAssetUrl(req, rawAsset) : null,
        };
    })
    .sort((left, right) => new Date(left.captured_at) - new Date(right.captured_at));

const buildRepeatCaptureSummary = (captures) => {
    const confirmed = captures.filter((capture) => capture.confirmed);
    const dated = confirmed.map((capture) => capture.captured_at).filter(Boolean).sort();
    return {
        confirmed_incident_count: confirmed.length,
        unresolved_capture_count: captures.length - confirmed.length,
        distinct_capture_dates: new Set(confirmed.map((capture) => String(capture.captured_at || '').slice(0, 10)).filter(Boolean)).size,
        distinct_detected_songs: new Set(confirmed.map((capture) => capture.song).filter(Boolean)).size,
        first_detected_at: dated[0] || null,
        latest_detected_at: dated[dated.length - 1] || null,
    };
};

app.get('/api/authority-prototype/venues/:venueId/captures', async (req, res) => {
    const data = await readPlatformData();
    const captures = buildVenueCaptureRows(req, data, req.params.venueId);
    res.json({ venue_id: req.params.venueId, captures });
});

app.get('/api/venues/:venueId/captures', async (req, res) => {
    const data = await readPlatformData();
    const captures = buildVenueCaptureRows(req, data, req.params.venueId);
    res.json({ venue_id: req.params.venueId, captures });
});

app.get('/api/authority-prototype/venues/:venueId/incident-timeline', async (req, res) => {
    const data = await readPlatformData();
    const captures = buildVenueCaptureRows(req, data, req.params.venueId);
    res.json({
        venue_id: req.params.venueId,
        timeline: captures.map((capture) => ({
            occurred_at: capture.captured_at,
            event_type: capture.confirmed ? 'CONFIRMED_CAPTURE' : 'UNRESOLVED_CAPTURE',
            capture,
        })),
    });
});

app.get('/api/venues/:venueId/incident-timeline', async (req, res) => {
    const data = await readPlatformData();
    const captures = buildVenueCaptureRows(req, data, req.params.venueId);
    res.json({
        venue_id: req.params.venueId,
        timeline: captures.map((capture) => ({
            occurred_at: capture.captured_at,
            event_type: capture.confirmed ? 'CONFIRMED_CAPTURE' : 'UNRESOLVED_CAPTURE',
            capture,
        })),
    });
});

app.get('/api/authority-prototype/venues/:venueId/repeat-capture-summary', async (req, res) => {
    const data = await readPlatformData();
    const captures = buildVenueCaptureRows(req, data, req.params.venueId);
    res.json({
        venue_id: req.params.venueId,
        ...buildRepeatCaptureSummary(captures),
    });
});

app.get('/api/venues/:venueId/repeat-capture-summary', async (req, res) => {
    const data = await readPlatformData();
    const captures = buildVenueCaptureRows(req, data, req.params.venueId);
    res.json({
        venue_id: req.params.venueId,
        ...buildRepeatCaptureSummary(captures),
    });
});

app.get('/api/authority-prototype/venue-resolution-queue', async (req, res) => {
    const data = await readPlatformData();
    const statusFilter = String(req.query.status || '').trim().toUpperCase();
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.page_size || req.query.pageSize || '25'), 10) || 25));
    const unresolved = data.caseLedger
        .map((caseRecord) => buildPrototypeCaseView(req, data, caseRecord))
        .filter(Boolean)
        .filter((caseView) => caseView.venueResolution?.venue_status !== 'RESOLVED')
        .filter((caseView) => !statusFilter || caseView.venueResolution?.resolution_status === statusFilter || caseView.venueResolution?.venue_status === statusFilter);
    const start = (page - 1) * pageSize;
    res.json({
        page,
        page_size: pageSize,
        total: unresolved.length,
        items: unresolved.slice(start, start + pageSize).map((caseView) => ({
            case_id: caseView.id,
            capture_id: caseView.venueAttribution?.capture_id || null,
            location: caseView.location,
            venueResolution: caseView.venueResolution,
            readiness_band: caseView.readiness_band,
            next_actions: caseView.next_actions,
        })),
    });
});

app.get('/api/venue-resolution-queue', async (req, res) => {
    const data = await readPlatformData();
    const statusFilter = String(req.query.status || '').trim().toUpperCase();
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.page_size || req.query.pageSize || '25'), 10) || 25));
    const unresolved = data.caseLedger
        .map((caseRecord) => buildPrototypeCaseView(req, data, caseRecord))
        .filter(Boolean)
        .filter((caseView) => caseView.venueResolution?.venue_status !== 'RESOLVED')
        .filter((caseView) => !statusFilter || caseView.venueResolution?.resolution_status === statusFilter || caseView.venueResolution?.venue_status === statusFilter);
    const start = (page - 1) * pageSize;
    res.json({
        page,
        page_size: pageSize,
        total: unresolved.length,
        items: unresolved.slice(start, start + pageSize),
    });
});

const mutateCaptureVenueResolution = async ({ req, action, handler }) => mutatePlatformData((draft) => {
    const captureId = req.params.captureId;
    const submission = draft.submissions.find((entry) => entry.id === captureId || entry.reference === captureId);
    if (!submission) throw new Error('Capture not found');
    const report = draft.reports.find((entry) => entry.submissionId === submission.id) || null;
    const caseRecord = report?.caseId ? draft.caseLedger.find((entry) => entry.id === report.caseId) || null : null;
    const primaryReport = caseRecord ? getPrimaryReportForCaseRecord(draft, caseRecord) : report;
    const actorId = String(req.body?.actorId || req.body?.actorRole || 'Admin').trim() || 'Admin';
    const previousValue = submission.venueResolution || null;
    const nextValue = handler({ draft, submission, report, caseRecord, actorId });
    submission.venueResolution = {
        ...(submission.venueResolution || {}),
        ...nextValue,
        updated_at: new Date().toISOString(),
        updated_by: actorId,
    };
    if (caseRecord && primaryReport) {
        appendEnforcementAuditEvent({
            caseRecord,
            primaryReport,
            eventType: 'Venue Resolution',
            actorId,
            previousValue,
            newValue: submission.venueResolution,
            source: action,
            notes: String(req.body?.notes || req.body?.note || action).trim(),
            captureId: submission.id,
        });
    }
    return submission.venueResolution;
});

app.post('/api/authority-prototype/captures/:captureId/venue-resolution/assign', async (req, res) => {
    const result = await mutateCaptureVenueResolution({
        req,
        action: 'venue-resolution-assign',
        handler: ({ actorId }) => ({
            resolution_status: 'ASSIGNED',
            assigned_to: req.body?.assignedTo || actorId,
            resolution_notes: req.body?.notes || null,
        }),
    }).catch((error) => ({ error }));
    if (result.error) return res.status(400).json({ error: result.error.message });
    res.json({ ok: true, venueResolution: result });
});

app.post('/api/captures/:captureId/venue-resolution/assign', async (req, res) => {
    req.url = `/api/authority-prototype/captures/${req.params.captureId}/venue-resolution/assign`;
    app._router.handle(req, res);
});

app.post('/api/authority-prototype/captures/:captureId/venue-resolution/confirm', async (req, res) => {
    const result = await mutateCaptureVenueResolution({
        req,
        action: 'venue-resolution-confirm',
        handler: ({ draft, submission, report }) => {
            const venueId = req.body?.venueId || req.body?.venue_id || null;
            const venue = draft.venues.find((entry) => entry.id === venueId || entry.placeProviderId === venueId) || null;
            if (!venue) throw new Error('Confirmed venue not found');
            submission.selectedVenue = {
                name: venue.name,
                address: venue.address,
                city: venue.city,
                latitude: venue.latitude,
                longitude: venue.longitude,
                placeProviderId: venue.placeProviderId,
                provider: venue.placeProvider,
            };
            submission.matchedVenue = venue.name;
            if (report) report.venueId = venue.id;
            return {
                venue_status: 'RESOLVED',
                resolution_status: 'RESOLVED',
                confirmed_venue_id: venue.id,
                resolution_notes: req.body?.notes || null,
            };
        },
    }).catch((error) => ({ error }));
    if (result.error) return res.status(400).json({ error: result.error.message });
    res.json({ ok: true, venueResolution: result });
});

app.post('/api/captures/:captureId/venue-resolution/confirm', async (req, res) => {
    req.url = `/api/authority-prototype/captures/${req.params.captureId}/venue-resolution/confirm`;
    app._router.handle(req, res);
});

app.post('/api/authority-prototype/captures/:captureId/venue-resolution/reject-candidate', async (req, res) => {
    const result = await mutateCaptureVenueResolution({
        req,
        action: 'venue-resolution-reject-candidate',
        handler: ({ submission }) => ({
            resolution_status: 'READY_FOR_REVIEW',
            rejected_candidates: [
                ...(submission.venueResolution?.rejected_candidates || []),
                {
                    venue_id: req.body?.venueId || req.body?.venue_id || null,
                    reason: req.body?.reason || req.body?.notes || null,
                    rejected_at: new Date().toISOString(),
                },
            ],
        }),
    }).catch((error) => ({ error }));
    if (result.error) return res.status(400).json({ error: result.error.message });
    res.json({ ok: true, venueResolution: result });
});

app.post('/api/captures/:captureId/venue-resolution/reject-candidate', async (req, res) => {
    req.url = `/api/authority-prototype/captures/${req.params.captureId}/venue-resolution/reject-candidate`;
    app._router.handle(req, res);
});

app.post('/api/authority-prototype/captures/:captureId/venue-resolution/field-note', async (req, res) => {
    const result = await mutateCaptureVenueResolution({
        req,
        action: 'venue-resolution-field-note',
        handler: ({ submission, actorId }) => ({
            resolution_status: req.body?.resolutionStatus || submission.venueResolution?.resolution_status || 'NEEDS_FIELD_FOLLOW_UP',
            field_notes: [
                ...(submission.venueResolution?.field_notes || []),
                {
                    actor_id: actorId,
                    occurred_at: new Date().toISOString(),
                    note: req.body?.note || req.body?.notes || '',
                },
            ],
        }),
    }).catch((error) => ({ error }));
    if (result.error) return res.status(400).json({ error: result.error.message });
    res.json({ ok: true, venueResolution: result });
});

app.post('/api/captures/:captureId/venue-resolution/field-note', async (req, res) => {
    req.url = `/api/authority-prototype/captures/${req.params.captureId}/venue-resolution/field-note`;
    app._router.handle(req, res);
});

app.post('/api/authority-prototype/cases/:id/stage', async (req, res) => {
    const nextStage = req.body?.stage;
    const actorRole = String(req.body?.actorRole || 'Admin').trim() || 'Admin';
    const details = String(req.body?.note || '').trim();

    if (!isPrototypeCaseStage(nextStage)) {
        return res.status(400).json({ error: 'Invalid prototype case stage' });
    }

    const result = await mutatePlatformData((data) => {
        const caseRecord = getPrototypeCaseRecordByIdentifier(data, req.params.id);
        const primaryReport = getPrimaryReportForCaseRecord(data, caseRecord);
        if (!caseRecord || !primaryReport) {
            throw new Error('Case not found');
        }

        const currentStage = derivePrototypeStageFromCase({ caseRecord, primaryReport });
        if (currentStage !== nextStage && !PROTOTYPE_STAGE_TRANSITIONS[currentStage]?.includes(nextStage)) {
            throw new Error(`Invalid stage transition: ${currentStage} -> ${nextStage}`);
        }

        if (!Array.isArray(caseRecord.authorityAuditTrail) || !caseRecord.authorityAuditTrail.length) {
            caseRecord.authorityAuditTrail = buildPrototypeDefaultAuditTrail({
                caseRecord,
                primaryReport,
                stage: currentStage,
            });
        }

        if (currentStage !== nextStage) {
            const now = new Date().toISOString();
            caseRecord.authorityStage = nextStage;
            caseRecord.authorityStageUpdatedAt = now;
            caseRecord.updatedAt = now;
            if (details) {
                caseRecord.authorityNotes = details;
            }
            caseRecord.authorityAuditTrail.push({
                id: crypto.randomUUID(),
                timestamp: now,
                action: 'Stage Updated',
                actor: actorRole,
                previousStage: currentStage,
                newStage: nextStage,
                details: details || 'No additional notes provided.',
            });
        }

        return caseRecord;
    }).catch((error) => ({ error }));

    if (result.error) {
        return res.status(400).json({ error: result.error.message });
    }

    const data = await readPlatformData();
    const updatedCase = getPrototypeCaseRecordByIdentifier(data, req.params.id);
    res.json({
        ok: true,
        case: buildPrototypeCaseView(req, data, updatedCase),
    });
});

app.post('/api/authority-prototype/cases/:id/audio-deconstruction', async (req, res) => {
    const actorRole = String(req.body?.actorRole || 'Admin').trim() || 'Admin';
    const data = await readPlatformData();
    const caseRecord = getPrototypeCaseRecordByIdentifier(data, req.params.id);
    const primaryReport = getPrimaryReportForCaseRecord(data, caseRecord);
    const submissionId = caseRecord?.primarySubmissionId || primaryReport?.submissionId || null;

    if (!caseRecord || !primaryReport || !submissionId) {
        return res.status(404).json({ error: 'Case submission could not be resolved' });
    }

    const result = await backfillSubmissionAudioDeconstruction(submissionId).catch((error) => ({
        ok: false,
        preservedExisting: false,
        audioDeconstruction: null,
        error: error.message,
    }));

    await mutatePlatformData((draft) => {
        const draftCaseRecord = getPrototypeCaseRecordByIdentifier(draft, req.params.id);
        const draftPrimaryReport = getPrimaryReportForCaseRecord(draft, draftCaseRecord);
        if (!draftCaseRecord || !draftPrimaryReport) {
            return;
        }

        const currentStage = derivePrototypeStageFromCase({ caseRecord: draftCaseRecord, primaryReport: draftPrimaryReport });
        if (!Array.isArray(draftCaseRecord.authorityAuditTrail) || !draftCaseRecord.authorityAuditTrail.length) {
            draftCaseRecord.authorityAuditTrail = buildPrototypeDefaultAuditTrail({
                caseRecord: draftCaseRecord,
                primaryReport: draftPrimaryReport,
                stage: currentStage,
            });
        }

        const timestamp = new Date().toISOString();
        draftCaseRecord.updatedAt = timestamp;
        draftCaseRecord.authorityAuditTrail.push({
            id: crypto.randomUUID(),
            timestamp,
            action: result.ok ? 'Audio Deconstruction Refreshed' : 'Audio Deconstruction Attempted',
            actor: actorRole,
            previousStage: currentStage,
            newStage: currentStage,
            details: result.ok
                ? (result.audioDeconstruction?.summary || 'Audio deconstruction was refreshed for this case.')
                : result.preservedExisting
                    ? `Demucs refresh failed, but the last completed forensic stems were preserved. ${result.error || ''}`.trim()
                    : (result.audioDeconstruction?.summary || result.error || 'Audio deconstruction could not be completed.'),
        });
    });

    const updatedData = await readPlatformData();
    const updatedCase = getPrototypeCaseRecordByIdentifier(updatedData, req.params.id);

    res.json({
        ok: Boolean(result.ok),
        preservedExisting: Boolean(result.preservedExisting),
        error: result.error || null,
        case: updatedCase ? buildPrototypeCaseView(req, updatedData, updatedCase) : null,
    });
});

app.post('/api/authority-prototype/cases/:id/re-evaluate', async (req, res) => {
    const actorRole = String(req.body?.actorRole || 'Admin').trim() || 'Admin';
    const data = await readPlatformData();
    const caseRecord = getPrototypeCaseRecordByIdentifier(data, req.params.id);
    const primaryReport = getPrimaryReportForCaseRecord(data, caseRecord);
    const submissionId = caseRecord?.primarySubmissionId || primaryReport?.submissionId || null;

    if (!caseRecord || !primaryReport || !submissionId) {
        return res.status(404).json({ error: 'Case submission could not be resolved' });
    }

    const submission = data.submissions.find((item) => item.id === submissionId);
    if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
    }
    if (submission.status === 'processing') {
        return res.status(400).json({ error: 'Submission is already processing' });
    }

    const repairedAsset = await ensureAssetRecord({
        assetId: submission.rawVideoAssetId,
        kind: 'raw-video',
        fileName: submission.fileName,
        mimeType: submission.uploadedMimeType || submission.mimeType,
        metadata: { submissionId },
    });
    if (!repairedAsset) {
        return res.status(400).json({ error: 'Submission has no recoverable raw video asset' });
    }

    await mutatePlatformData((draft) => {
        const draftCaseRecord = getPrototypeCaseRecordByIdentifier(draft, req.params.id);
        const draftPrimaryReport = getPrimaryReportForCaseRecord(draft, draftCaseRecord);
        const submissionRecord = draft.submissions.find((item) => item.id === submissionId);
        if (!draftCaseRecord || !draftPrimaryReport || !submissionRecord) {
            throw new Error('Case submission could not be resolved');
        }

        const currentStage = derivePrototypeStageFromCase({ caseRecord: draftCaseRecord, primaryReport: draftPrimaryReport });
        if (!Array.isArray(draftCaseRecord.authorityAuditTrail) || !draftCaseRecord.authorityAuditTrail.length) {
            draftCaseRecord.authorityAuditTrail = buildPrototypeDefaultAuditTrail({
                caseRecord: draftCaseRecord,
                primaryReport: draftPrimaryReport,
                stage: currentStage,
            });
        }

        const timestamp = new Date().toISOString();
        submissionRecord.status = 'processing';
        submissionRecord.processingError = null;
        submissionRecord.processingStartedAt = timestamp;
        submissionRecord.processingCompletedAt = null;
        draftCaseRecord.updatedAt = timestamp;
        draftCaseRecord.authorityAuditTrail.push({
            id: crypto.randomUUID(),
            timestamp,
            action: 'Package Re-evaluation Queued',
            actor: actorRole,
            previousStage: currentStage,
            newStage: currentStage,
            details: `Submission ${submission.reference || submission.id} was queued for a fresh evidence re-evaluation run.`,
        });
    });

    queueSubmissionProcessing(submissionId);

    const updatedData = await readPlatformData();
    const updatedCase = getPrototypeCaseRecordByIdentifier(updatedData, req.params.id);

    res.json({
        ok: true,
        submissionId,
        status: 'processing',
        case: updatedCase ? buildPrototypeCaseView(req, updatedData, updatedCase) : null,
    });
});

app.post('/api/admin/catalog/import', requireAuth, requirePlatformAdmin, upload.single('file'), async (req, res) => {
    try {
        const records = readCsvRecords(getImportPayload(req));
        const inserted = await mutatePlatformData((data) => {
            const created = records.map((record) => ({
                id: crypto.randomUUID(),
                orgId: data.orgs.find((org) => org.slug === record.org_slug)?.id || null,
                title: record.title,
                artist: record.artist,
                isrc: record.isrc || null,
                externalIds: record.external_ids ? [record.external_ids] : [],
                activeFrom: record.active_from || new Date().toISOString().slice(0, 10),
                activeTo: record.active_to || null,
                createdAt: new Date().toISOString()
            })).filter((record) => record.orgId && record.title && record.artist);
            data.catalogTracks.push(...created);
            return created.length;
        });

        res.json({ imported: inserted });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/admin/rights/import', requireAuth, requirePlatformAdmin, upload.single('file'), async (req, res) => {
    try {
        const records = readCsvRecords(getImportPayload(req));
        const updated = await mutatePlatformData((data) => {
            let count = 0;
            for (const record of records) {
                const org = data.orgs.find((item) => item.slug === record.slug);
                if (!org) {
                    continue;
                }
                org.type = record.type || org.type;
                org.name = record.name || org.name;
                org.portalSettings = {
                    ...org.portalSettings,
                    proCode: record.pro_code || org.portalSettings?.proCode || null
                };
                count += 1;
            }
            return count;
        });

        res.json({ imported: updated });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/admin/venue-coverage/import', requireAuth, requirePlatformAdmin, upload.single('file'), async (req, res) => {
    try {
        const records = readCsvRecords(getImportPayload(req));
        const imported = await mutatePlatformData((data) => {
            let count = 0;
            for (const record of records) {
                const org = data.orgs.find((item) => item.slug === record.org_slug);
                if (!org) {
                    continue;
                }

                let venue = data.venues.find((item) => item.placeProviderId === record.place_provider_id);
                if (!venue && record.venue_name) {
                    venue = {
                        id: crypto.randomUUID(),
                        placeProviderId: record.place_provider_id || null,
                        fallbackKey: record.venue_name ? stableHash(record.venue_name.toLowerCase()) : null,
                        name: record.venue_name,
                        address: record.address || '',
                        city: record.city || null,
                        latitude: record.latitude ? Number(record.latitude) : null,
                        longitude: record.longitude ? Number(record.longitude) : null,
                        createdAt: new Date().toISOString(),
                        lastSeenAt: new Date().toISOString()
                    };
                    data.venues.push(venue);
                }

                if (!venue) {
                    continue;
                }

                data.venueCoverage.push({
                    id: crypto.randomUUID(),
                    venueId: venue.id,
                    orgId: org.id,
                    coverageType: record.coverage_type || 'performance',
                    validFrom: record.valid_from || new Date().toISOString().slice(0, 10),
                    validTo: record.valid_to || null,
                    source: 'admin-import',
                    createdAt: new Date().toISOString()
                });
                count += 1;
            }
            return count;
        });

        res.json({ imported });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/admin/merchant-master/import', requireAuth, requirePlatformAdmin, upload.single('file'), async (req, res) => {
    try {
        const records = readCsvRecords(getImportPayload(req));
        const imported = await mutatePlatformData((data) => {
            let count = 0;
            for (const record of records) {
                const venue = findOrCreateVenueFromRecord(data, record);
                if (!venue) {
                    continue;
                }

                const existing = data.merchantMaster.find((merchant) => merchant.venueId === venue.id)
                    || (record.gstin ? data.merchantMaster.find((merchant) => merchant.gstin === record.gstin) : null);

                const next = existing || {
                    id: crypto.randomUUID(),
                    venueId: venue.id,
                    placeProviderId: venue.placeProviderId || null,
                    createdAt: new Date().toISOString()
                };

                next.venueId = venue.id;
                next.placeProviderId = record.place_provider_id || venue.placeProviderId || null;
                next.venueName = record.venue_name || venue.name;
                next.address = record.address || venue.address || '';
                next.city = record.city || venue.city || null;
                next.legalEntityName = record.legal_entity_name || next.legalEntityName || null;
                next.gstin = record.gstin || next.gstin || null;
                next.cityTier = record.city_tier || next.cityTier || getCityTier(next.city || '');
                next.venueType = record.venue_type || next.venueType || inferVenueType(next);
                next.hotelStarClass = record.hotel_star_class ? Number(record.hotel_star_class) : next.hotelStarClass || null;
                next.outletCount = record.outlet_count ? Number(record.outlet_count) : next.outletCount || 1;
                next.eventCapability = record.event_capability || next.eventCapability || 'standard';
                next.rightsLayersApplicable = record.rights_layers
                    ? record.rights_layers.split('|').map((value) => value.trim()).filter(Boolean)
                    : next.rightsLayersApplicable || ['label', 'collective'];
                next.updatedAt = new Date().toISOString();

                if (!existing) {
                    data.merchantMaster.push(next);
                }

                count += 1;
            }
            return count;
        });

        res.json({ imported });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/admin/license-status/import', requireAuth, requirePlatformAdmin, upload.single('file'), async (req, res) => {
    try {
        const records = readCsvRecords(getImportPayload(req));
        const imported = await mutatePlatformData((data) => {
            let count = 0;
            for (const record of records) {
                const org = data.orgs.find((item) => item.slug === record.org_slug);
                const venue = findOrCreateVenueFromRecord(data, record);
                if (!org || !venue) {
                    continue;
                }

                const existing = data.licenseStatus.find((entry) => (
                    entry.venueId === venue.id
                    && entry.orgId === org.id
                    && (record.rights_layer ? entry.rightsLayer === record.rights_layer : true)
                ));

                const next = existing || {
                    id: crypto.randomUUID(),
                    venueId: venue.id,
                    orgId: org.id,
                    createdAt: new Date().toISOString()
                };

                next.venueId = venue.id;
                next.orgId = org.id;
                next.rightsLayer = record.rights_layer || next.rightsLayer || org.type;
                next.status = record.status || next.status || 'unknown';
                next.evidenceSource = record.evidence_source || next.evidenceSource || 'admin-import';
                next.validFrom = record.valid_from || next.validFrom || null;
                next.validTo = record.valid_to || next.validTo || null;
                next.lastVerifiedAt = record.last_verified_at || new Date().toISOString();
                next.updatedAt = new Date().toISOString();

                if (!existing) {
                    data.licenseStatus.push(next);
                }

                count += 1;
            }
            return count;
        });

        res.json({ imported });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/admin/tariffs/import', requireAuth, requirePlatformAdmin, upload.single('file'), async (req, res) => {
    try {
        const records = readCsvRecords(getImportPayload(req));
        const imported = await mutatePlatformData((data) => {
            let count = 0;
            for (const record of records) {
                const org = record.org_slug ? data.orgs.find((item) => item.slug === record.org_slug) || null : null;
                const existing = data.tariffTable.find((entry) => (
                    entry.id === record.id
                    || (
                        entry.orgId === (org?.id || entry.orgId)
                        && entry.rightsLayer === (record.rights_layer || entry.rightsLayer)
                        && entry.venueType === (record.venue_type || entry.venueType)
                        && entry.cityTier === (record.city_tier || entry.cityTier)
                        && entry.basis === (record.basis || entry.basis)
                    )
                ));

                const next = existing || {
                    id: record.id || crypto.randomUUID(),
                    createdAt: new Date().toISOString()
                };

                next.orgId = org?.id || next.orgId || null;
                next.rightsLayer = record.rights_layer || next.rightsLayer || 'collective';
                next.venueType = record.venue_type || next.venueType || 'restaurant_bar_lounge';
                next.cityTier = record.city_tier || next.cityTier || 'tier_1';
                next.basis = record.basis || next.basis || 'annual';
                next.minimumFeeInr = record.minimum_fee_inr ? Number(record.minimum_fee_inr) : Number(next.minimumFeeInr || 0);
                next.sourceUrl = record.source_url || next.sourceUrl || null;
                next.effectiveFrom = record.effective_from || next.effectiveFrom || new Date().toISOString().slice(0, 10);
                next.effectiveTo = record.effective_to || next.effectiveTo || null;
                next.notes = record.notes || next.notes || '';

                if (!existing) {
                    data.tariffTable.push(next);
                }

                count += 1;
            }
            return count;
        });

        res.json({ imported });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/admin/abuse-queue', requireAuth, requirePlatformAdmin, async (req, res) => {
    const data = await readPlatformData();
    const abuseInstalls = data.anonymousInstalls
        .filter((install) => install.abuseScore >= 25)
        .sort((left, right) => right.abuseScore - left.abuseScore);
    const rejectedSubmissions = data.submissions.filter((submission) => submission.status === 'rejected_abuse');

    res.json({
        installs: abuseInstalls,
        rejectedSubmissions
    });
});

app.get('/api/admin/rewards/overview', requireAuth, requirePlatformAdmin, async (req, res) => {
    const data = await readPlatformData();
    res.json(buildRewardsOverview(data));
});

app.post('/api/admin/reports/:id/rescore', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
        const summary = await rescoreStoredEvidence({
            reportIdentifiers: [req.params.id],
            refreshVisualAnalysis: req.body?.refreshVisualAnalysis !== false,
            useGemini: req.body?.useGemini !== false,
        });

        res.json(summary);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/admin/health/dependencies:
 *   get:
 *     summary: Retrieve health dependencies
 *     description: Returns the status of required services like ACRCloud, Foursquare, Gemini, etc.
 *     tags:
 *       - Admin
 *     responses:
 *       200:
 *         description: OK
 */
app.get('/api/admin/health/dependencies', requireAuth, requirePlatformAdmin, async (req, res) => {
    res.json({
        ...(await buildHealthPayload()),
        demoAccounts: process.env.NODE_ENV === 'production' ? [] : await listDemoUsers()
    });
});

app.use(express.static(frontendDistDir, { index: false }));

app.get('*', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
    }

    if (req.path.startsWith('/api') || req.path.startsWith('/media') || req.path.startsWith('/python') || req.path === '/health') {
        next();
        return;
    }

    try {
        await fs.access(frontendIndexFile);
        res.sendFile(frontendIndexFile);
    } catch {
        next();
    }
});

const PORT = process.env.PORT || 3001;

if (isMainModule) {
    app.listen(PORT, () => {
        console.log(`🎵 Snitch API running on http://localhost:${PORT}`);
        console.log(`🔑 Using ACRCloud host: ${config.host}`);
        console.log(`🎚️  Allowed origin(s): ${allowedOrigins.join(', ')}`);
    });
}

export { app };
