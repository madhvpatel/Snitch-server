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
import Groq from 'groq-sdk';
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
    toOperationalSourceLabel,
    sourceClassSupportsVenuePlayback,
    isNonMusicSourceClass,
} from './sourceAnalysis.js';
import { normalizeDeclaredContext, reconcileContext } from './captureContext.js';
import { requestAudioDeconstructionReplicate } from './replicateDemucs.js';
import { decodeMonoWav, encodeMonoWav, selectPeakWindows, summarizePeakWindows } from './peakFrameAnalysis.js';
import { scoreBssidVenueMatch, scoreVenueCueMatch, normalizeBssid, canonicalVenueKey } from './venueFingerprints.js';
import { stageToLabel, labelToStage, makeCaseEvent, CASE_EVENT_TYPE, ACTOR_TYPE } from './schema.js';
import {
    mirrorMobileUser,
    mirrorDeviceInstall,
    upsertCaptureSession as prodUpsertCaptureSession,
    upsertVenue as prodUpsertVenue,
    insertSubmission as prodInsertSubmission,
    insertAsset as prodInsertAsset,
    insertReport as prodInsertReport,
    insertProcessingJob as prodInsertProcessingJob,
    updateProcessingJob as prodUpdateProcessingJob,
    updateReportFields as prodUpdateReportFields,
    updateSubmissionFields as prodUpdateSubmissionFields,
    findSubmission as prodFindSubmission,
    findCaptureSession as prodFindCaptureSession,
    findDeviceInstall as prodFindDeviceInstall,
    getSubmissionById as prodGetSubmissionById,
} from './productionStore.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDistDir = path.resolve(serverDir, '..', 'dist');
const frontendIndexFile = path.join(frontendDistDir, 'index.html');
const currentModuleFile = fileURLToPath(import.meta.url);

// Load environment variables explicitly from server/.env first, then root .env as fallback.
dotenv.config({ path: path.join(serverDir, '.env') });
dotenv.config({ path: path.join(serverDir, '..', '.env') });

const app = express();
app.set('trust proxy', true);
const upload = multer({ storage: multer.memoryStorage() });
const clientActivityLogDir = path.join(serverDir, 'logs');
const clientActivityLogFile = path.join(clientActivityLogDir, 'client-activity.log');
const clientActivityLoggingEnabled = String(process.env.CLIENT_ACTIVITY_LOGGING || 'true').toLowerCase() !== 'false';
const clientActivityConsoleEnabled = String(process.env.CLIENT_ACTIVITY_LOG_CONSOLE || 'true').toLowerCase() !== 'false';
const clientActivityLogStatic = String(process.env.CLIENT_ACTIVITY_LOG_STATIC || '').toLowerCase() === 'true';
const connectedClients = new Map();
const staticAssetPattern = /\.(?:avif|css|gif|ico|jpe?g|js|map|png|svg|ttf|webp|woff2?)$/i;

const trimLogValue = (value, maxLength = 180) => {
    if (value === undefined || value === null) {
        return null;
    }

    const text = String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
};

const sanitizeQueryForLog = (query = {}) => Object.fromEntries(
    Object.entries(query)
        .slice(0, 20)
        .map(([key, value]) => [
            key,
            trimLogValue(Array.isArray(value) ? value.join(',') : value, 160),
        ])
);

const getAuthSummary = (req) => {
    const authorization = req.get('authorization') || '';
    const [scheme] = authorization.split(/\s+/, 1);

    return {
        present: Boolean(authorization),
        scheme: scheme ? scheme.toLowerCase() : null,
    };
};

const getRouteFamily = (pathName) => {
    if (pathName.startsWith('/api/mobile')) return 'mobile_api';
    if (pathName.startsWith('/api/capture')) return 'legacy_capture_api';
    if (pathName.startsWith('/api/authority-prototype')) return 'authority_prototype_api';
    if (pathName.startsWith('/api/portal')) return 'portal_api';
    if (pathName.startsWith('/api/admin')) return 'admin_api';
    if (pathName.startsWith('/api/auth')) return 'auth_api';
    if (pathName.startsWith('/api-docs')) return 'docs';
    if (pathName.startsWith('/media')) return 'media';
    if (pathName.startsWith('/python')) return 'python_proxy';
    if (pathName.startsWith('/api')) return 'api';
    if (pathName === '/' || pathName === '/authority') return 'crm_frontend';
    return staticAssetPattern.test(pathName) ? 'static_asset' : 'frontend_route';
};

const classifyClientType = ({ pathName, routeFamily, origin, referer, userAgent }) => {
    const combined = `${origin || ''} ${referer || ''} ${userAgent || ''}`.toLowerCase();

    if (pathName.startsWith('/api/mobile') || pathName.startsWith('/api/capture')) {
        return 'snitching_app';
    }

    if (
        routeFamily.includes('portal')
        || routeFamily.includes('admin')
        || routeFamily.includes('authority')
        || routeFamily === 'auth_api'
        || routeFamily === 'crm_frontend'
        || combined.includes('/authority')
        || combined.includes('localhost:3000')
        || combined.includes('localhost:3001')
        || combined.includes('127.0.0.1:3000')
        || combined.includes('127.0.0.1:3001')
    ) {
        return 'crm';
    }

    if (combined.includes('expo') || combined.includes('reactnative') || combined.includes('android') || combined.includes('iphone')) {
        return 'snitching_app';
    }

    if (routeFamily === 'media') return 'media_consumer';
    if (routeFamily === 'docs') return 'api_docs';
    if (routeFamily === 'static_asset' || routeFamily === 'frontend_route') return 'browser_frontend';
    return 'unknown';
};

const getClientActivityKey = ({ ip, userAgent, origin, clientId }) => stableHash([
    ip || 'unknown-ip',
    userAgent || 'unknown-ua',
    origin || 'no-origin',
    clientId || 'no-client-id',
].join('|')).slice(0, 16);

const rememberClientActivity = (entry) => {
    const current = connectedClients.get(entry.clientKey) || {
        clientKey: entry.clientKey,
        firstSeenAt: entry.timestamp,
        lastSeenAt: entry.timestamp,
        requestCount: 0,
        routes: {},
        recentRequests: [],
    };

    current.lastSeenAt = entry.timestamp;
    current.requestCount += 1;
    current.clientType = entry.clientType;
    current.routeFamily = entry.routeFamily;
    current.ip = entry.ip;
    current.origin = entry.origin;
    current.referer = entry.referer;
    current.userAgent = entry.userAgent;
    current.lastMethod = entry.method;
    current.lastPath = entry.path;
    current.lastStatus = entry.statusCode;
    current.lastDurationMs = entry.durationMs;
    current.portalUser = entry.portalUser;
    current.mobileUser = entry.mobileUser;
    current.routes[entry.routeFamily] = (current.routes[entry.routeFamily] || 0) + 1;
    current.recentRequests.unshift({
        timestamp: entry.timestamp,
        method: entry.method,
        path: entry.path,
        statusCode: entry.statusCode,
        durationMs: entry.durationMs,
    });
    current.recentRequests = current.recentRequests.slice(0, 25);

    connectedClients.set(entry.clientKey, current);
    return current.requestCount === 1;
};

const writeClientActivityLog = (entry) => {
    if (!clientActivityLoggingEnabled) {
        return;
    }

    const line = `${JSON.stringify(entry)}\n`;
    try {
        fsSync.mkdirSync(clientActivityLogDir, { recursive: true });
    } catch (error) {
        console.warn('client_activity_log_dir_error', error.message);
    }

    fs.appendFile(clientActivityLogFile, line).catch((error) => {
        console.warn('client_activity_log_write_error', error.message);
    });

    if (clientActivityConsoleEnabled) {
        console.log('client_activity', JSON.stringify({
            requestId: entry.requestId,
            clientKey: entry.clientKey,
            clientType: entry.clientType,
            routeFamily: entry.routeFamily,
            method: entry.method,
            path: entry.path,
            statusCode: entry.statusCode,
            durationMs: entry.durationMs,
            ip: entry.ip,
            origin: entry.origin,
            newClient: entry.newClient,
        }));
    }
};

const clientActivityLogger = (req, res, next) => {
    const startMs = Date.now();
    const pathName = req.path || '/';
    const routeFamily = getRouteFamily(pathName);

    if (!clientActivityLogStatic && routeFamily === 'static_asset') {
        next();
        return;
    }

    const origin = trimLogValue(req.get('origin'));
    const referer = trimLogValue(req.get('referer'));
    const userAgent = trimLogValue(req.get('user-agent'), 260);
    const ip = trimLogValue(req.ip || req.socket?.remoteAddress || null);
    const clientId = trimLogValue(req.get('x-snitch-client-id') || req.get('x-client-id') || req.get('x-device-id'));
    const clientType = classifyClientType({ pathName, routeFamily, origin, referer, userAgent });
    const clientKey = getClientActivityKey({ ip, userAgent, origin, clientId });
    const requestId = req.get('x-request-id') || crypto.randomUUID();

    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
        const durationMs = Date.now() - startMs;
        const entry = {
            event: 'request_finished',
            timestamp: new Date().toISOString(),
            requestId,
            clientKey,
            clientType,
            routeFamily,
            method: req.method,
            path: pathName,
            originalUrl: trimLogValue(req.originalUrl, 500),
            query: sanitizeQueryForLog(req.query),
            statusCode: res.statusCode,
            durationMs,
            responseBytes: Number(res.getHeader('content-length') || 0) || null,
            ip,
            forwardedFor: trimLogValue(req.get('x-forwarded-for'), 260),
            host: trimLogValue(req.get('host')),
            origin,
            referer,
            userAgent,
            accept: trimLogValue(req.get('accept'), 260),
            contentType: trimLogValue(req.get('content-type')),
            contentLength: Number(req.get('content-length') || 0) || null,
            auth: getAuthSummary(req),
            portalUser: req.portalUser ? {
                id: req.portalUser.id,
                email: req.portalUser.email,
                role: req.portalUser.role,
                isPlatformAdmin: Boolean(req.portalUser.isPlatformAdmin),
            } : null,
            mobileUser: req.mobileUser ? {
                id: req.mobileUser.id,
                email: req.mobileUser.email,
                trustTier: req.mobileUser.trustTier,
            } : null,
        };

        entry.newClient = rememberClientActivity(entry);
        writeClientActivityLog(entry);
    });

    next();
};

app.use(clientActivityLogger);
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
    groq_key: process.env.GROQ_API_KEY,
    google_places_key: process.env.GOOGLE_PLACES_API_KEY
};
const GROQ_MODEL = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
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
const AI_TIMEOUT_MS = 20000;

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
- Audio source classifier: ${sourceAnalysis?.operationalLabel || toOperationalSourceLabel(sourceAnalysis?.sourceClass)} (${sourceAnalysis?.confidence != null ? `${Math.round(Number(sourceAnalysis.confidence) * 100)}% confidence` : 'n/a'})

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

const buildApplicationAssessmentPrompt = (context) => `
You are an evidence triage assistant for venue music enforcement.

You are not making a legal conclusion. Your job is to classify likely edge cases conservatively using the existing signals already captured.

Important rules:
- Song identification alone is not proof of venue attribution.
- Wi-Fi/Bluetooth context is corroborating only, never primary proof.
- If the evidence looks like a phone, laptop, TV, livestream, or small-speaker replay, raise replay/private-space risk.
- If the capture appears near a venue but not clearly inside it, prefer "venue_perimeter" or "adjacent_bleed" over "inside_venue".
- If the property may be correct but the exact outlet is unclear, prefer "outlet_ambiguity".
- Recommend "attack_now" only when venue attribution is strong and the major edge-case risks stay low.
- Do not classify a cafe/restaurant/coffeeshop as "private_home" just because an AC unit, laptop, art, tables, or chairs are visible.
- When strong venue identity cues and aligned geo are present, a laptop by itself should not drive replay risk.
- Small mounted cafe speakers are valid venue playback cues when visible.

Allowed locationContext values:
- inside_venue
- venue_perimeter
- adjacent_bleed
- private_home
- private_hotel_room
- vehicle
- screen_replay
- outlet_ambiguity
- inconclusive

Allowed recommendedDisposition values:
- attack_now
- build_corroboration
- manual_review
- do_not_pursue

Known context JSON:
${JSON.stringify(context, null, 2)}

Return strict JSON only:
{
  "locationContext": "inside_venue",
  "confidence": 0.0,
  "venueAttributionRisk": 0.0,
  "privateSpaceRisk": 0.0,
  "replayRisk": 0.0,
  "outletAmbiguityRisk": 0.0,
  "farmingRisk": 0.0,
  "attackReadiness": 0.0,
  "recommendedDisposition": "manual_review",
  "reasons": ["..."],
  "evidenceGaps": ["..."],
  "edgeCaseTags": ["..."]
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
        groq: {
            required: false,
            configured: Boolean(config.groq_key)
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

const toRadians = (value) => (Number(value) * Math.PI) / 180;

// Analyses a GPS track array produced during recording.
// Returns mobility signals the application assessment uses to detect farming/fraud.
const analyzeGpsTrack = (track) => {
    if (!Array.isArray(track) || track.length < 2) {
        return null;
    }

    const points = track
        .map((p) => ({
            lat: Number(p?.lat),
            lon: Number(p?.lon),
            accuracy: Number(p?.accuracy ?? 9999),
            capturedAt: p?.capturedAt || null,
        }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

    if (points.length < 2) {
        return null;
    }

    // Total path distance (sum of consecutive segment lengths).
    let totalPathMeters = 0;
    for (let i = 1; i < points.length; i += 1) {
        const d = haversineDistanceMeters(points[i - 1], points[i]);
        if (Number.isFinite(d)) {
            totalPathMeters += d;
        }
    }

    // Max deviation from the starting anchor point.
    const anchor = points[0];
    let maxDeviationMeters = 0;
    for (const p of points) {
        const d = haversineDistanceMeters(anchor, p);
        if (Number.isFinite(d) && d > maxDeviationMeters) {
            maxDeviationMeters = d;
        }
    }

    // Average GPS accuracy across the track.
    const avgAccuracy = points.reduce((sum, p) => sum + p.accuracy, 0) / points.length;

    // Velocity estimate using total duration.
    let velocityMps = null;
    const first = points[0].capturedAt ? new Date(points[0].capturedAt).getTime() : null;
    const last = points[points.length - 1].capturedAt ? new Date(points[points.length - 1].capturedAt).getTime() : null;
    const durationMs = first && last ? last - first : null;
    if (durationMs > 0) {
        velocityMps = totalPathMeters / (durationMs / 1000);
    }

    // Category: stationary (<2 m/s), walking (2-6 m/s), vehicle (>6 m/s).
    let velocityCategory = 'unknown';
    if (velocityMps !== null) {
        if (velocityMps < 2) {
            velocityCategory = 'stationary';
        } else if (velocityMps < 6) {
            velocityCategory = 'walking';
        } else {
            velocityCategory = 'vehicle';
        }
    }

    // Stationary: total path < 25 m and max deviation < 20 m (accounting for GPS drift).
    const avgAcc = Number.isFinite(avgAccuracy) ? avgAccuracy : 35;
    const driftBudget = Math.max(20, avgAcc * 0.8);
    const isStationary = totalPathMeters < Math.max(25, driftBudget) && maxDeviationMeters < driftBudget;

    return {
        pointCount: points.length,
        totalPathMeters: Math.round(totalPathMeters),
        maxDeviationMeters: Math.round(maxDeviationMeters),
        avgAccuracyMeters: Math.round(avgAccuracy),
        velocityMps: velocityMps !== null ? Number(velocityMps.toFixed(2)) : null,
        velocityCategory,
        isStationary,
    };
};

const haversineDistanceMeters = (origin, target) => {
    if (!origin || !target) {
        return null;
    }

    const lat1 = Number(origin.lat);
    const lon1 = Number(origin.lon);
    const lat2 = Number(target.lat);
    const lon2 = Number(target.lon);

    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) {
        return null;
    }

    const earthRadiusMeters = 6371000;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return Math.round(earthRadiusMeters * c);
};

const averageFiniteNumbers = (values = []) => {
    const numeric = values.map((value) => Number(value)).filter(Number.isFinite);
    if (!numeric.length) {
        return null;
    }

    return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
};

const namesLikelyMatch = (left, right) => {
    const normalize = (value) => cleanString(value).replace(/[^a-z0-9]+/g, ' ').trim();
    const a = normalize(left);
    const b = normalize(right);

    if (!a || !b) {
        return false;
    }

    return a === b || a.includes(b) || b.includes(a);
};

const scoreZeroToOne = (value, fallback = 0) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }

    return Math.max(0, Math.min(1, numeric));
};

const buildGeoBucket = ({ distanceMeters, accuracyMeters }) => {
    if (!Number.isFinite(distanceMeters)) {
        return 'unknown';
    }

    const accuracy = Number.isFinite(accuracyMeters) ? accuracyMeters : 35;
    if (distanceMeters <= Math.max(35, accuracy * 1.2)) {
        return 'inside';
    }
    if (distanceMeters <= Math.max(90, accuracy * 2.2)) {
        return 'perimeter';
    }
    return 'outside';
};

const toLatLonPoint = (value) => {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const lat = Number(value.lat ?? value.latitude);
    const lon = Number(value.lon ?? value.longitude);
    if (![lat, lon].every(Number.isFinite)) {
        return null;
    }

    return { lat, lon };
};

const summarizeVenueDistances = ({ startPoint, endPoint, venuePoint }) => {
    const startDistanceMeters = haversineDistanceMeters(startPoint, venuePoint);
    const endDistanceMeters = haversineDistanceMeters(endPoint, venuePoint);
    const distanceValues = [startDistanceMeters, endDistanceMeters].filter(Number.isFinite);

    return {
        startDistanceMeters,
        endDistanceMeters,
        minDistanceMeters: distanceValues.length ? Math.min(...distanceValues) : null,
        maxDistanceMeters: distanceValues.length ? Math.max(...distanceValues) : null,
        avgDistanceMeters: distanceValues.length
            ? Math.round(distanceValues.reduce((sum, value) => sum + value, 0) / distanceValues.length)
            : null,
    };
};

const buildLocationDelta = ({ submission, venue }) => {
    const startPoint = toLatLonPoint(submission?.geolocationStart);
    const endPoint = toLatLonPoint(submission?.geolocationEnd);
    const selectedVenuePoint = toLatLonPoint(submission?.selectedVenue);
    const matchedVenuePoint = toLatLonPoint(venue);
    const selectedVenue = summarizeVenueDistances({ startPoint, endPoint, venuePoint: selectedVenuePoint });
    const matchedVenue = summarizeVenueDistances({ startPoint, endPoint, venuePoint: matchedVenuePoint });
    const averageAccuracyMeters = averageFiniteNumbers([submission?.geolocationStart?.accuracy, submission?.geolocationEnd?.accuracy]);
    const primaryVenueSource = matchedVenue.minDistanceMeters != null
        ? 'matched_venue'
        : selectedVenue.minDistanceMeters != null
            ? 'selected_venue'
            : 'none';
    const primaryDistanceMeters = primaryVenueSource === 'matched_venue'
        ? matchedVenue.minDistanceMeters
        : primaryVenueSource === 'selected_venue'
            ? selectedVenue.minDistanceMeters
            : null;
    const accuracyEnvelopeMeters = Number.isFinite(averageAccuracyMeters)
        ? Math.max(25, Math.round(averageAccuracyMeters * 1.25))
        : null;

    return {
        selectedVenueDistanceStartMeters: selectedVenue.startDistanceMeters,
        selectedVenueDistanceEndMeters: selectedVenue.endDistanceMeters,
        matchedVenueDistanceStartMeters: matchedVenue.startDistanceMeters,
        matchedVenueDistanceEndMeters: matchedVenue.endDistanceMeters,
        minVenueDistanceMeters: primaryDistanceMeters,
        maxVenueDistanceMeters: primaryVenueSource === 'matched_venue'
            ? matchedVenue.maxDistanceMeters
            : primaryVenueSource === 'selected_venue'
                ? selectedVenue.maxDistanceMeters
                : null,
        avgVenueDistanceMeters: primaryVenueSource === 'matched_venue'
            ? matchedVenue.avgDistanceMeters
            : primaryVenueSource === 'selected_venue'
                ? selectedVenue.avgDistanceMeters
                : null,
        capturePathDeltaMeters: haversineDistanceMeters(startPoint, endPoint),
        venueAnchorDeltaMeters: haversineDistanceMeters(selectedVenuePoint, matchedVenuePoint),
        accuracyStartMeters: Number.isFinite(Number(submission?.geolocationStart?.accuracy))
            ? Number(submission.geolocationStart.accuracy)
            : null,
        accuracyEndMeters: Number.isFinite(Number(submission?.geolocationEnd?.accuracy))
            ? Number(submission.geolocationEnd.accuracy)
            : null,
        averageAccuracyMeters,
        accuracyEnvelopeMeters,
        withinAccuracyEnvelope: Number.isFinite(primaryDistanceMeters) && Number.isFinite(accuracyEnvelopeMeters)
            ? primaryDistanceMeters <= accuracyEnvelopeMeters
            : null,
        geoBucket: buildGeoBucket({
            distanceMeters: primaryDistanceMeters,
            accuracyMeters: averageAccuracyMeters,
        }),
        selectedMatchedAligned: namesLikelyMatch(submission?.selectedVenue?.name, venue?.name || submission?.matchedVenue || null),
        primaryVenueSource,
    };
};

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

    if ((needsLabel || needsPRO) && config.groq_key) {
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
        const groq = new Groq({ apiKey: config.groq_key });
        const prompt = `Identified Song: "${title}" by "${artist}".
I need the record label and the primary performing rights organization for this song.

Return STRICT JSON only (no markdown, no explanation):
{"label": "Record label or null", "rights_org": "PRO acronym like ASCAP, BMI, SESAC, GMR, PRS, or GEMA, or null"}`;

        const completion = await withTimeout(
            groq.chat.completions.create({
                model: GROQ_MODEL,
                messages: [{ role: 'user', content: prompt }],
            }),
            AI_TIMEOUT_MS,
            'metadata enrichment',
        );
        const text = completion.choices[0].message.content.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(text);
        return {
            label: parsed.label || null,
            rights_org: normalizeRightsOrg(parsed.rights_org),
        };
    } catch (error) {
        console.error('AI metadata enrichment error:', error);
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

// Build an OpenAI-compatible content array for Groq from a list of parts.
// Each part is either { text } or { inlineData: { data, mimeType } }.
// Audio inlineData is skipped — Groq vision models don't support inline audio.
const buildGroqContent = (parts) => {
    const content = [];
    for (const part of parts) {
        if (part.text !== undefined) {
            content.push({ type: 'text', text: part.text });
        } else if (part.inlineData) {
            const { mimeType, data } = part.inlineData;
            if (mimeType.startsWith('image/')) {
                content.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } });
            }
            // audio inlineData intentionally dropped — not supported
        }
    }
    return content;
};

// jsonMode: true forces Groq to return a valid JSON object (no markdown/prose).
// Use for all calls where we parseModelJson the result.
const generateAIText = async ({ parts, label, jsonMode = false }) => {
    const groq = new Groq({ apiKey: config.groq_key });
    const content = buildGroqContent(parts);
    const createParams = {
        model: GROQ_MODEL,
        messages: [
            ...(jsonMode ? [{ role: 'system', content: 'You are a JSON-only response assistant. Return only a valid JSON object. No markdown, no explanation, no text outside the JSON.' }] : []),
            { role: 'user', content },
        ],
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
    const completion = await withTimeout(
        groq.chat.completions.create(createParams),
        AI_TIMEOUT_MS,
        label,
    );
    return completion.choices[0].message.content.trim();
};

async function generateForensicReport({ frameDataUrl, mode, peakTime }) {
    const prompt = buildForensicPrompt({ mode, peakTime, hasFrame: Boolean(frameDataUrl) });
    const parts = [];
    const inlineFrame = parseInlineDataUrl(frameDataUrl);
    if (inlineFrame) {
        parts.push({ inlineData: { data: inlineFrame.data, mimeType: inlineFrame.mimeType } });
    }
    parts.push({ text: prompt });
    return generateAIText({ parts, label: 'forensic report generation' });
}

async function generateVisualEvidenceAssessment({ frames = [], peakWindows = [], song, venue, sourceAnalysis }) {
    if (!frames.length) {
        return null;
    }

    const prompt = buildVisualAnalysisPrompt({ peakWindows, song, venue, sourceAnalysis });
    const parts = [];
    frames.forEach((frame, index) => {
        parts.push({ text: `Frame ${index + 1} was captured at ${frame.timestampSeconds.toFixed(2)} seconds.` });
        parts.push({ inlineData: { data: frame.buffer.toString('base64'), mimeType: frame.mimeType || 'image/jpeg' } });
    });
    parts.push({ text: prompt });

    const text = await generateAIText({ parts, label: 'visual evidence assessment', jsonMode: true });
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
    // DEMUCS_BACKEND=replicate routes stem separation to Replicate-hosted Demucs
    // (no local Python service needed). Default is the self-hosted backend, which
    // can also be pointed at a tunnel to a local box via PYTHON_AI_BASE_URL.
    if ((process.env.DEMUCS_BACKEND || 'local').toLowerCase() === 'replicate') {
        return requestAudioDeconstructionReplicate({ audioBuffer, fileName, mimeType });
    }

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
        if (!config.groq_key) {
            return res.status(503).json({ error: 'AI API key is not configured on the server' });
        }

        const audioFile = req.files?.audio?.[0];
        if (!audioFile) {
            return res.status(400).json({ error: 'No audio snippet provided' });
        }

        const report = await generateForensicReport({
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

// Canonical payload the SnitchV1 mobile client signs at finalize. Every value is
// a string (or null) so client and server canonicalize byte-for-byte identically
// without float→string ambiguity. sessionNonce is server-issued per session and
// binds the signature to this capture session (replay protection). Key set MUST
// match the client's `signed` object in upload-progress.tsx.
const buildMobileSignedFinalizePayload = (payload) => ({
    installId: payload.installId ?? null,
    deviceKeyId: payload.deviceKeyId ?? null,
    sessionId: payload.sessionId ?? null,
    sessionNonce: payload.sessionNonce ?? null,
    mediaSha256: payload.mediaSha256 ?? null,
    localStartTime: payload.localStartTime ?? null,
    localEndTime: payload.localEndTime ?? null,
    durationSeconds: payload.durationSeconds ?? null,
    startLat: payload.startLat ?? null,
    startLng: payload.startLng ?? null,
    endLat: payload.endLat ?? null,
    endLng: payload.endLng ?? null,
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

const sanitizeVisualAnalysis = (analysis, peakWindows = []) => {
    if (!analysis || typeof analysis !== 'object') {
        return null;
    }

    const frameObservationByTimestamp = new Map(
        Array.isArray(analysis.frameObservations)
            ? analysis.frameObservations
                .filter((entry) => entry && typeof entry === 'object')
                .map((entry) => [Number(entry.timestampSeconds), String(entry.observation || '').trim()])
                .filter(([, observation]) => observation)
            : []
    );

    const playbackContext = [
        'likely_installed_pa',
        'likely_small_portable_speaker',
        'likely_personal_device',
        'inconclusive'
    ].includes(analysis.playbackContext)
        ? analysis.playbackContext
        : 'inconclusive';

    return {
        playbackContext,
        confidence: Math.max(0, Math.min(1, Number(analysis.confidence || 0))),
        summary: String(analysis.summary || '').trim() || 'Visual evidence analysis was inconclusive.',
        visibleEquipment: Array.isArray(analysis.visibleEquipment)
            ? analysis.visibleEquipment.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 8)
            : [],
        venueIdentitySignals: Array.isArray(analysis.venueIdentitySignals)
            ? analysis.venueIdentitySignals.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 8)
            : [],
        obstructionFlags: Array.isArray(analysis.obstructionFlags)
            ? analysis.obstructionFlags.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 8)
            : [],
        frameObservations: peakWindows.map((window) => ({
            timestampSeconds: window.timestampSeconds,
            observation: frameObservationByTimestamp.get(window.timestampSeconds) || null
        })).filter((entry) => entry.observation),
        modelVersion: 'visual-v1',
    };
};

const buildFallbackVisualAnalysis = ({ peakWindows = [], sourceAnalysis, frames }) => ({
    playbackContext: 'inconclusive',
    confidence: 0.3,
    summary: frames.length
        ? 'Peak-aligned frames were extracted, but visual AI analysis was unavailable. Review the saved frames alongside the audio/source signals.'
        : 'Visual AI analysis was unavailable and no peak-aligned frames were extracted.',
    visibleEquipment: [],
    venueIdentitySignals: [],
    obstructionFlags: [],
    frameObservations: peakWindows.map((window) => ({
        timestampSeconds: window.timestampSeconds,
        observation: sourceAnalysis?.sourceClass
            ? `Frame captured at a higher-energy window while audio source scoring remained ${sourceAnalysis.operationalLabel || toOperationalSourceLabel(sourceAnalysis.sourceClass)}.`
            : 'Frame captured at a higher-energy window for manual review.'
    })),
    modelVersion: 'visual-v1-fallback',
});

const looksLikeDegenerateVisualRefresh = (visualAnalysis) => {
    if (!visualAnalysis) {
        return true;
    }

    const summary = cleanString(visualAnalysis.summary || '');
    return !visualAnalysis.visibleEquipment?.length
        && !visualAnalysis.venueIdentitySignals?.length
        && (!summary || summary.includes('no still frames were provided') || summary.includes('visual analysis cannot be performed'));
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

// Core evidence pipeline shared by both legacy and v2 processing paths.
// Accepts a resolved rawAssetPath + metadata; returns all computed signals.
// Caller is responsible for: hash verification, venue resolution, and final writes.
const runEvidencePipeline = async ({
    rawAssetPath,
    reference,
    submissionId,
    data,
    durationSeconds,
    measuredStartOffsetMs,
    measuredEndOffsetMs,
    sourceClassifierMode,
    bestSongIdentity: initialBestSongIdentity,
    venue,
}) => {
    const audioBuffer = await extractAudioFromFile(rawAssetPath);
    let analysisAudioBuffer = audioBuffer;
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
        const isolationPasses = buildIsolationPasses({ audioBuffer, reference });
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
                        reference,
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
                reference,
                deconstructionResult,
            });

            if (deconstructionResult.preferredStem && deconstructionResult.stems[deconstructionResult.preferredStem]) {
                analysisStem = deconstructionResult.preferredStem;
                analysisAudioBuffer = deconstructionResult.stems[analysisStem].buffer;
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
        sourceAnalysis = analyzeAudioSource(audioBuffer, { mode: sourceClassifierMode || DEFAULT_SOURCE_CLASSIFIER_MODE });
    } catch (error) {
        console.warn('Audio source analysis failed:', error.message);
    }

    const extractedFrames = await extractPeakFramesFromVideo(rawAssetPath, peakWindows);
    const representativeFrameDataUrl = extractedFrames[0]
        ? bufferToDataUrl(extractedFrames[0].buffer, extractedFrames[0].mimeType)
        : null;

    const audioAsset = await saveAsset({
        buffer: audioBuffer,
        fileName: `${reference}.wav`,
        mimeType: 'audio/wav',
        kind: 'derived-audio',
        metadata: { submissionId },
    });

    const frameAssets = await Promise.all(extractedFrames.map((frame) => saveAsset({
        buffer: frame.buffer,
        fileName: `${reference}-peak-${frame.rank}.jpg`,
        mimeType: frame.mimeType,
        kind: 'video-frame',
        metadata: {
            submissionId,
            timestampSeconds: frame.timestampSeconds,
            peakRank: frame.rank,
            relativeIntensity: frame.relativeIntensity,
        },
    })));

    let songIdentity = { ok: false };
    let songIdentityCandidates = allFingerprintCandidates;
    let songIdentityAttempts = allFingerprintAttempts;
    let bestSongIdentityRecord = initialBestSongIdentity || null;
    let chosenFingerprintRun = currentFingerprintRun;

    if (config.host && config.access_key && config.access_secret) {
        if (!chosenFingerprintRun) {
            const rawFallbackRun = await evaluateFingerprintRun({
                audioBuffer,
                reference,
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
                    reference,
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
                }),
            );
        }

        if (!songIdentity.ok && bestSongIdentityRecord?.song?.title) {
            songIdentity = { ok: true, data: bestSongIdentityRecord.song };
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

    const submissionForFallback = { durationSeconds, measuredStartOffsetMs, measuredEndOffsetMs };
    const forensicSummary = config.groq_key
        ? await generateForensicReport({
            mode: 'summary',
            peakTime: peakWindows[0]?.timestampSeconds ?? durationSeconds / 2,
            frameDataUrl: representativeFrameDataUrl,
        }).catch(() => buildFallbackForensicSummary(song, submissionForFallback))
        : buildFallbackForensicSummary(song, submissionForFallback);

    const visualAnalysis = config.groq_key
        ? await generateVisualEvidenceAssessment({
            frames: extractedFrames,
            peakWindows,
            song,
            venue,
            sourceAnalysis,
        }).catch(() => buildFallbackVisualAnalysis({ peakWindows, sourceAnalysis, frames: extractedFrames }))
        : buildFallbackVisualAnalysis({ peakWindows, sourceAnalysis, frames: extractedFrames });

    return {
        song,
        audioBuffer,
        audioDeconstruction,
        audioAsset,
        frameAssets,
        extractedFrames,
        representativeFrameDataUrl,
        sourceAnalysis,
        peakWindows,
        forensicSummary,
        visualAnalysis,
        bestSongIdentityRecord,
        songIdentityAttempts,
    };
};

// ─── Phase 1: Quick ID (runs at submit, light) ───
// A SINGLE ACRCloud pass on the raw extracted audio — just enough to show the
// snitcher the track + who owns it. No Demucs, source/visual/application
// analysis, or reconciliation (that is Phase 2, deferred). Sets the submission
// to 'identified' (song found) or 'needs_advanced' (the quick pass couldn't
// decode it — advanced techniques required later).
const quickIdentifySubmission = async (submissionId) => {
    if (processingSubmissions.has(submissionId)) {
        return;
    }
    processingSubmissions.add(submissionId);

    let jobId = null;
    try {
        await mutatePlatformData((draft) => {
            const sub = prodFindSubmission(draft, submissionId);
            if (sub) {
                sub.status = 'identifying';
                sub.updated_at = new Date().toISOString();
            }
            const job = prodInsertProcessingJob(draft, {
                submission_id: submissionId,
                job_type: 'quick_id',
                provider: 'acrcloud',
                status: 'running',
                started_at: new Date().toISOString(),
            });
            jobId = job.id;
        });

        const data = await readPlatformData();
        const submission = prodFindSubmission(data, submissionId);
        if (!submission) {
            throw new Error('V2 submission not found');
        }
        const rawAssetRow = data.production?.assets?.find((a) => a.id === submission.raw_video_asset_id) || null;
        if (!rawAssetRow?.object_key) {
            throw new Error('Raw video asset missing from production store');
        }
        const rawAssetPath = path.join(MEDIA_DIR, rawAssetRow.object_key);

        // Hash integrity check (cheap, keep it on the fast path).
        if (submission.media_sha256) {
            const rawFileBuffer = await fs.readFile(rawAssetPath);
            const computedHash = crypto.createHash('sha256').update(rawFileBuffer).digest('hex');
            if (computedHash !== submission.media_sha256) {
                await mutatePlatformData((draft) => {
                    prodUpdateSubmissionFields(draft, submissionId, { status: 'failed', integrity_flag: 'hash_mismatch' });
                    if (jobId) prodUpdateProcessingJob(draft, jobId, { status: 'failed', error_message: 'hash_mismatch', finished_at: new Date().toISOString() });
                });
                throw new Error('Media integrity check failed: hash mismatch');
            }
        }

        // Extract audio in-memory and run ONE ACRCloud pass on the raw audio.
        const audioBuffer = await extractAudioFromFile(rawAssetPath);
        const acrConfigured = Boolean(config.host && config.access_key && config.access_secret);
        const songResult = acrConfigured
            ? await resolveSongIdentity(audioBuffer, { filename: `${submission.reference}.wav`, contentType: 'audio/wav' })
                .catch((err) => ({ ok: false, error: err.message }))
            : { ok: false, error: 'ACRCloud not configured' };
        const song = songResult.ok ? songResult.data : null;

        await mutatePlatformData((draft) => {
            const reportCreatedAt = new Date().toISOString();
            const reportRow = prodInsertReport(draft, {
                reference: createReference('REP'),
                submission_id: submissionId,
                processing_stage: 'quick_id',
                matched_track_confidence: Number(song?.matchScore ?? 0),
                title: song?.title || 'Unknown Track',
                artist: song?.artist || 'Unknown Artist',
                label: song?.label || 'Unknown Label',
                rights_org: song?.rights_org || null,
                created_at: reportCreatedAt,
                updated_at: reportCreatedAt,
            });
            prodUpdateSubmissionFields(draft, submissionId, {
                status: song ? 'identified' : 'needs_advanced',
                report_ids: [reportRow.id],
            });
            if (jobId) {
                prodUpdateProcessingJob(draft, jobId, {
                    report_id: reportRow.id,
                    response_payload: {
                        recognized: Boolean(song),
                        song_title: song?.title || null,
                        artist: song?.artist || null,
                        label: song?.label || null,
                        rights_org: song?.rights_org || null,
                        match_score: Number(song?.matchScore ?? 0),
                    },
                    status: 'done',
                    finished_at: new Date().toISOString(),
                });
            }
        });
    } catch (error) {
        console.error('Quick-ID failed:', error);
        await mutatePlatformData((draft) => {
            const sub = prodFindSubmission(draft, submissionId);
            // Don't clobber a hash-mismatch 'failed'; otherwise mark needs_advanced
            // so the snitcher still gets a result and Phase 2 can retry.
            if (sub && sub.status === 'identifying') {
                prodUpdateSubmissionFields(draft, submissionId, { status: 'needs_advanced' });
            }
            if (jobId) prodUpdateProcessingJob(draft, jobId, { status: 'failed', error_message: error.message, finished_at: new Date().toISOString() });
        });
    } finally {
        processingSubmissions.delete(submissionId);
    }
};

const queueQuickIdentify = (submissionId) => {
    setTimeout(() => {
        quickIdentifySubmission(submissionId).catch((error) => {
            console.error('Queued quick-ID failed:', error);
        });
    }, 0);
};

// ─── Phase 2: Advanced processing (deferred / manual, heavy) ───
// The full forensic pass — Demucs (local or Replicate), multi-pass
// fingerprinting, source/visual/application analysis, and declared-context
// reconciliation. Triggered later/on-demand, NOT during capture. ENRICHES the
// Phase 1 quick-ID report in place (processing_stage 'quick_id' → 'full') rather
// than inserting a second report.
const runAdvancedProcessing = async (submissionId) => {
    if (processingSubmissions.has(submissionId)) {
        return;
    }
    processingSubmissions.add(submissionId);

    let jobId = null;

    try {
        // Mark in-progress and create a processing_jobs row.
        await mutatePlatformData((draft) => {
            const sub = prodFindSubmission(draft, submissionId);
            if (sub) {
                sub.status = 'processing';
                sub.updated_at = new Date().toISOString();
            }
            const job = prodInsertProcessingJob(draft, {
                submission_id: submissionId,
                job_type: 'full_pipeline',
                provider: 'internal',
                status: 'running',
                started_at: new Date().toISOString(),
            });
            jobId = job.id;
        });

        const data = await readPlatformData();
        const submission = prodFindSubmission(data, submissionId);
        if (!submission) {
            throw new Error('V2 submission not found');
        }

        // Resolve raw asset path from the production assets table.
        const rawAssetRow = data.production?.assets?.find(
            (a) => a.id === submission.raw_video_asset_id,
        ) || null;
        if (!rawAssetRow?.object_key) {
            throw new Error('Raw video asset missing from production store');
        }
        const rawAssetPath = path.join(MEDIA_DIR, rawAssetRow.object_key);

        // Hash integrity check.
        if (submission.media_sha256) {
            const rawFileBuffer = await fs.readFile(rawAssetPath);
            const computedHash = crypto.createHash('sha256').update(rawFileBuffer).digest('hex');
            if (computedHash !== submission.media_sha256) {
                await mutatePlatformData((draft) => {
                    prodUpdateSubmissionFields(draft, submissionId, { integrity_flag: 'hash_mismatch' });
                    if (jobId) prodUpdateProcessingJob(draft, jobId, { status: 'failed', error_message: 'hash_mismatch', finished_at: new Date().toISOString() });
                });
                throw new Error(`Media integrity check failed: hash mismatch (expected ${submission.media_sha256.slice(0, 12)}…)`);
            }
        }

        // Resolve the production venue row (upserted at capture-create time).
        const venueId = submission.selected_venue_context?.venue_id || null;
        const prodVenueRow = venueId
            ? (data.production?.venues?.find((v) => v.id === venueId) || null)
            : null;
        // Adapt to the shape Gemini helpers expect (camelCase subset).
        const venue = prodVenueRow ? {
            id: prodVenueRow.id,
            name: prodVenueRow.name,
            address: prodVenueRow.address,
            city: prodVenueRow.city,
            placeProviderId: prodVenueRow.place_provider_id,
        } : null;

        // Resolve capture session for offsets.
        const captureSession = data.production?.capture_sessions?.find(
            (cs) => cs.id === submission.capture_session_id,
        ) || null;

        const pipeline = await runEvidencePipeline({
            rawAssetPath,
            reference: submission.reference,
            submissionId,
            data,
            durationSeconds: submission.duration_seconds || 0,
            measuredStartOffsetMs: captureSession?.measured_start_offset_ms || 0,
            measuredEndOffsetMs: captureSession?.measured_end_offset_ms || 0,
            sourceClassifierMode: submission.capture_context?.source_classifier_mode || DEFAULT_SOURCE_CLASSIFIER_MODE,
            bestSongIdentity: null,
            venue,
        });

        const {
            song,
            audioDeconstruction,
            audioAsset,
            frameAssets,
            extractedFrames,
            sourceAnalysis,
            peakWindows,
            forensicSummary,
            visualAnalysis,
        } = pipeline;

        // Build applicationAssessment with reduced context — no merchant/case/contributor
        // (those are Slice 3). buildApplicationAssessmentContext handles null gracefully
        // for those fields.
        const appAssessmentContext = buildApplicationAssessmentContext({
            data,
            report: {
                matchedTrackConfidence: Number(pipeline.bestSongIdentityRecord?.matchScore ?? (song ? 1 : 0)),
                deviceTrustBand: 'unscored',
                licenseAssessment: { status: 'unknown' },
            },
            submission: {
                durationSeconds: submission.duration_seconds || 0,
                measuredStartOffsetMs: captureSession?.measured_start_offset_ms || 0,
                measuredEndOffsetMs: captureSession?.measured_end_offset_ms || 0,
                geolocationStart: submission.geolocation_start,
                geolocationEnd: submission.geolocation_end,
                selectedVenue: submission.selected_venue_context,
            },
            venue,
            merchant: null,
            caseRecord: null,
            contributor: null,
            sourceAnalysis,
            visualAnalysis: { ...visualAnalysis, peakWindows },
            forensicSummary,
            radioEvidence: submission.radio_context || null,
        });
        const applicationAssessment = config.groq_key
            ? await generateApplicationAssessment({ context: appAssessmentContext, frames: extractedFrames })
                .catch(() => buildFallbackApplicationAssessment(appAssessmentContext))
            : buildFallbackApplicationAssessment(appAssessmentContext);

        // Fuse the snitcher's DECLARED context (a claim) with the DETECTED
        // evidence. The LLM above reasoned on evidence only; reconcileContext
        // is the bounded, auditable overlay through which the declaration is
        // allowed to influence routing — never reward/legal. This is what makes
        // a private-looking-but-declared society event route to review instead
        // of being discarded, and what makes a contradicting claim light up.
        const reconciliation = reconcileContext({
            declared: submission.capture_context?.declared,
            detected: {
                sourceClass: sourceAnalysis?.sourceClass,
                visualPlaybackContext: visualAnalysis?.playbackContext,
                locationContext: applicationAssessment?.locationContext,
                privateSpaceRisk: applicationAssessment?.privateSpaceRisk,
            },
        });

        // Deterministic disposition overlay on top of the LLM's evidence-based
        // recommendation, recorded explicitly so the influence is auditable.
        let finalApplicationAssessment = applicationAssessment;
        if (reconciliation.dispositionOverride && applicationAssessment) {
            finalApplicationAssessment = {
                ...applicationAssessment,
                recommendedDisposition: reconciliation.dispositionOverride,
                contextOverlayApplied: true,
                priorityEscalated: reconciliation.priorityEscalated,
                reasons: reconciliation.reviewReason
                    ? [reconciliation.reviewReason, ...(applicationAssessment.reasons || [])]
                    : (applicationAssessment.reasons || []),
            };
        }

        await mutatePlatformData((draft) => {
            const reportCreatedAt = new Date().toISOString();
            // Enrich the Phase 1 quick-ID report in place; insert only if none
            // exists (e.g. a submission that skipped Phase 1).
            const existingReport = (prodFindSubmission(draft, submissionId)?.report_ids || [])
                .map((rid) => draft.production?.reports?.find((r) => r.id === rid))
                .find(Boolean) || null;

            // Song: prefer the heavy multi-pass result; otherwise keep whatever
            // Phase 1's quick pass already found on the report.
            const songFields = song ? {
                matched_track_confidence: Number(pipeline.bestSongIdentityRecord?.matchScore ?? 1),
                title: song.title || 'Unknown Track',
                artist: song.artist || 'Unknown Artist',
                label: song.label || 'Unknown Label',
                rights_org: song.rights_org || null,
            } : (existingReport && existingReport.title !== 'Unknown Track' ? {} : {
                matched_track_confidence: 0,
                title: 'Unknown Track',
                artist: 'Unknown Artist',
                label: 'Unknown Label',
            });

            const fullFields = {
                venue_id: prodVenueRow?.id || null,
                place_provider_id: prodVenueRow?.place_provider_id || null,
                processing_stage: 'full',
                forensic_summary: forensicSummary,
                source_analysis: sourceAnalysis,
                visual_analysis: { ...visualAnalysis, peakWindows },
                application_assessment: finalApplicationAssessment,
                license_assessment: { status: 'unknown', source: 'pending' },
                space_class: reconciliation.spaceClass,
                context_reconciliation: reconciliation,
                ...songFields,
            };

            let reportRow;
            if (existingReport) {
                reportRow = prodUpdateReportFields(draft, existingReport.id, fullFields);
            } else {
                reportRow = prodInsertReport(draft, {
                    reference: createReference('REP'),
                    submission_id: submissionId,
                    matched_track_id: null,
                    rights_owner_org_id: null,
                    rights_type: null,
                    device_trust_band: 'unscored',
                    analyst_status: 'unreviewed',
                    export_status: 'not_exported',
                    merchant_master_id: null,
                    created_at: reportCreatedAt,
                    updated_at: reportCreatedAt,
                    title: 'Unknown Track',
                    artist: 'Unknown Artist',
                    label: 'Unknown Label',
                    ...fullFields,
                });
            }

            prodUpdateSubmissionFields(draft, submissionId, {
                status: 'ready',
                derived_audio_asset_id: audioAsset.id,
                report_ids: [reportRow.id],
            });

            if (jobId) {
                prodUpdateProcessingJob(draft, jobId, {
                    report_id: reportRow.id,
                    output_asset_ids: [audioAsset.id, ...frameAssets.map((a) => a.id)],
                    response_payload: {
                        song_identified: Boolean(song),
                        song_title: song?.title || null,
                        source_class: sourceAnalysis?.sourceClass || null,
                        space_class: reconciliation.spaceClass,
                        declaration_agreement: reconciliation.agreement,
                        frame_count: frameAssets.length,
                        audio_deconstruction: audioDeconstruction,
                    },
                    status: 'done',
                    finished_at: new Date().toISOString(),
                });
            }
        });
    } catch (error) {
        console.error('V2 submission processing failed:', error);
        await mutatePlatformData((draft) => {
            prodUpdateSubmissionFields(draft, submissionId, { status: 'failed' });
            if (jobId) {
                prodUpdateProcessingJob(draft, jobId, {
                    status: 'failed',
                    error_message: error.message,
                    finished_at: new Date().toISOString(),
                });
            }
        });
    } finally {
        processingSubmissions.delete(submissionId);
    }
};

const queueAdvancedProcessing = (submissionId) => {
    setTimeout(() => {
        runAdvancedProcessing(submissionId).catch((error) => {
            console.error('Queued advanced processing failed:', error);
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

const normalizeRadioEntry = (entry, fallbackStatus = 'unavailable') => {
    if (!entry || typeof entry !== 'object') {
        return {
            status: fallbackStatus,
            captureMode: null,
            supportLevel: null,
            supportsNearbyScan: false,
            capturedAt: null,
            platform: null,
            executionEnvironment: null,
            observedTransportType: null,
            isConnected: null,
            isInternetReachable: null,
            isConnectionExpensive: null,
            ssid: null,
            bssid: null,
            strength: null,
            frequency: null,
            deviceCount: null,
            devices: [],
            note: null,
        };
    }

    const devices = Array.isArray(entry.devices)
        ? entry.devices
            .filter((item) => item && typeof item === 'object')
            .map((device) => ({
                id: pickStringLike(device.id),
                name: pickStringLike(device.name),
                localName: pickStringLike(device.localName),
                rssi: pickNumberLike(device.rssi),
                serviceUUIDs: Array.isArray(device.serviceUUIDs)
                    ? device.serviceUUIDs.map((uuid) => pickStringLike(uuid)).filter(Boolean)
                    : [],
                manufacturerDataPresent: device.manufacturerDataPresent === true,
                txPowerLevel: pickNumberLike(device.txPowerLevel),
            }))
            .filter((device) => device.id)
        : [];

    return {
        status: pickStringLike(entry.status) || fallbackStatus,
        captureMode: pickStringLike(entry.captureMode),
        supportLevel: pickStringLike(entry.supportLevel),
        supportsNearbyScan: entry.supportsNearbyScan === true,
        capturedAt: pickStringLike(entry.capturedAt),
        platform: pickStringLike(entry.platform),
        executionEnvironment: pickStringLike(entry.executionEnvironment),
        observedTransportType: pickStringLike(entry.observedTransportType),
        isConnected: pickBooleanLike(entry.isConnected),
        isInternetReachable: pickBooleanLike(entry.isInternetReachable),
        isConnectionExpensive: pickBooleanLike(entry.isConnectionExpensive),
        ssid: pickStringLike(entry.ssid),
        bssid: pickStringLike(entry.bssid),
        strength: pickNumberLike(entry.strength),
        frequency: pickNumberLike(entry.frequency),
        deviceCount: pickNumberLike(entry.deviceCount) ?? devices.length,
        devices,
        note: pickStringLike(entry.note),
    };
};

const normalizeRadioEvidence = (value) => {
    const raw = parseMaybeJson(value);
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const limitations = Array.isArray(raw.limitations)
        ? raw.limitations.map((item) => pickStringLike(item)).filter(Boolean)
        : [];

    const normalizeSnapshot = (snapshot) => {
        if (!snapshot || typeof snapshot !== 'object') {
            return null;
        }

        return {
            phase: pickStringLike(snapshot.phase) || null,
            capturedAt: pickStringLike(snapshot.capturedAt) || null,
            wifi: normalizeRadioEntry(snapshot.wifi, 'unavailable'),
            bluetooth: normalizeRadioEntry(snapshot.bluetooth, 'unsupported'),
        };
    };

    const start = normalizeSnapshot(raw.start);
    const end = normalizeSnapshot(raw.end);

    if (!start && !end && limitations.length === 0) {
        return null;
    }

    return {
        collectionVersion: pickStringLike(raw.collectionVersion) || 'radio-evidence-v1',
        start,
        end,
        limitations,
    };
};

const getLatestRadioEntry = (radioEvidence, key) => radioEvidence?.end?.[key] || radioEvidence?.start?.[key] || null;

const summarizeRadioEntry = (entry) => {
    if (!entry) {
        return 'Not captured';
    }

    if (entry.captureMode === 'nearby_ble_scan' && entry.deviceCount != null) {
        if (entry.deviceCount > 0) {
            return `${entry.deviceCount} BLE device${entry.deviceCount === 1 ? '' : 's'} nearby`;
        }

        if (entry.status === 'captured') {
            return 'No BLE devices discovered';
        }
    }

    if (entry.status === 'captured' && entry.ssid) {
        return `${entry.ssid}${entry.frequency ? ` • ${entry.frequency} MHz` : ''}`;
    }

    if (entry.status === 'captured') {
        return 'Connected context captured';
    }

    if (entry.status === 'not_connected') {
        return 'Not connected during capture';
    }

    return entry.note || entry.status || 'Unavailable';
};

const APPLICATION_LOCATION_CONTEXTS = [
    'inside_venue',
    'venue_perimeter',
    'adjacent_bleed',
    'private_home',
    'private_hotel_room',
    'vehicle',
    'screen_replay',
    'outlet_ambiguity',
    'inconclusive',
];

const APPLICATION_DISPOSITIONS = [
    'attack_now',
    'build_corroboration',
    'manual_review',
    'do_not_pursue',
];

const APPLICATION_EDGE_TAGS = [
    'home_recording',
    'adjacent_bleed',
    'venue_perimeter',
    'wrong_unit',
    'property_ambiguity',
    'private_room',
    'vehicle_capture',
    'screen_replay',
    'livestream_replay',
    'temporary_event',
    'gps_ambiguity',
    'radio_overclaim_risk',
    'farming_risk',
    'high_value_low_clarity',
    'chain_outlet_mismatch',
];

const privateHomePatterns = [
    /\bcouch\b/i,
    /\bsofa\b/i,
    /\bbed\b/i,
    /\bbedroom\b/i,
    /\bliving room\b/i,
    /\bapartment\b/i,
    /\bhome\b/i,
    /\bhouse\b/i,
];

const screenReplayPatterns = [
    /\bscreen\b/i,
    /\bmonitor\b/i,
    /\btv\b/i,
    /\btelevision\b/i,
    /\btablet\b/i,
    /\binstagram\b/i,
    /\breel\b/i,
    /\blivestream\b/i,
    /\byoutube\b/i,
    /\blaptop screen\b/i,
    /\bphone screen\b/i,
    /\bplaying on (a )?phone\b/i,
    /\bplaying on (a )?laptop\b/i,
];

const directFeedReplayPatterns = [
    /\bdigital audio overlay\b/i,
    /\baudio overlay\b/i,
    /\boverdub\b/i,
    /\bnot an ambient microphone recording\b/i,
    /\bdirect feed\b/i,
    /\bline feed\b/i,
];

const negatedDirectFeedPatterns = [
    /\brather than (a )?(direct|line) feed\b/i,
    /\bnot (a )?(direct|line) feed\b/i,
    /\bno (direct|line) feed\b/i,
    /\bwithout (a )?(direct|line) feed\b/i,
];

const publicVenuePatterns = [
    /\bcafe\b/i,
    /\bcoffee shop\b/i,
    /\brestaurant\b/i,
    /\bbarista\b/i,
    /\bpatron\b/i,
    /\btables\b/i,
    /\bchairs\b/i,
    /\bservice counter\b/i,
    /\bcounter\b/i,
    /\bmenu\b/i,
    /\bsignage\b/i,
    /\bbranded wall\b/i,
];

const vehiclePatterns = [
    /\bcar\b/i,
    /\btaxi\b/i,
    /\bvehicle\b/i,
    /\bdashboard\b/i,
    /\bwindshield\b/i,
    /\bsteering\b/i,
];

const hotelRoomPatterns = [
    /\bhotel room\b/i,
    /\bsuite\b/i,
    /\bbedside\b/i,
    /\bminibar\b/i,
    /\broom service\b/i,
];

const outdoorPerimeterPatterns = [
    /\bparking\b/i,
    /\bvalet\b/i,
    /\bstreet\b/i,
    /\broad\b/i,
    /\bsidewalk\b/i,
    /\boutdoor\b/i,
    /\bsmoking area\b/i,
];

const propertyAmbiguityPatterns = [
    /\bhotel\b/i,
    /\bmall\b/i,
    /\bfood court\b/i,
    /\bbanquet\b/i,
    /\bplaza\b/i,
    /\blobby\b/i,
    /\bproperty\b/i,
];

const crowdPatterns = [
    /\bcrowd\b/i,
    /\bchatter\b/i,
    /\bcheer/i,
    /\bsinging along\b/i,
    /\bbar\b/i,
    /\btables\b/i,
    /\bdj\b/i,
    /\bstage\b/i,
    /\bvenue\b/i,
    /\bservice area\b/i,
];

const includesAnyPattern = (text, patterns = []) => patterns.some((pattern) => pattern.test(text));

const hasDirectFeedReplayCue = (text) => {
    const value = String(text || '');
    const hasOverlayCue = directFeedReplayPatterns
        .slice(0, 4)
        .some((pattern) => pattern.test(value));
    if (hasOverlayCue) {
        return true;
    }

    return /\b(direct|line) feed\b/i.test(value)
        && !includesAnyPattern(value, negatedDirectFeedPatterns);
};

const buildInstallHistorySignals = ({ data, submission, currentReport = null }) => {
    if (!submission?.installId) {
        return {
            recentSubmissionCount30d: 0,
            recentReportCount30d: 0,
            weakReportCount30d: 0,
            distinctVenueCount30d: 0,
        };
    }

    const now = Date.now();
    const sameInstallSubmissions = data.submissions.filter((entry) => (
        entry.installId === submission.installId
        && (now - new Date(entry.createdAt || 0).getTime()) <= 30 * 24 * 60 * 60 * 1000
    ));
    const reportIds = new Set(sameInstallSubmissions.flatMap((entry) => entry.reportIds || []));
    const sameInstallReports = data.reports.filter((entry) => reportIds.has(entry.id));
    if (currentReport) {
        sameInstallReports.push(currentReport);
    }

    const weakReportCount30d = sameInstallReports.filter((entry) => {
        const sourceClass = entry.sourceAnalysis?.sourceClass || null;
        return Number(entry.matchedTrackConfidence || 0) < 0.5
            || ['likely_small_speaker', 'likely_personal_device', 'inconclusive'].includes(sourceClass);
    }).length;

    const distinctVenueCount30d = new Set(
        sameInstallSubmissions.map((entry) => cleanString(entry.selectedVenue?.name || entry.matchedVenue || entry.businessName || entry.venueId || ''))
            .filter(Boolean)
    ).size;

    return {
        recentSubmissionCount30d: sameInstallSubmissions.length,
        recentReportCount30d: sameInstallReports.length,
        weakReportCount30d,
        distinctVenueCount30d,
    };
};

const buildApplicationAssessmentContext = ({
    data,
    report,
    submission,
    venue,
    merchant,
    caseRecord,
    contributor,
    sourceAnalysis,
    visualAnalysis,
    forensicSummary,
    radioEvidence,
}) => {
    const start = submission?.geolocationStart || null;
    const end = submission?.geolocationEnd || null;
    const locationDelta = buildLocationDelta({ submission, venue });
    const averageAccuracyMeters = locationDelta.averageAccuracyMeters;
    const geoDistanceMeters = locationDelta.minVenueDistanceMeters;
    const geoBucket = locationDelta.geoBucket;
    const selectedVenueName = submission?.selectedVenue?.name || null;
    const matchedVenueName = venue?.name || submission?.matchedVenue || null;
    const selectedMatchedAligned = locationDelta.selectedMatchedAligned;
    const gpsTrackAnalysis = submission?.gpsTrackAnalysis || analyzeGpsTrack(submission?.gpsTrack) || null;
    const wifiEvidence = getLatestRadioEntry(radioEvidence, 'wifi');
    const bluetoothEvidence = getLatestRadioEntry(radioEvidence, 'bluetooth');
    const narrativeText = [
        forensicSummary,
        visualAnalysis?.summary,
        ...(visualAnalysis?.visibleEquipment || []),
        ...(visualAnalysis?.venueIdentitySignals || []),
        ...(visualAnalysis?.obstructionFlags || []),
        ...(visualAnalysis?.frameObservations || []).map((entry) => entry.observation),
    ].filter(Boolean).join(' ');
    const venueCueCount = (visualAnalysis?.visibleEquipment || []).length + (visualAnalysis?.venueIdentitySignals || []).length;
    const installHistory = buildInstallHistorySignals({ data, submission, currentReport: report });

    return {
        capture: {
            durationSeconds: Number(submission?.durationSeconds || 0),
            averageAccuracyMeters,
            geoDistanceMeters,
            geoBucket,
            start,
            end,
            deviceTrustBand: report?.deviceTrustBand || null,
            gpsTrack: gpsTrackAnalysis ? {
                pointCount: gpsTrackAnalysis.pointCount,
                totalPathMeters: gpsTrackAnalysis.totalPathMeters,
                maxDeviationMeters: gpsTrackAnalysis.maxDeviationMeters,
                velocityCategory: gpsTrackAnalysis.velocityCategory,
                isStationary: gpsTrackAnalysis.isStationary,
            } : null,
        },
        locationDelta,
        venue: {
            selectedVenueName,
            matchedVenueName,
            selectedMatchedAligned,
            matchedVenueAddress: venue?.address || submission?.selectedVenue?.address || null,
            city: venue?.city || submission?.selectedVenue?.city || null,
            placeProviderId: venue?.placeProviderId || submission?.selectedVenue?.placeProviderId || null,
        },
        merchant: {
            venueType: merchant?.venueType || null,
            outletCount: merchant?.outletCount || null,
            gstinPresent: Boolean(merchant?.gstin),
        },
        caseContext: {
            estimatedRecoverableValueInr: Number(report?.estimatedRecoverableValueInr || caseRecord?.estimatedRecoverableValueInr || 0),
            licenseStatus: report?.licenseAssessment?.status || caseRecord?.licenseStatus || 'unknown',
            planningBand: caseRecord?.planningBand || null,
        },
        audio: {
            matchedTrackConfidence: Number(report?.matchedTrackConfidence || 0),
            forensicSummary: forensicSummary || '',
            sourceClass: sourceAnalysis?.sourceClass || 'inconclusive',
            sourceConfidence: Number(sourceAnalysis?.confidence || 0),
            nearFieldBloomSuspicion: Number(sourceAnalysis?.signals?.nearFieldBloomSuspicion || 0),
        },
        visual: {
            playbackContext: visualAnalysis?.playbackContext || 'inconclusive',
            confidence: Number(visualAnalysis?.confidence || 0),
            visibleEquipment: visualAnalysis?.visibleEquipment || [],
            venueIdentitySignals: visualAnalysis?.venueIdentitySignals || [],
            obstructionFlags: visualAnalysis?.obstructionFlags || [],
            summary: visualAnalysis?.summary || '',
            frameObservations: visualAnalysis?.frameObservations || [],
            venueCueCount,
            narrativeText,
        },
        radio: {
            wifi: {
                connected: wifiEvidence?.isConnected === true || wifiEvidence?.status === 'connected',
                status: wifiEvidence?.status || null,
                transport: wifiEvidence?.transport || null,
                ssid: wifiEvidence?.ssid || null,
                bssid: wifiEvidence?.bssid || null,
                summary: summarizeRadioEntry(wifiEvidence),
                ssidPresent: Boolean(wifiEvidence?.ssid),
                bssidPresent: Boolean(wifiEvidence?.bssid),
            },
            bluetooth: {
                status: bluetoothEvidence?.status || null,
                deviceCount: Number(bluetoothEvidence?.deviceCount || 0),
            },
            limitations: radioEvidence?.limitations || [],
        },
        contributor: contributor ? {
            trustTier: contributor.trustTier || null,
            status: contributor.status || null,
        } : null,
        installHistory,
    };
};

const sanitizeApplicationAssessment = (assessment, context, fallbackModelVersion = 'application-v1') => {
    if (!assessment || typeof assessment !== 'object') {
        return null;
    }

    const reasons = Array.isArray(assessment.reasons)
        ? assessment.reasons.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 6)
        : [];
    const evidenceGaps = Array.isArray(assessment.evidenceGaps)
        ? assessment.evidenceGaps.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 6)
        : [];
    const edgeCaseTags = Array.isArray(assessment.edgeCaseTags)
        ? assessment.edgeCaseTags
            .map((entry) => cleanString(entry).replace(/\s+/g, '_'))
            .filter((entry) => APPLICATION_EDGE_TAGS.includes(entry))
            .slice(0, 8)
        : [];

    return {
        locationContext: APPLICATION_LOCATION_CONTEXTS.includes(assessment.locationContext)
            ? assessment.locationContext
            : 'inconclusive',
        confidence: scoreZeroToOne(assessment.confidence, 0.35),
        venueAttributionRisk: scoreZeroToOne(assessment.venueAttributionRisk, 0.5),
        privateSpaceRisk: scoreZeroToOne(assessment.privateSpaceRisk, 0.3),
        replayRisk: scoreZeroToOne(assessment.replayRisk, 0.3),
        outletAmbiguityRisk: scoreZeroToOne(assessment.outletAmbiguityRisk, 0.3),
        farmingRisk: scoreZeroToOne(assessment.farmingRisk, 0.2),
        attackReadiness: scoreZeroToOne(assessment.attackReadiness, 0.35),
        recommendedDisposition: APPLICATION_DISPOSITIONS.includes(assessment.recommendedDisposition)
            ? assessment.recommendedDisposition
            : 'manual_review',
        reasons,
        evidenceGaps,
        edgeCaseTags,
        signalSummary: {
            geoDistanceMeters: context.capture.geoDistanceMeters,
            averageAccuracyMeters: context.capture.averageAccuracyMeters,
            geoBucket: context.capture.geoBucket,
            primaryVenueSource: context.locationDelta.primaryVenueSource,
            capturePathDeltaMeters: context.locationDelta.capturePathDeltaMeters,
            venueAnchorDeltaMeters: context.locationDelta.venueAnchorDeltaMeters,
            withinAccuracyEnvelope: context.locationDelta.withinAccuracyEnvelope,
            matchedVenueDistanceStartMeters: context.locationDelta.matchedVenueDistanceStartMeters,
            matchedVenueDistanceEndMeters: context.locationDelta.matchedVenueDistanceEndMeters,
            selectedVenueDistanceStartMeters: context.locationDelta.selectedVenueDistanceStartMeters,
            selectedVenueDistanceEndMeters: context.locationDelta.selectedVenueDistanceEndMeters,
            selectedMatchedAligned: context.venue.selectedMatchedAligned,
            venueCueCount: context.visual.venueCueCount,
            wifiConnected: Boolean(context.radio.wifi.connected),
            sourceClass: context.audio.sourceClass,
            visualPlaybackContext: context.visual.playbackContext,
            sameInstallRecentReports30d: context.installHistory.recentReportCount30d,
            sameInstallWeakReports30d: context.installHistory.weakReportCount30d,
            sameInstallDistinctVenues30d: context.installHistory.distinctVenueCount30d,
        },
        modelVersion: String(assessment.modelVersion || fallbackModelVersion),
    };
};

const buildFallbackApplicationAssessment = (context) => {
    const text = context.visual.narrativeText || '';
    const selectedMatchedAligned = Boolean(context.venue.selectedMatchedAligned);
    const sourceClass = context.audio.sourceClass;
    // The structured classifier is authoritative for what kind of playback (if
    // any) is present. A small venue speaker is a venue source, not a personal
    // device; no-music/speech/TV classes mean there is no enforceable venue
    // playback regardless of what the narrative text says.
    const sourceVenuePlayback = sourceClassSupportsVenuePlayback(sourceClass);
    const sourceNonMusic = isNonMusicSourceClass(sourceClass);
    const sourcePersonal = ['likely_personal_device', 'personal_device'].includes(sourceClass);
    const sourcePa = sourceVenuePlayback;
    const nearField = context.audio.nearFieldBloomSuspicion >= 1;
    const crowdCue = includesAnyPattern(text, crowdPatterns);
    const publicVenueCue = includesAnyPattern(text, publicVenuePatterns);
    const directFeedCue = hasDirectFeedReplayCue(text);
    const venueNameTokens = [
        context.venue.selectedVenueName,
        context.venue.matchedVenueName,
    ]
        .flatMap((name) => cleanString(name).split(/[^a-z0-9]+/i))
        .filter((token) => token.length >= 4);
    const radioText = cleanString([
        context.radio.wifi.ssid,
        context.radio.wifi.bssid,
        context.radio.wifi.summary,
    ].filter(Boolean).join(' '));
    const radioVenueCue = Boolean(
        context.radio.wifi.connected
        && radioText
        && venueNameTokens.some((token) => radioText.includes(token))
    );
    const strongVenueContext = selectedMatchedAligned
        && context.capture.geoBucket === 'inside'
        && (crowdCue || publicVenueCue || radioVenueCue || context.visual.venueCueCount >= 3);
    const homeCue = includesAnyPattern(text, privateHomePatterns) && !strongVenueContext;
    const screenCue = sourceClass === 'tv_screen' || directFeedCue || (includesAnyPattern(text, screenReplayPatterns) && !strongVenueContext);
    const vehicleCue = includesAnyPattern(text, vehiclePatterns);
    const hotelCue = includesAnyPattern(text, hotelRoomPatterns)
        || (cleanString(context.merchant.venueType).includes('hotel') && homeCue);
    const outdoorCue = includesAnyPattern(text, outdoorPerimeterPatterns);
    const propertyAmbiguityCue = includesAnyPattern(text, propertyAmbiguityPatterns)
        || cleanString(context.merchant.venueType).includes('banquet')
        || cleanString(context.merchant.venueType).includes('hotel');
    const gpsTrack = context.capture.gpsTrack || null;
    const trackConfirmedStationary = gpsTrack?.isStationary === true;
    const trackConfirmedVehicle = gpsTrack?.velocityCategory === 'vehicle';
    const trackHasData = gpsTrack?.pointCount >= 3;
    const largeCaptureMovement = trackHasData
        ? (gpsTrack.totalPathMeters >= 80 || gpsTrack.maxDeviationMeters >= 60)
        : Number(context.locationDelta.capturePathDeltaMeters || 0) >= 80;
    const anchorMismatch = Number(context.locationDelta.venueAnchorDeltaMeters || 0) >= 120;
    const obstructionPenalty = Math.min(0.3, (context.visual.obstructionFlags.length || 0) * 0.08);
    const venueCueSupport = Math.min(0.28, context.visual.venueCueCount * 0.08);
    const venueContextMitigation = strongVenueContext ? 0.26 : 0;
    const radioVenueMitigation = radioVenueCue ? 0.08 : 0;
    const installedPlaybackMitigation = strongVenueContext && sourcePa && !nearField ? 0.12 : 0;

    let attributionConfidence = 0.16;
    if (context.capture.geoBucket === 'inside') {
        attributionConfidence += 0.34;
    } else if (context.capture.geoBucket === 'perimeter') {
        attributionConfidence += 0.16;
    }
    if (selectedMatchedAligned) {
        attributionConfidence += 0.12;
    }
    attributionConfidence += venueCueSupport;
    if (crowdCue) {
        attributionConfidence += 0.08;
    }
    if (context.radio.wifi.connected && (context.radio.wifi.ssidPresent || context.radio.wifi.bssidPresent)) {
        attributionConfidence += radioVenueCue ? 0.1 : 0.05;
    }
    if (sourcePa && !nearField) {
        attributionConfidence += 0.08;
    }
    if (strongVenueContext) {
        attributionConfidence += 0.08;
    }
    // GPS track bonus: a confirmed-stationary track is strong venue-dwell evidence.
    if (trackConfirmedStationary && trackHasData) {
        attributionConfidence += 0.10;
    }
    if (context.capture.geoBucket === 'outside') {
        attributionConfidence -= 0.16;
    }
    if (sourcePersonal) {
        attributionConfidence -= 0.12;
    }
    if (sourceNonMusic) {
        attributionConfidence -= 0.2;
    }
    if (screenCue || homeCue || vehicleCue || trackConfirmedVehicle) {
        attributionConfidence -= 0.18;
    }
    if (context.locationDelta.withinAccuracyEnvelope === false) {
        attributionConfidence -= 0.1;
    }
    if (anchorMismatch) {
        attributionConfidence -= 0.08;
    }
    attributionConfidence -= obstructionPenalty;
    attributionConfidence = scoreZeroToOne(attributionConfidence, 0.15);

    const venueAttributionRisk = scoreZeroToOne(
        (1 - attributionConfidence)
        + (context.capture.geoBucket === 'outside' ? 0.12 : 0)
        + (context.locationDelta.withinAccuracyEnvelope === false ? 0.08 : 0)
        + (!selectedMatchedAligned && context.venue.selectedVenueName && context.venue.matchedVenueName ? 0.08 : 0),
        0.5
    );
    const privateSpaceRisk = scoreZeroToOne(
        (homeCue ? 0.42 : 0)
        + (hotelCue ? 0.38 : 0)
        + ((vehicleCue || largeCaptureMovement) ? 0.3 : 0)
        + (screenCue ? 0.18 : 0)
        + (sourcePersonal ? 0.18 : 0)
        + (nearField ? 0.15 : 0)
        + (!crowdCue && context.visual.venueCueCount === 0 ? 0.1 : 0)
        - venueContextMitigation
        - radioVenueMitigation
        - installedPlaybackMitigation,
        0.3
    );
    const replayRisk = scoreZeroToOne(
        (screenCue ? 0.48 : 0)
        + (directFeedCue ? 0.24 : 0)
        + (sourcePersonal ? 0.16 : 0)
        + (nearField ? 0.12 : 0)
        + (context.visual.venueCueCount === 0 ? 0.08 : 0)
        + (!crowdCue ? 0.06 : 0)
        - venueContextMitigation
        - radioVenueMitigation
        - installedPlaybackMitigation,
        0.25
    );
    const outletAmbiguityRisk = scoreZeroToOne(
        (propertyAmbiguityCue ? 0.32 : 0)
        + (anchorMismatch ? 0.22 : 0)
        + (!selectedMatchedAligned && context.venue.selectedVenueName && context.venue.matchedVenueName ? 0.22 : 0)
        + (context.visual.venueCueCount === 0 ? 0.08 : 0)
        + (context.capture.geoBucket === 'inside' ? 0.04 : 0),
        0.24
    );
    const farmingRisk = scoreZeroToOne(
        (context.installHistory.recentReportCount30d >= 4 ? 0.22 : 0)
        + (context.installHistory.weakReportCount30d >= 3 ? 0.34 : 0)
        + (context.installHistory.distinctVenueCount30d >= 3 ? 0.22 : 0)
        + (context.capture.deviceTrustBand === 'low' ? 0.14 : 0),
        0.18
    );

    let locationContext = 'inconclusive';
    if (screenCue && replayRisk >= 0.6) {
        locationContext = 'screen_replay';
    } else if ((vehicleCue || largeCaptureMovement) && privateSpaceRisk >= 0.5) {
        locationContext = 'vehicle';
    } else if (hotelCue && privateSpaceRisk >= 0.52) {
        locationContext = 'private_hotel_room';
    } else if (homeCue && privateSpaceRisk >= 0.52) {
        locationContext = 'private_home';
    } else if (outletAmbiguityRisk >= 0.58 && context.capture.geoBucket !== 'outside') {
        locationContext = 'outlet_ambiguity';
    } else if (context.capture.geoBucket === 'inside' && attributionConfidence >= 0.6) {
        locationContext = 'inside_venue';
    } else if (context.capture.geoBucket === 'perimeter' && attributionConfidence >= 0.42) {
        locationContext = 'venue_perimeter';
    } else if (context.capture.geoBucket === 'outside' && (crowdCue || outdoorCue)) {
        locationContext = 'adjacent_bleed';
    }

    const sceneDominantRisk = Math.max(
        venueAttributionRisk,
        privateSpaceRisk,
        replayRisk,
        outletAmbiguityRisk
    );
    const dominantRisk = Math.max(
        sceneDominantRisk,
        farmingRisk
    );
    const attackReadiness = scoreZeroToOne(
        (attributionConfidence * 0.68)
        + (sourcePa ? 0.1 : 0)
        + (crowdCue ? 0.08 : 0)
        + (context.visual.venueCueCount >= 2 ? 0.08 : 0)
        - (dominantRisk * 0.55),
        0.25
    );
    const confidence = scoreZeroToOne(
        0.32
        + Math.min(0.26, context.visual.venueCueCount * 0.06)
        + (context.capture.geoBucket !== 'unknown' ? 0.12 : 0)
        + ((screenCue || homeCue || vehicleCue || crowdCue) ? 0.12 : 0)
        - obstructionPenalty,
        0.3
    );

    let recommendedDisposition = 'manual_review';
    if (locationContext === 'inside_venue' && attackReadiness >= 0.7 && sceneDominantRisk < 0.4 && farmingRisk < 0.4) {
        recommendedDisposition = 'attack_now';
    } else if (
        ['inside_venue', 'venue_perimeter', 'adjacent_bleed', 'outlet_ambiguity'].includes(locationContext)
        && sceneDominantRisk < 0.58
        && farmingRisk >= 0.78
    ) {
        recommendedDisposition = 'manual_review';
    } else if (
        ['inside_venue', 'venue_perimeter', 'adjacent_bleed', 'outlet_ambiguity'].includes(locationContext)
        && attackReadiness >= 0.42
        && sceneDominantRisk < 0.72
        && farmingRisk < 0.72
    ) {
        recommendedDisposition = 'build_corroboration';
    } else if (
        ['private_home', 'private_hotel_room', 'screen_replay'].includes(locationContext)
        || sceneDominantRisk >= 0.78
    ) {
        recommendedDisposition = 'do_not_pursue';
    }

    const reasons = [];
    const evidenceGaps = [];
    const edgeCaseTags = [];

    if (context.locationDelta.matchedVenueDistanceStartMeters != null || context.locationDelta.matchedVenueDistanceEndMeters != null) {
        reasons.push(`Matched venue delta: start ${context.locationDelta.matchedVenueDistanceStartMeters != null ? `${Math.round(context.locationDelta.matchedVenueDistanceStartMeters)} m` : 'n/a'} / end ${context.locationDelta.matchedVenueDistanceEndMeters != null ? `${Math.round(context.locationDelta.matchedVenueDistanceEndMeters)} m` : 'n/a'}.`);
    } else if (context.locationDelta.selectedVenueDistanceStartMeters != null || context.locationDelta.selectedVenueDistanceEndMeters != null) {
        reasons.push(`Selected venue delta: start ${context.locationDelta.selectedVenueDistanceStartMeters != null ? `${Math.round(context.locationDelta.selectedVenueDistanceStartMeters)} m` : 'n/a'} / end ${context.locationDelta.selectedVenueDistanceEndMeters != null ? `${Math.round(context.locationDelta.selectedVenueDistanceEndMeters)} m` : 'n/a'}.`);
    } else if (context.capture.geoDistanceMeters != null) {
        reasons.push(`Capture point sits ${Math.round(context.capture.geoDistanceMeters)} m from the primary venue anchor.`);
    } else {
        evidenceGaps.push('Reliable venue-distance measurement is unavailable.');
    }
    if (context.venue.selectedVenueName && context.locationDelta.selectedVenueDistanceStartMeters == null && context.locationDelta.selectedVenueDistanceEndMeters == null) {
        evidenceGaps.push('Selected venue coordinates are missing, so chosen-venue delta could not be measured.');
    }
    if (context.venue.matchedVenueName && context.locationDelta.matchedVenueDistanceStartMeters == null && context.locationDelta.matchedVenueDistanceEndMeters == null) {
        evidenceGaps.push('Matched venue coordinates are missing, so matched-venue delta could not be measured.');
    }
    if (context.locationDelta.capturePathDeltaMeters != null) {
        reasons.push(`Capture path moved ${Math.round(context.locationDelta.capturePathDeltaMeters)} m between start and end.`);
    }
    if (context.locationDelta.venueAnchorDeltaMeters != null) {
        reasons.push(`Selected vs matched venue anchors are ${Math.round(context.locationDelta.venueAnchorDeltaMeters)} m apart.`);
    }
    if (context.locationDelta.withinAccuracyEnvelope === false) {
        evidenceGaps.push('Capture sits outside the current GPS accuracy envelope for the primary venue anchor.');
    }
    if (selectedMatchedAligned) {
        reasons.push('Selected venue and matched venue names align.');
    } else if (context.venue.selectedVenueName && context.venue.matchedVenueName) {
        reasons.push('Selected venue and matched venue names do not align cleanly.');
        edgeCaseTags.push('chain_outlet_mismatch');
    }
    if (crowdCue) {
        reasons.push('Narrative cues suggest crowd or public-space ambience.');
    } else {
        evidenceGaps.push('Crowd or public-performance ambience is weak.');
    }
    if (context.visual.venueCueCount) {
        reasons.push(`Visual layer surfaced ${context.visual.venueCueCount} venue/equipment cue(s).`);
    } else {
        evidenceGaps.push('Visual venue identity cues are missing.');
    }
    if (context.radio.wifi.connected) {
        reasons.push('Device was connected to Wi-Fi during capture, but that remains corroborating only.');
        edgeCaseTags.push('radio_overclaim_risk');
    }
    if (radioVenueCue) {
        reasons.push('Connected Wi-Fi context includes venue-name cues.');
    }
    if (sourcePersonal || nearField) {
        reasons.push('Audio source signals lean toward near-field or personal-device playback.');
    }
    if (sourceNonMusic) {
        reasons.push(`Source classifier reports no enforceable venue music playback (${toOperationalSourceLabel(sourceClass)}).`);
        evidenceGaps.push('No venue music playback was detected in the capture audio.');
    }
    if (screenCue) {
        edgeCaseTags.push('screen_replay');
        if (directFeedCue || /\blivestream\b|\breel\b|\binstagram\b/i.test(text)) {
            edgeCaseTags.push('livestream_replay');
        }
    }
    if (directFeedCue) {
        reasons.push('Forensic audio narrative suggests direct feed or digital overlay risk.');
        evidenceGaps.push('Confirm the audio is ambient room capture rather than injected or overlaid media.');
    }
    if (homeCue) {
        edgeCaseTags.push('home_recording');
    }
    if (hotelCue) {
        edgeCaseTags.push('private_room');
    }
    if (vehicleCue || largeCaptureMovement || trackConfirmedVehicle) {
        edgeCaseTags.push('vehicle_capture');
    }
    if (trackConfirmedVehicle) {
        reasons.push('GPS track velocity pattern is consistent with vehicle movement during capture.');
    }
    if (trackConfirmedStationary && trackHasData) {
        reasons.push(`GPS track (${gpsTrack.pointCount} pts, path ${Math.round(gpsTrack.totalPathMeters)} m) confirms device was stationary throughout capture.`);
    } else if (trackHasData && largeCaptureMovement) {
        reasons.push(`GPS track shows significant movement: path ${Math.round(gpsTrack.totalPathMeters)} m, max deviation ${Math.round(gpsTrack.maxDeviationMeters)} m.`);
    }
    if (context.capture.geoBucket === 'perimeter') {
        edgeCaseTags.push('venue_perimeter');
    }
    if (context.capture.geoBucket === 'outside' && (crowdCue || outdoorCue)) {
        edgeCaseTags.push('adjacent_bleed');
    }
    if (outletAmbiguityRisk >= 0.55) {
        edgeCaseTags.push(propertyAmbiguityCue ? 'property_ambiguity' : 'wrong_unit');
    }
    if (farmingRisk >= 0.5) {
        edgeCaseTags.push('farming_risk');
        if (
            ['inside_venue', 'venue_perimeter', 'adjacent_bleed', 'outlet_ambiguity'].includes(locationContext)
            && sceneDominantRisk < 0.58
        ) {
            reasons.push('Install-level abuse/farming risk is elevated, but scene-level signals still support a venue capture.');
            evidenceGaps.push('Escalate to analyst or abuse review before acting on this packet.');
        }
    }
    if (context.caseContext.estimatedRecoverableValueInr >= 75000 && dominantRisk >= 0.5) {
        edgeCaseTags.push('high_value_low_clarity');
    }
    if (context.capture.averageAccuracyMeters != null && context.capture.averageAccuracyMeters > 50) {
        edgeCaseTags.push('gps_ambiguity');
        evidenceGaps.push(`GPS accuracy is coarse at roughly ${Math.round(context.capture.averageAccuracyMeters)} m.`);
    }

    return sanitizeApplicationAssessment({
        locationContext,
        confidence,
        venueAttributionRisk,
        privateSpaceRisk,
        replayRisk,
        outletAmbiguityRisk,
        farmingRisk,
        attackReadiness,
        recommendedDisposition,
        reasons,
        evidenceGaps,
        edgeCaseTags,
        modelVersion: 'application-v1-fallback',
    }, context, 'application-v1-fallback');
};

async function generateApplicationAssessment({ context, frames = [] }) {
    const parts = [];
    frames.slice(0, 3).forEach((frame, index) => {
        parts.push({ text: `Frame ${index + 1} was captured at ${Number(frame.timestampSeconds || 0).toFixed(2)} seconds.` });
        parts.push({ inlineData: { data: frame.buffer.toString('base64'), mimeType: frame.mimeType || 'image/jpeg' } });
    });
    parts.push({ text: buildApplicationAssessmentPrompt(context) });

    const text = await generateAIText({ parts, label: 'application assessment', jsonMode: true });
    return sanitizeApplicationAssessment(parseModelJson(text), context, 'application-v1');
}

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

const shouldUseAIForRescore = (useGemini = true) => useGemini && Boolean(config.groq_key);

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

        if (shouldUseAIForRescore(useGemini) && frames.length) {
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

        const applicationAssessment = shouldUseAIForRescore(useGemini)
            ? await generateApplicationAssessment({ context, frames }).catch((error) => {
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
    const songIdentity = submission?.songIdentity || null;
    const sourceAnalysis = report.sourceAnalysis || submission?.sourceAnalysis || null;
    const sourceReview = report.sourceReview || null;
    const visualAnalysis = report.visualAnalysis || submission?.visualAnalysis || null;
    const radioEvidence = submission?.radioEvidence || null;
    const locationDelta = buildLocationDelta({ submission, venue });
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

    return {
        packageVersion: 'evidence-package-v2',
        captureIntegrity: {
            submissionReference: submission?.reference || null,
            captureSessionId: submission?.captureSessionId || null,
            originSurface: submission?.source || null,
            consentVersion: submission?.consentVersion || null,
            durationSeconds: submission?.durationSeconds || null,
            mediaSha256: submission?.mediaSha256 || null,
            signatureStatus: getPresentationSignatureStatus(submission),
            clockSkewStatus: submission?.clockSkewFlag ? 'flagged' : 'clear',
            measuredOffsetsMs: {
                start: submission?.measuredStartOffsetMs ?? null,
                end: submission?.measuredEndOffsetMs ?? null,
            },
            timestamps: {
                localStartTime: submission?.localStartTime || null,
                localEndTime: submission?.localEndTime || null,
                finalizedAt: submission?.finalizedAt || null,
                processingStartedAt: submission?.processingStartedAt || null,
                processingCompletedAt: submission?.processingCompletedAt || null,
            },
            device: {
                model: submission?.deviceModel || null,
                osVersion: submission?.osVersion || null,
                appVersion: submission?.appVersion || null,
                deviceTrustBand: report.deviceTrustBand || null,
            },
            geolocation: {
                start: submission?.geolocationStart || null,
                end: submission?.geolocationEnd || null,
                trackAnalysis: submission?.gpsTrackAnalysis || null,
            },
            assets: {
                rawVideo: rawAsset ? {
                    assetId: rawAsset.id,
                    mimeType: rawAsset.mimeType,
                    sizeBytes: rawAsset.sizeBytes,
                    url: buildAssetUrl(req, rawAsset),
                } : null,
                derivedAudio: audioAsset ? {
                    assetId: audioAsset.id,
                    mimeType: audioAsset.mimeType,
                    sizeBytes: audioAsset.sizeBytes,
                    url: buildAssetUrl(req, audioAsset),
                } : null,
            },
        },
        radioContext: {
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
        },
        audioIdentification: {
            provider: 'ACRCloud',
            fingerprintSource: submission?.audioDeconstruction?.fingerprintStem
                ? 'audio_deconstruction_stem'
                : 'derived_audio',
            fingerprintStem: submission?.audioDeconstruction?.fingerprintStem || null,
            matchedSong: submission?.matchedSong || formatMatchedSong(songIdentity) || null,
            title: songIdentity?.title || report.title || null,
            artist: songIdentity?.artist || report.artist || null,
            label: songIdentity?.label || report.label || null,
            album: songIdentity?.album || null,
            releaseDate: songIdentity?.release_date || null,
            isrc: songIdentity?.external_ids?.isrc || null,
            upc: songIdentity?.external_ids?.upc || null,
            matchedTrackId: report.matchedTrackId || null,
            matchedTrackConfidence: report.matchedTrackConfidence ?? null,
        },
        audioDeconstruction: submission?.audioDeconstruction ? {
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
        } : null,
        sourceAssessment: sourceAnalysis ? {
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
        } : null,
        visualContext: visualAnalysis ? {
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
        } : null),
        locationDelta,
        applicationLayer: applicationAssessment ? {
            ...applicationAssessment,
        } : null,
        venueContext: {
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
        },
        rightsAndCaseContext: {
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
        },
        contributorContext: buildContributorPublicView(contributor, data),
        reviewTrail: {
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
        },
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

const PROTOTYPE_CASE_STAGES = ['New', 'Monitor / Enrich', 'Bad Case', 'Under Review', 'Agent Assignment', 'Ready For Legal', 'Recovery In Progress', 'Closed'];
const PROTOTYPE_STAGE_TRANSITIONS = {
    'New': ['Monitor / Enrich', 'Bad Case', 'Under Review'],
    'Monitor / Enrich': ['New', 'Under Review', 'Closed'],
    'Bad Case': ['New', 'Closed'],
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

const getPrototypeCaseRecordByIdentifier = (data, identifier) => {
    const directMatch = data.caseLedger.find((entry) => (
        entry.reference === identifier || entry.id === identifier
    )) || null;

    if (directMatch) {
        return directMatch;
    }

    const report = data.reports.find((entry) => (
        entry.reference === identifier
        || entry.id === identifier
        || `CASE-${String(entry.reference || '').replace(/^REP-?/i, '')}` === identifier
    )) || null;

    return report ? findCaseForReport(data, report.id) : null;
};

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

const buildPrototypeCaseRecords = (data) => {
    const records = [];

    for (const report of data.reports) {
        const ledgerCase = findCaseForReport(data, report.id);
        const submission = data.submissions.find((entry) => entry.id === report.submissionId) || null;
        const reference = `CASE-${String(report.reference || report.id).replace(/^REP-?/i, '')}`;

        if (ledgerCase) {
            records.push({
                ...ledgerCase,
                id: report.id === ledgerCase.primaryReportId ? ledgerCase.id : `${ledgerCase.id}:${report.id}`,
                reference: report.id === ledgerCase.primaryReportId ? ledgerCase.reference : reference,
                primaryReportId: report.id,
                primarySubmissionId: report.submissionId,
                createdAt: report.createdAt || ledgerCase.createdAt,
                updatedAt: report.updatedAt || ledgerCase.updatedAt,
                isVirtualReportCase: report.id !== ledgerCase.primaryReportId,
                sourceCaseId: ledgerCase.id,
                sourceCaseReference: ledgerCase.reference,
            });
            continue;
        }

        records.push({
            id: `virtual:${report.id}`,
            reference,
            venueId: report.venueId || null,
            rightsOwnerOrgId: report.rightsOwnerOrgId || null,
            rightsType: report.rightsType || null,
            primaryContributorId: submission?.contributorId || null,
            primaryInstallId: submission?.installId || null,
            primaryReportId: report.id,
            primarySubmissionId: report.submissionId,
            reportIds: [report.id],
            corroborationReportIds: [],
            evidenceCount: 1,
            merchantMasterId: report.merchantMasterId || null,
            licenseStatus: report.licenseAssessment?.status || 'pending',
            licenseSource: report.licenseAssessment?.source || null,
            rewardEligible: Boolean(report.rewardEligibility),
            caseStatus: 'pending_license_verification',
            planningBand: report.planningBand || null,
            estimatedRecoverableValueInr: Number(report.estimatedRecoverableValueInr || 75000),
            realizedValueInr: 0,
            settlementSignedAt: null,
            outcomeType: null,
            tariffIds: [],
            collectionProbability: 0,
            nonComplianceMultiplier: 1,
            createdAt: report.createdAt || submission?.createdAt || new Date().toISOString(),
            updatedAt: report.updatedAt || report.createdAt || submission?.updatedAt || new Date().toISOString(),
            isVirtualReportCase: true,
            sourceCaseId: null,
            sourceCaseReference: null,
        });
    }

    return records;
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

const buildPrototypeChainOfCustody = ({ reportView, caseRecord }) => {
    const capture = reportView?.evidencePackage?.captureIntegrity || {};
    const audio = reportView?.evidencePackage?.audioIdentification || {};
    const timeline = [];
    const deviceId = capture?.captureSessionId || capture?.device?.model || caseRecord?.primarySubmissionId || 'UNKNOWN-DEVICE';
    const mediaHash = capture?.mediaSha256 || 'sha256:pending';

    if (capture?.timestamps?.localStartTime || capture?.geolocation?.start?.capturedAt) {
        timeline.push({
            timestamp: capture.timestamps?.localStartTime || capture.geolocation.start.capturedAt,
            event: 'Initial Capture',
            actor: capture?.originSurface || 'Field Recorder',
            hash: mediaHash,
            deviceId,
            status: capture?.mediaSha256 ? 'Verified' : 'Pending',
        });
    }

    if (capture?.timestamps?.finalizedAt) {
        timeline.push({
            timestamp: capture.timestamps.finalizedAt,
            event: 'Payload Finalized',
            actor: capture?.signatureStatus === 'signed_and_verified' ? 'Integrity Service' : 'Finalize Service',
            hash: capture?.signatureStatus || 'unsigned_or_unverified',
            deviceId,
            status: capture?.signatureStatus === 'signed_and_verified' ? 'Verified' : 'Pending',
        });
    }

    if (capture?.timestamps?.processingCompletedAt) {
        timeline.push({
            timestamp: capture.timestamps.processingCompletedAt,
            event: 'Evidence Processing Completed',
            actor: 'Media Pipeline',
            hash: audio?.matchedTrackId ? `track:${audio.matchedTrackId}` : mediaHash,
            deviceId: 'PIPELINE',
            status: audio?.matchedTrackConfidence ? 'Verified' : 'Pending',
        });
    }

    if (!timeline.length) {
        timeline.push({
            timestamp: caseRecord?.createdAt || new Date().toISOString(),
            event: 'Case Created',
            actor: 'System',
            hash: mediaHash,
            deviceId,
            status: 'Pending',
        });
    }

    return timeline.sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
};

// Two decoupled case scores replace the old qualityScore composite:
//   evidenceValidity   - is the capture real, trustworthy, and attributable to
//                        a venue? Independent of whether the song was identified.
//   enforcementReadiness - can we actually act? Requires a valid capture AND a
//                        resolved protected track AND a confirmed venue AND
//                        venue-scale playback AND no legal block. An unknown-track
//                        capture can be high-validity / low-readiness on purpose.
const BLOCKED_VENUE_STATUSES = ['wrong_venue_or_unit', 'coordinate_only', 'blocked', 'rejected'];
const AMBIGUOUS_VENUE_STATUSES = ['adjacent_venue_ambiguous'];

const toScoreBand = (score) => (score >= 67 ? 'high' : score >= 34 ? 'moderate' : 'low');

const computeEvidenceValidity = (signals) => {
    const tg = signals.trustGates || {};
    let score = 0;

    if (tg.mediaHashKey) score += 14;
    if (tg.payloadSignature) score += 14;
    if (tg.clockSkewDetection) score += 8;
    if (tg.geofencingContinuity) score += 6;
    if (tg.deviceTrustBand) score += 4;

    if (signals.sourceSupportsVenuePlayback) {
        score += 12 + Math.round(Math.min(1, Number(signals.sourceConfidence || 0)) * 6);
    } else if (signals.sourceIsNonMusic) {
        score -= 25;
    } else if (signals.sourceClass === 'likely_personal_device' || signals.sourceClass === 'personal_device') {
        score -= 6;
    }

    if (BLOCKED_VENUE_STATUSES.includes(signals.venueStatus)) {
        score -= 30;
    } else if (AMBIGUOUS_VENUE_STATUSES.includes(signals.venueStatus)) {
        score += 4;
    } else {
        score += 14;
    }

    if (signals.withinEnvelope) score += 6;
    if (signals.selectedMatchedAligned) score += 4;
    if (signals.hasVenueCues) score += 8;

    const bounded = Math.max(0, Math.min(100, score));
    return signals.isBadCase ? Math.min(20, bounded) : bounded;
};

const computeEnforcementReadiness = (signals, validity) => {
    if (signals.isBadCase) return 0;

    let score = Math.round(validity * 0.5);
    if (signals.hasResolvedSong) score += 25;
    if (signals.sourceSupportsVenuePlayback) score += 12;
    if (!BLOCKED_VENUE_STATUSES.includes(signals.venueStatus)
        && !AMBIGUOUS_VENUE_STATUSES.includes(signals.venueStatus)) {
        score += 8;
    }
    if (signals.hasRights) score += 6;
    if (['unlicensed', 'expired'].includes(signals.licenseStatus)) score += 8;

    let bounded = Math.max(0, Math.min(100, score));

    // Hard ceilings: nothing is enforcement-ready without these, regardless of
    // how strong the rest of the evidence is.
    if (!signals.hasResolvedSong) bounded = Math.min(bounded, 25);
    if (signals.sourceIsNonMusic) bounded = Math.min(bounded, 15);
    if (BLOCKED_VENUE_STATUSES.includes(signals.venueStatus)) bounded = Math.min(bounded, 10);

    return bounded;
};

const buildCaseScores = (signals) => {
    const evidenceValidity = computeEvidenceValidity(signals);
    const enforcementReadiness = computeEnforcementReadiness(signals, evidenceValidity);
    return {
        evidenceValidity,
        evidenceValidityBand: toScoreBand(evidenceValidity),
        enforcementReadiness,
        enforcementReadinessBand: toScoreBand(enforcementReadiness),
    };
};

const deriveLiveCaseScores = ({ reportView, caseRecord }) => {
    const pkg = reportView?.evidencePackage || {};
    const capture = pkg.captureIntegrity || {};
    const audio = pkg.audioIdentification || {};
    const visual = pkg.visualContext || {};
    const rights = pkg.rightsAndCaseContext || {};
    const source = pkg.sourceAssessment || {};
    const locationDelta = pkg.locationDelta || {};
    const sourceClass = String(source?.sourceClass || '').toLowerCase();
    const hasResolvedSong = Number(audio?.matchedTrackConfidence || 0) > 0
        && Boolean(audio?.title && !/^unknown/i.test(String(audio.title)));

    return buildCaseScores({
        trustGates: {
            mediaHashKey: Boolean(capture?.mediaSha256),
            payloadSignature: capture?.signatureStatus === 'signed_and_verified',
            clockSkewDetection: capture?.clockSkewStatus === 'clear',
            geofencingContinuity: locationDelta?.withinAccuracyEnvelope !== false,
            deviceTrustBand: String(capture?.device?.deviceTrustBand || '').toLowerCase() === 'high',
        },
        sourceClass,
        sourceConfidence: Number(source?.confidence || 0),
        sourceSupportsVenuePlayback: source?.supportsVenuePlayback ?? sourceClassSupportsVenuePlayback(sourceClass),
        sourceIsNonMusic: isNonMusicSourceClass(sourceClass),
        venueStatus: String(pkg?.venueContext?.attribution?.status || '').toLowerCase(),
        withinEnvelope: locationDelta?.withinAccuracyEnvelope === true,
        selectedMatchedAligned: locationDelta?.selectedMatchedAligned === true,
        hasVenueCues: (visual?.venueIdentitySignals || []).length > 0,
        hasResolvedSong,
        hasRights: Boolean(rights?.org?.name),
        licenseStatus: String(rights?.licenseAssessment?.status || '').toLowerCase() || null,
        isBadCase: false,
    });
};

const hasResolvedPrototypeSong = (song = {}) => {
    const title = String(song?.title || '').trim().toLowerCase();
    const isrc = String(song?.isrc || '').trim().toLowerCase();
    const upc = String(song?.upc || '').trim().toLowerCase();
    const hasTitle = title && !['unknown track', 'unknown', 'unavailable', 'n/a'].includes(title);
    const hasIdentifier = [isrc, upc].some((value) => value && !['unavailable', 'unknown', 'n/a', 'none'].includes(value));
    return Boolean(hasTitle && hasIdentifier);
};

// Venue-cue scoring (VENUE_TOKEN_STOPLIST, scoreVenueCueMatch) now lives in
// ./venueFingerprints.js so the server and the backfill script share one
// implementation. scoreVenueCueMatch is imported above.

const getImportedCaseWifiSummary = (caseData) => (
    caseData?.radioContext?.wifi?.summary
    || caseData?.radioContext?.wifi?.ssid
    || caseData?.scoring?.venueIdentityScore?.factors?.find((factor) => factor?.signal === 'Radio venue hint' || factor?.signal === 'Radio context captured')?.evidence?.wifiSummary
    || ''
);

// IMPORTANT: the AI narrative fields (performanceContext, visualSource) are NOT
// independent venue-identity evidence. The vision model is handed the claimed
// venue name and echoes it back ("the interior of 'Bean Theory Coffee'"), and it
// even names the venue while *contradicting* it ("an office, negating Maratha
// Katta"). Token-matching against them is circular and was producing false
// confirmations, so they are deliberately excluded. Real visual corroboration
// needs structured signage OCR (text actually read off signs in the frames);
// until that field exists, there is no trustworthy visual signal here.
const getImportedCaseVisualSignageText = (caseData) => cleanString(
    caseData?.absoluteProof?.detectedSignageText || ''
);

// Ignore Wi-Fi placeholders that carry no venue identity ("Connected context
// captured", "Not connected during capture", etc.) so they cannot masquerade as
// a usable SSID cue.
const isUsableWifiCue = (text) => Boolean(text) && !/^connected context|^not connected|context captured/i.test(text);

// Review-only venue resolver. POLICY: never rewrite the snitcher's selected
// venue. It scores every nearby candidate against all available identity signals
// (Wi-Fi SSID, visual signage) and reports what the system *thinks* vs. what the
// user *chose*, plus a discrepancy flag for fraud review when they disagree. A
// human confirms; nothing is auto-corrected.
const buildVenueResolutionReview = (caseData, fingerprintRegistry = []) => {
    const attribution = caseData?.venueAttribution || null;
    const status = String(attribution?.status || '').toLowerCase();
    const selectedName = attribution?.targetVenue || caseData?.location?.name || '';
    const rawCandidates = attribution?.nearbyVenueCandidates
        || caseData?.locationDelta?.nearbyVenueCandidates
        || [];

    const wifiText = getImportedCaseWifiSummary(caseData);
    const usableWifi = isUsableWifiCue(wifiText) ? wifiText : '';
    const wifiBssid = caseData?.radioContext?.wifi?.bssid || null;
    const visualText = getImportedCaseVisualSignageText(caseData);
    const caseId = caseData?.id || caseData?.reference || null;

    // Candidate universe = nearby candidates plus the selected venue itself.
    const byName = new Map();
    for (const cand of rawCandidates) {
        if (cand?.name) byName.set(cand.name, cand);
    }
    if (selectedName && !byName.has(selectedName)) {
        byName.set(selectedName, { name: selectedName, isSelectedVenue: true });
    }

    const candidates = [...byName.values()].map((cand) => {
        const wifi = scoreVenueCueMatch(cand.name, usableWifi);
        const visual = scoreVenueCueMatch(cand.name, visualText);
        // Hardware fingerprint: does this BSSID's *independent* trusted history
        // point at this candidate? Self-excluded so a case can't confirm itself.
        const bssid = wifiBssid
            ? scoreBssidVenueMatch(fingerprintRegistry, wifiBssid, {
                placeProviderId: cand?.placeProviderId,
                name: cand.name,
            }, { excludeCaseId: caseId })
            : { score: 0, corroboratingCount: 0, matchedVenue: null };
        const distanceMeters = Number.isFinite(cand?.distanceMeters) ? Number(cand.distanceMeters) : null;
        const signals = [];
        if (wifi.score > 0) signals.push({ signal: 'wifi_ssid', score: wifi.score, matched: wifi.matchedTokens });
        if (visual.score > 0) signals.push({ signal: 'visual_signage', score: visual.score, matched: visual.matchedTokens });
        if (bssid.score > 0) signals.push({ signal: 'wifi_bssid', score: bssid.score, corroboratingCases: bssid.corroboratingCount });
        return {
            name: cand.name,
            isUserSelected: cand.name === selectedName,
            distanceMeters,
            support: Number((wifi.score + visual.score + bssid.score).toFixed(2)),
            signalCount: signals.length,
            signals,
        };
    }).sort((a, b) => b.support - a.support || (a.distanceMeters ?? 1e9) - (b.distanceMeters ?? 1e9));

    const selected = candidates.find((c) => c.isUserSelected) || null;
    const selectedSupport = selected?.support || 0;
    const best = candidates[0] || null;
    const anySupport = candidates.some((c) => c.support > 0);

    let recommendation = 'insufficient_evidence';
    let systemRecommendedVenue = null;
    let agreement = 'unsupported';
    let discrepancy = null;

    if (anySupport && best) {
        if (best.isUserSelected) {
            recommendation = 'confirms_selected';
            agreement = 'agrees_with_user';
            systemRecommendedVenue = best.name;
        } else if (best.support > selectedSupport && best.signalCount >= 1) {
            recommendation = 'suggests_alternate';
            agreement = 'disagrees_with_user';
            systemRecommendedVenue = best.name;
            const margin = Number((best.support - selectedSupport).toFixed(2));
            // Fraud-review severity: strongest when the user's pick has zero
            // identity support but a nearby venue has multi-signal support.
            const severity = (selectedSupport === 0 && best.signalCount >= 2) ? 'high'
                : (best.signalCount >= 2 || margin >= 2) ? 'medium'
                    : 'low';
            discrepancy = {
                flagged: true,
                severity,
                userSelectedVenue: selectedName || null,
                systemRecommendedVenue: best.name,
                supportMargin: margin,
                userSelectedSupport: selectedSupport,
                recommendedSupport: best.support,
                note: `User selected ${selectedName || 'an unnamed venue'} but identity signals support ${best.name} (${best.signals.map((s) => s.signal).join(', ')}). Review for possible mis-selection or staged capture.`,
            };
        } else if (selectedSupport > 0) {
            // An alternate leads on a tiebreak but is not clearly stronger than
            // the user's pick, which itself has support: treat as confirming.
            recommendation = 'confirms_selected';
            agreement = 'agrees_with_user';
            systemRecommendedVenue = selectedName;
        }
    }

    const lead = systemRecommendedVenue
        ? candidates.find((c) => c.name === systemRecommendedVenue)
        : null;
    // Confidence in the recommendation (not in the venue itself): grows with
    // total support and the number of agreeing signals on the leading candidate.
    const confidence = lead
        ? Number(Math.max(0.3, Math.min(0.95, 0.3 + lead.support * 0.18 + (lead.signalCount - 1) * 0.12)).toFixed(2))
        : 0;

    return {
        evaluatedAt: new Date().toISOString(),
        policy: 'recommend_only_never_autocorrect',
        userSelectedVenue: selectedName || null,
        systemRecommendedVenue,
        recommendation,
        agreement,
        confidence,
        gpsVerdict: status || null,
        signalsAvailable: {
            wifiSsid: usableWifi || null,
            wifiBssid,
            visualSignage: Boolean(visualText),
            bssidFingerprint: Boolean(wifiBssid) && Array.isArray(fingerprintRegistry) && fingerprintRegistry.length > 0,
        },
        limitations: [
            'Venue identity is scored from the connected Wi-Fi SSID and the BSSID hardware fingerprint history.',
            'AI visual narrative is excluded as circular (it echoes the claimed venue name); independent signage OCR is not yet captured.',
            'BSSID corroboration requires at least one independent prior trusted case; a first-seen access point contributes no fingerprint signal until the registry is built.',
        ],
        candidates,
        discrepancy,
    };
};

const getImportedBadCaseReasons = (caseData) => {
    const reasons = [];
    const venueStatus = String(caseData?.venueAttribution?.status || '').toLowerCase();
    const venueName = String(caseData?.location?.name || '');
    const sourceAssessment = caseData?.sourceAssessment || null;
    const sourceClass = String(sourceAssessment?.sourceClass || '').toLowerCase();
    const sourceSignals = sourceAssessment?.signals || {};
    const silenceRatio = Number(sourceSignals.silenceRatio || 0);
    const overallRms = Number(sourceSignals.overallRms || 0);

    if (venueStatus === 'coordinate_only' || /^Approx\. Venue/i.test(venueName)) {
        reasons.push('coordinate_only_venue');
    }

    // Source determination is driven by the structured classifier first. The
    // narrative aiExplanation is only consulted when no structured source class
    // is available, so a text description of "music in a reverberant room" can
    // no longer override a classifier that says there is no music.
    if (sourceClass === 'no_music' || silenceRatio >= 0.9 || overallRms <= 0.0001) {
        reasons.push('silent_or_no_music_audio');
    }
    if (sourceClass === 'speech_ambience') {
        reasons.push('speech_or_ambience_no_music');
    }
    if (sourceClass === 'tv_screen') {
        reasons.push('tv_or_screen_media_source');
    }

    if (!sourceClass) {
        const visualText = cleanString([
            caseData?.absoluteProof?.performanceContext,
            caseData?.absoluteProof?.obstructionFlags,
            caseData?.aiExplanation,
        ].filter(Boolean).join(' '));
        if (visualText.includes('residential') || visualText.includes('living room') || visualText.includes('home')) {
            reasons.push('private_or_home_visual_context');
        }
        if (visualText.includes('checkerboard') || visualText.includes('television displaying')) {
            reasons.push('screen_or_test_pattern_visual');
        }
        if (visualText.includes('no audio') || visualText.includes('completely silent')) {
            reasons.push('silent_or_no_music_audio');
        }
    }

    return [...new Set(reasons)];
};

const deriveImportedCaseScores = (caseData, { hasResolvedSong, isBadCase, venueStatus }) => {
    const source = caseData?.sourceAssessment || {};
    const sourceClass = String(source?.sourceClass || '').toLowerCase();
    const trustGates = caseData?.trustGates || {};
    const locationDelta = caseData?.locationDelta || {};
    const frames = Array.isArray(caseData?.absoluteProof?.venueImages) ? caseData.absoluteProof.venueImages : [];
    const rightsAssociation = String(caseData?.songAssessment?.rightsAssociation || '');

    return buildCaseScores({
        trustGates: {
            mediaHashKey: Boolean(trustGates.mediaHashKey),
            payloadSignature: Boolean(trustGates.payloadSignature),
            clockSkewDetection: Boolean(trustGates.clockSkewDetection),
            geofencingContinuity: Boolean(trustGates.geofencingContinuity),
            deviceTrustBand: Boolean(trustGates.deviceTrustBand),
        },
        sourceClass,
        sourceConfidence: Number(source?.confidence || 0),
        sourceSupportsVenuePlayback: source?.supportsVenuePlayback ?? sourceClassSupportsVenuePlayback(sourceClass),
        sourceIsNonMusic: isNonMusicSourceClass(sourceClass),
        venueStatus: String(venueStatus || caseData?.venueAttribution?.status || '').toLowerCase(),
        withinEnvelope: locationDelta?.withinAccuracyEnvelope === true,
        selectedMatchedAligned: locationDelta?.selectedMatchedAligned === true,
        hasVenueCues: frames.length > 0,
        hasResolvedSong,
        hasRights: Boolean(rightsAssociation) && !/pending/i.test(rightsAssociation),
        licenseStatus: String(caseData?.licenseResolution?.status || '').toLowerCase() || null,
        isBadCase,
    });
};

const buildSignalSummary = (sourceAssessment) => {
    if (!sourceAssessment) {
        return null;
    }
    const sourceClass = sourceAssessment.sourceClass || null;
    return {
        sourceClass,
        operationalLabel: sourceAssessment.operationalLabel || toOperationalSourceLabel(sourceClass),
        supportsVenuePlayback: sourceAssessment.supportsVenuePlayback ?? sourceClassSupportsVenuePlayback(sourceClass),
        sourceScore: sourceAssessment.score ?? null,
        sourceConfidence: sourceAssessment.confidence ?? null,
        classifierMode: sourceAssessment.classifierMode || sourceAssessment.requestedMode || null,
    };
};

const normalizeImportedPrototypeCase = (caseData, fingerprintRegistry = []) => {
    // Drop the legacy score-sprawl fields so they cannot leak through the spread.
    // recoverableValue/expectedFine valuation is intentionally back-burnered (TBD)
    // until a real monetary model exists; we keep a single provisional value.
    const {
        qualityScore: _qualityScore,
        qualityScore10: _qualityScore10,
        scoreScale: _scoreScale,
        songEnforcementConfidence: _songEnforcementConfidence,
        venueSourceConfidence: _venueSourceConfidence,
        expectedFine: _expectedFine,
        readiness: _readiness,
        readiness_score: _readinessScore,
        readiness_band: _readinessBand,
        readiness_reasons: _readinessReasons,
        next_actions: _nextActions,
        prosecution_strength_score: _prosecutionScore,
        prosecution_strength_label: _prosecutionLabel,
        prosecution_strength_reasons: _prosecutionReasons,
        ...rest
    } = caseData;

    const sourceAssessment = caseData?.sourceAssessment || null;
    const hasResolvedSong = hasResolvedPrototypeSong(caseData?.songAssessment || {});
    const badCaseReasons = getImportedBadCaseReasons(caseData);
    const isBadCase = badCaseReasons.length >= 2;
    const stage = isBadCase ? 'Bad Case' : hasResolvedSong ? (caseData?.stage || 'New') : 'Monitor / Enrich';

    // Venue resolution is review-only: we never rewrite the snitcher's selected
    // venue or its GPS verdict. We attach what the system's identity signals
    // point to (and flag a mismatch for fraud review) and leave the original
    // selection intact for a human to confirm.
    const venueResolutionReview = buildVenueResolutionReview(caseData, fingerprintRegistry);

    const scores = deriveImportedCaseScores(caseData, {
        hasResolvedSong,
        isBadCase,
        venueStatus: caseData?.venueAttribution?.status,
    });

    return {
        ...rest,
        id: caseData?.id || caseData?.reference,
        venueResolutionReview,
        stage,
        isNew: stage === 'New',
        ...scores,
        recoverableValue: Number(caseData?.recoverableValue || 0),
        valuationStatus: 'tbd',
        badCaseReasons,
        enforcementBlockReason: isBadCase
            ? `Bad case: ${badCaseReasons.join(', ')}. Extract signals only; do not enrich for enforcement.`
            : hasResolvedSong ? null : 'Track identity is unresolved; keep monitoring/enriching before enforcement.',
        scoreRecomputedAt: caseData?.scoreRecomputedAt || new Date().toISOString(),
        signalSummary: buildSignalSummary(sourceAssessment),
    };
};

// Build the BSSID fingerprint registry from APPROVED venue identifiers only.
// This is what enforces the admin gate at resolution time: a proposed (not yet
// approved) identifier never influences venue resolution. Output shape matches
// what scoreBssidVenueMatch/lookupVenueByBssid expect (normalized bssid +
// venueKey + corroborating caseIds).
const buildFingerprintRegistryFromIdentifiers = (venueIdentifiers, venues) => {
    const venueById = new Map((venues || []).map((v) => [v.id, v]));
    const registry = [];
    for (const vid of venueIdentifiers || []) {
        if (vid.type !== 'wifi_bssid' || vid.status !== 'approved') continue;
        const venue = venueById.get(vid.venueId);
        if (!venue) continue;
        const normBssid = normalizeBssid(vid.normalizedValue || vid.value);
        if (!normBssid) continue;
        registry.push({
            bssid: normBssid,
            venueKey: canonicalVenueKey({ placeProviderId: venue.placeProviderId, name: venue.name }),
            placeProviderId: venue.placeProviderId || null,
            venueName: venue.name || null,
            caseIds: Array.isArray(vid.corroboratingCaseIds) ? vid.corroboratingCaseIds : [],
        });
    }
    return registry;
};

// Render a canonical case (cases + its primary evidenceSubmission) into the
// authority/CRM view. POLICY (workflow vs. diagnostics split):
//   - Derived diagnostics (scores, badCaseReasons, venueResolutionReview,
//     signalSummary) are recomputed on read from the preserved capture data.
//   - Workflow state (stage, statusFlags) is NOT recomputed: cases.stage is
//     authoritative and is passed through (mapped enum -> CRM label). We reuse
//     normalizeImportedPrototypeCase for the diagnostics + passthrough, then
//     overwrite the workflow fields with the canonical values.
const normalizeCanonicalCase = (caseRec, data, fingerprintRegistry) => {
    const primary = (data.evidenceSubmissions || []).find((s) => s.id === caseRec.primarySubmissionId);
    const legacyShape = primary?.raw?.legacyCase;
    if (!legacyShape) return null;

    const view = normalizeImportedPrototypeCase(legacyShape, fingerprintRegistry);

    // Canonical authority overrides (workflow state + cluster identity).
    view.id = caseRec.id;
    view.stage = stageToLabel(caseRec.stage);
    view.canonicalStage = caseRec.stage;
    view.isNew = caseRec.stage === 'new';
    view.statusFlags = Array.isArray(caseRec.statusFlags) ? caseRec.statusFlags : [];
    view.evidenceCount = caseRec.evidenceCount;
    view.submissionIds = caseRec.submissionIds;
    view.companyId = caseRec.companyId || null;
    view.resolvedVenueId = caseRec.resolvedVenueId || null;
    view.recoverableValue = Number(caseRec.recoverableValue || 0);
    view.timestamp = caseRec.openedAt || view.timestamp;
    return view;
};

const buildAuthorityPrototypeCases = (req, data) => {
    // Canonical path (preferred): serve from the new cases + evidenceSubmissions
    // collections once they are populated.
    if (Array.isArray(data.cases) && data.cases.length) {
        const fingerprintRegistry = buildFingerprintRegistryFromIdentifiers(data.venueIdentifiers, data.venues);
        return data.cases
            .map((caseRec) => normalizeCanonicalCase(caseRec, data, fingerprintRegistry))
            .filter(Boolean)
            .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));
    }

    // Legacy fallback: imported prototypeCases blob (pre-migration).
    if (Array.isArray(data.prototypeCases) && data.prototypeCases.length) {
        return data.prototypeCases
            .map((caseData) => normalizeImportedPrototypeCase(caseData, data.venueFingerprints))
            .filter(Boolean)
            .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));
    }

    const byId = new Map();

    for (const caseRecord of buildPrototypeCaseRecords(data)) {
        const caseView = buildPrototypeCaseView(req, data, caseRecord);
        if (caseView?.id) {
            byId.set(caseView.id, caseView);
        }
    }

    for (const importedCase of data.prototypeCases || []) {
        const caseView = normalizeImportedPrototypeCase(importedCase, data.venueFingerprints);
        if (caseView?.id) {
            byId.set(caseView.id, caseView);
        }
    }

    return [...byId.values()]
        .filter(Boolean)
        .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));
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
    const visual = evidencePackage?.visualContext || {};
    const sourceAssessment = evidencePackage?.sourceAssessment || null;
    const venueContext = evidencePackage?.venueContext || {};
    const matchedVenue = venueContext?.matchedVenue || reportView?.venue || null;
    const selectedVenue = venueContext?.selectedVenue || reportView?.submission?.selectedVenue || null;
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
    const caseScores = deriveLiveCaseScores({ reportView, caseRecord });
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

    return {
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
        recoverableValue,
        valuationStatus: 'tbd',
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
        audioDeconstruction,
        sourceAssessment,
        signalSummary: buildSignalSummary(sourceAssessment),
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
        ...caseScores,
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
        session_nonce: session.sessionNonce,
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
        audio_level_envelope: pickFirstDefined(body.audio_level_envelope, body.audioLevelEnvelope),
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
            audioLevelEnvelope: Array.isArray(payload.audio_level_envelope)
                ? payload.audio_level_envelope
                    .filter((n) => typeof n === 'number' && Number.isFinite(n))
                    .slice(0, 256)
                : null,
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
    const signature = req.body?.signature || null;
    const signedPayload = pickFirstDefined(req.body?.signed_payload, req.body?.signedPayload) || null;

    const result = await mutatePlatformData(async (data) => {
        const submission = data.submissions.find((item) => item.id === submissionId && item.mobileUserId === req.mobileUser.id);
        if (!submission) {
            throw new Error('Submission not found');
        }
        if (!submission.rawVideoAssetId) {
            throw new Error('Raw video must be uploaded before finalize');
        }

        // Verify device-key provenance when the client supplied a signature. A
        // signature that is present but invalid is a hard rejection; absence
        // degrades to an unsigned (untrusted) submission so the flow still works
        // for installs that predate key enrollment.
        let hasValidSignature = false;
        // Only attempt verification when the client signed AND the device key is
        // enrolled. An un-enrolled install (e.g. predates key enrollment) degrades
        // to unsigned rather than failing — but once a key exists, a bad signature
        // or nonce is a hard rejection.
        if (signature && signedPayload) {
            const install = data.anonymousInstalls.find((item) => item.installId === submission.installId && item.mobileUserId === req.mobileUser.id);
            const session = data.captureSessions.find((item) => item.id === submission.captureSessionId && item.mobileUserId === req.mobileUser.id);

            if (install?.publicKey) {
                // Replay protection: the signed nonce must match the one the
                // server issued for this capture session.
                if (!session?.sessionNonce || signedPayload.sessionNonce !== session.sessionNonce) {
                    throw new Error('Capture session nonce mismatch');
                }
                // Bind the signature to this submission's identity and committed hash.
                if (signedPayload.sessionId !== submission.captureSessionId || signedPayload.installId !== submission.installId) {
                    throw new Error('Signed payload does not match submission');
                }
                const committedHash = media_hash || submission.mediaSha256 || null;
                if (signedPayload.mediaSha256 !== committedHash) {
                    throw new Error('Signed media hash does not match finalize hash');
                }

                const valid = await verifyInstallSignature({
                    publicKey: install.publicKey,
                    payload: buildMobileSignedFinalizePayload(signedPayload),
                    signature,
                });
                if (!valid) {
                    throw new Error('Invalid finalize signature');
                }
                hasValidSignature = true;
            }
        }

        submission.mediaSha256 = media_hash || submission.mediaSha256 || null;
        submission.hasValidSignature = hasValidSignature;
        submission.signatureVerifiedAt = hasValidSignature ? new Date().toISOString() : null;
        submission.status = 'processing';
        submission.finalizedAt = new Date().toISOString();
        submission.processingStartedAt = new Date().toISOString();
        submission.processingError = null;
        return submission;
    }).catch((error) => ({ error }));

    if (result.error) {
        const message = result.error.message || 'Finalize failed';
        const status = /not found/i.test(message) ? 404 : 400;
        return res.status(status).json({ error: message });
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// Production-shaped v2 capture path (writes data.production.* via productionStore).
// LOSSLESS: keeps every signal the legacy path drops — device_context, GPS
// altitude/speed/heading, wifi.networks[], BLE enrichment, audio envelope. This
// path does not run analysis yet (status terminates at 'stored').
// ─────────────────────────────────────────────────────────────────────────────

const numOrNull = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

const buildGeoRaw = ({ lat, lng, accuracy, altitude, speed, heading, capturedAt }) => {
    if (numOrNull(lat) == null || numOrNull(lng) == null) {
        return null;
    }
    return {
        lat: numOrNull(lat),
        lng: numOrNull(lng),
        accuracy: numOrNull(accuracy),
        altitude: numOrNull(altitude),
        speed: numOrNull(speed),
        heading: numOrNull(heading),
        captured_at: capturedAt || null,
    };
};

const geoPoint = (raw) => (raw ? { lat: raw.lat, lng: raw.lng } : null);

// Preserve the FULL radio bundle — wifi.networks[] and the BLE enrichment fields
// (displayName/inferredType/manufacturerId/manufacturerName) that the legacy
// normalizeRadioEntry strips. Light array caps guard payload size.
const extractRadioContextLossless = (value) => {
    const raw = parseMaybeJson(value);
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const cap = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);
    const snapshot = (snap) => {
        if (!snap || typeof snap !== 'object') {
            return null;
        }
        const wifi = snap.wifi && typeof snap.wifi === 'object'
            ? { ...snap.wifi, networks: cap(snap.wifi.networks, 40) }
            : null;
        const bluetooth = snap.bluetooth && typeof snap.bluetooth === 'object'
            ? { ...snap.bluetooth, devices: cap(snap.bluetooth.devices, 40) }
            : null;
        return { ...snap, wifi, bluetooth };
    };
    return {
        collectionVersion: typeof raw.collectionVersion === 'string' ? raw.collectionVersion : 'radio-evidence-v1',
        start: snapshot(raw.start),
        end: snapshot(raw.end),
        limitations: Array.isArray(raw.limitations) ? raw.limitations.filter((item) => typeof item === 'string') : [],
    };
};

const extractDeviceSnapshot = (value) => {
    const raw = parseMaybeJson(value);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
};

const cleanEnvelope = (value) => {
    const raw = parseMaybeJson(value);
    if (!Array.isArray(raw)) {
        return null;
    }
    const nums = raw.filter((n) => typeof n === 'number' && Number.isFinite(n)).slice(0, 256);
    return nums.length ? nums : null;
};

app.post('/api/mobile/v2/capture/submissions', requireMobileAuth, async (req, res) => {
    const body = req.body || {};
    const p = (snake, camel) => pickFirstDefined(body[snake], body[camel]);
    const sessionId = p('session_id', 'sessionId');
    const installId = p('install_id', 'installId');

    const data = await readPlatformData();
    const legacySession = data.captureSessions.find((s) => s.id === sessionId && s.mobileUserId === req.mobileUser.id);
    const legacyInstall = data.anonymousInstalls.find((i) => i.installId === installId && i.mobileUserId === req.mobileUser.id);
    if (!legacySession || !legacyInstall) {
        return res.status(404).json({ error: 'Submission context is invalid' });
    }

    const createdAt = new Date().toISOString();
    const startRaw = buildGeoRaw({
        lat: p('start_lat', 'startLat'), lng: p('start_lng', 'startLng'), accuracy: p('start_accuracy', 'startAccuracy'),
        altitude: p('start_altitude', 'startAltitude'), speed: p('start_speed', 'startSpeed'), heading: p('start_heading', 'startHeading'),
        capturedAt: p('local_start_time', 'localStartTime') || createdAt,
    });
    const endRaw = buildGeoRaw({
        lat: p('end_lat', 'endLat'), lng: p('end_lng', 'endLng'), accuracy: p('end_accuracy', 'endAccuracy'),
        altitude: p('end_altitude', 'endAltitude'), speed: p('end_speed', 'endSpeed'), heading: p('end_heading', 'endHeading'),
        capturedAt: p('local_end_time', 'localEndTime') || createdAt,
    });

    const selectedVenueName = p('selected_venue_name', 'selectedVenueName');
    const selectedVenueContext = selectedVenueName ? {
        place_provider_id: p('selected_venue_place_provider_id', 'selectedVenuePlaceProviderId') || null,
        place_provider: normalizeVenueProvider(p('selected_venue_provider', 'selectedVenueProvider')) || null,
        name: selectedVenueName,
        address: p('selected_venue_address', 'selectedVenueAddress') || '',
        city: p('selected_venue_city', 'selectedVenueCity') || null,
        latitude: numOrNull(p('selected_venue_latitude', 'selectedVenueLatitude')),
        longitude: numOrNull(p('selected_venue_longitude', 'selectedVenueLongitude')),
    } : null;

    const deviceSnapshot = extractDeviceSnapshot(p('device_context', 'deviceContext'));
    const radioContext = extractRadioContextLossless(p('radio_evidence', 'radioEvidence'));
    const audioEnvelope = cleanEnvelope(p('audio_level_envelope', 'audioLevelEnvelope'));

    const submission = await mutatePlatformData((draft) => {
        const legacyUser = draft.mobileUsers.find((u) => u.id === req.mobileUser.id) || req.mobileUser;
        const draftInstall = draft.anonymousInstalls.find((i) => i.installId === installId) || legacyInstall;
        const draftSession = draft.captureSessions.find((s) => s.id === sessionId) || legacySession;

        mirrorMobileUser(draft, legacyUser);
        mirrorDeviceInstall(draft, draftInstall);

        prodUpsertCaptureSession(draft, {
            id: sessionId,
            install_id: installId,
            session_nonce: draftSession.sessionNonce || null,
            issued_server_time: draftSession.issuedServerTime || null,
            start_server_time: draftSession.startServerTime || null,
            local_start_time: p('local_start_time', 'localStartTime') || null,
            measured_start_offset_ms: numOrNull(p('server_offset_start_ms', 'serverOffsetStartMs')),
            measured_end_offset_ms: numOrNull(p('server_offset_end_ms', 'serverOffsetEndMs')),
            geolocation_start: geoPoint(startRaw),
            geolocation_end: geoPoint(endRaw),
            geolocation_start_raw: startRaw,
            geolocation_end_raw: endRaw,
            device_snapshot: deviceSnapshot,
            status: 'stored',
        });

        let venueRow = null;
        if (selectedVenueContext) {
            const fallbackKey = stableHash(`${(selectedVenueContext.name || '').toLowerCase()}:${(selectedVenueContext.address || '').toLowerCase()}`).slice(0, 12);
            venueRow = prodUpsertVenue(draft, {
                place_provider: selectedVenueContext.place_provider,
                place_provider_id: selectedVenueContext.place_provider_id,
                fallback_key: fallbackKey,
                name: selectedVenueContext.name,
                address: selectedVenueContext.address,
                city: selectedVenueContext.city,
                location: selectedVenueContext.latitude != null && selectedVenueContext.longitude != null
                    ? { lat: selectedVenueContext.latitude, lng: selectedVenueContext.longitude }
                    : geoPoint(endRaw || startRaw),
            });
        }

        return prodInsertSubmission(draft, {
            reference: createReference('SC'),
            capture_session_id: sessionId,
            install_id: installId,
            mobile_user_id: req.mobileUser.id,
            media_sha256: p('media_hash', 'mediaHash') || null,
            duration_seconds: numOrNull(p('duration_seconds', 'durationSeconds')) ?? 0,
            mime_type: p('mime_type', 'mimeType') || 'video/mp4',
            file_name: p('file_name', 'fileName') || `${createReference('CAPTURE')}.mp4`,
            file_size: numOrNull(p('file_size', 'fileSize')) ?? 0,
            status: 'received',
            upload_token_hash: stableHash(crypto.randomBytes(16).toString('hex')),
            geolocation_start: geoPoint(startRaw),
            geolocation_end: geoPoint(endRaw),
            geolocation_start_raw: startRaw,
            geolocation_end_raw: endRaw,
            radio_context: radioContext,
            selected_venue_context: venueRow ? { ...selectedVenueContext, venue_id: venueRow.id } : selectedVenueContext,
            capture_context: {
                note: body.note || null,
                business_name: p('business_name', 'businessName') || null,
                gstin: body.gstin || null,
                source_classifier_mode: normalizeSourceClassifierMode(p('source_classifier_mode', 'sourceClassifierMode'), DEFAULT_SOURCE_CLASSIFIER_MODE),
                // Snitcher's structured declaration — a CLAIM, attributed to this
                // contributor. Quarantined under `declared`; routing reads only the
                // derived report.context_reconciliation, never this block directly.
                declared: normalizeDeclaredContext(p('declared_context', 'declaredContext')),
            },
            audio_level_envelope: audioEnvelope,
            created_at: createdAt,
        });
    });

    res.json({
        submission_id: submission.id,
        reference_id: submission.reference,
        status: submission.status,
        created_at: submission.created_at,
    });
});

app.post('/api/mobile/v2/capture/submissions/:id/upload', requireMobileAuth, upload.single('video'), async (req, res) => {
    const submissionId = req.params.id;
    if (!req.file) {
        return res.status(400).json({ error: 'Video file is required' });
    }
    if (req.file.size > CAPTURE_POLICY.maxUploadBytes) {
        return res.status(400).json({ error: `Video exceeds ${CAPTURE_POLICY.maxUploadBytes} byte upload limit` });
    }

    const data = await readPlatformData();
    const submission = prodFindSubmission(data, submissionId, req.mobileUser.id);
    if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
    }

    const acceptedMimeType = resolveAcceptedCaptureMimeType({
        requestedMimeType: req.file.mimetype,
        fallbackMimeType: submission.mime_type,
        fileName: req.file.originalname || submission.file_name,
    });
    if (!acceptedMimeType) {
        return res.status(400).json({ error: `Unsupported video type: ${req.file.mimetype}` });
    }

    const asset = await saveAsset({
        buffer: req.file.buffer,
        fileName: req.file.originalname || submission.file_name || `${submission.reference}.mp4`,
        mimeType: acceptedMimeType,
        kind: 'raw-video',
        metadata: { submissionId, source: 'snitchv1_v2_capture' },
    });

    const result = await mutatePlatformData((draft) => {
        const row = prodFindSubmission(draft, submissionId, req.mobileUser.id);
        if (!row) {
            throw new Error('Submission not found');
        }
        const assetRow = prodInsertAsset(draft, {
            kind: 'raw-video',
            storage_provider: 'local',
            bucket: null,
            object_key: asset.relativePath,
            file_name: asset.fileName,
            mime_type: acceptedMimeType,
            size_bytes: asset.sizeBytes,
            sha256: row.media_sha256 || null,
            metadata: { submission_id: submissionId },
        });
        row.raw_video_asset_id = assetRow.id;
        row.mime_type = acceptedMimeType;
        row.file_name = asset.fileName;
        row.file_size = asset.sizeBytes;
        row.status = 'uploaded';
        row.updated_at = new Date().toISOString();
        return { submission: row, asset: assetRow };
    }).catch((error) => ({ error }));

    if (result.error) {
        return res.status(404).json({ error: result.error.message });
    }

    res.json({
        status: 'uploaded',
        submission_id: submissionId,
        asset_id: result.asset.id,
        asset_url: buildAssetUrl(req, { relativePath: result.asset.object_key }),
    });
});

app.post('/api/mobile/v2/capture/submissions/:id/finalize', requireMobileAuth, async (req, res) => {
    const submissionId = req.params.id;
    const media_hash = pickFirstDefined(req.body?.media_hash, req.body?.mediaHash);
    const signature = req.body?.signature || null;
    const signedPayload = pickFirstDefined(req.body?.signed_payload, req.body?.signedPayload) || null;

    const result = await mutatePlatformData(async (draft) => {
        const submission = prodFindSubmission(draft, submissionId, req.mobileUser.id);
        if (!submission) {
            throw new Error('Submission not found');
        }
        if (!submission.raw_video_asset_id) {
            throw new Error('Raw video must be uploaded before finalize');
        }

        // Same provenance contract as the legacy mobile finalize: an enrolled
        // key + present signature must verify (and the nonce must match the
        // issued session); an un-enrolled install degrades to unsigned.
        let hasValidSignature = false;
        if (signature && signedPayload) {
            const install = prodFindDeviceInstall(draft, submission.install_id);
            const session = prodFindCaptureSession(draft, submission.capture_session_id);
            if (install?.public_key) {
                if (!session?.session_nonce || signedPayload.sessionNonce !== session.session_nonce) {
                    throw new Error('Capture session nonce mismatch');
                }
                if (signedPayload.sessionId !== submission.capture_session_id || signedPayload.installId !== submission.install_id) {
                    throw new Error('Signed payload does not match submission');
                }
                const committedHash = media_hash || submission.media_sha256 || null;
                if (signedPayload.mediaSha256 !== committedHash) {
                    throw new Error('Signed media hash does not match finalize hash');
                }
                const valid = await verifyInstallSignature({
                    publicKey: install.public_key,
                    payload: buildMobileSignedFinalizePayload(signedPayload),
                    signature,
                });
                if (!valid) {
                    throw new Error('Invalid finalize signature');
                }
                hasValidSignature = true;
            }
        }

        submission.media_sha256 = media_hash || submission.media_sha256 || null;
        submission.has_valid_signature = hasValidSignature;
        submission.signature_status = hasValidSignature ? 'signed_and_verified' : 'unsigned_or_unverified';
        submission.payload_signature = hasValidSignature;
        submission.signature_verified_at = hasValidSignature ? new Date().toISOString() : null;
        submission.status = 'stored';
        submission.updated_at = new Date().toISOString();
        return submission;
    }).catch((error) => ({ error }));

    if (result.error) {
        const message = result.error.message || 'Finalize failed';
        const status = /not found/i.test(message) ? 404 : 400;
        return res.status(status).json({ error: message });
    }

    // Phase 1 only: a single quick ACRCloud pass so the snitcher gets the track +
    // ownership fast. The heavy pass (Demucs/source/visual/reconciliation) is
    // deferred to Phase 2, triggered later/manually.
    queueQuickIdentify(result.id);

    res.json({
        submission_id: result.id,
        reference_id: result.reference,
        status: result.status,
        has_valid_signature: result.has_valid_signature,
    });
});

app.get('/api/mobile/v2/capture/submissions/:id/status', requireMobileAuth, async (req, res) => {
    const data = await readPlatformData();
    const submission = prodFindSubmission(data, req.params.id, req.mobileUser.id);
    if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
    }

    // Surface the quick-ID result so the snitcher sees the track + ownership.
    const report = (submission.report_ids || [])
        .map((rid) => data.production?.reports?.find((r) => r.id === rid))
        .find(Boolean) || null;
    const recognized = submission.status === 'identified'
        || (submission.status === 'ready' && report?.title && report.title !== 'Unknown Track');
    const song = recognized && report ? {
        title: report.title,
        artist: report.artist,
        label: report.label,
        rights_org: report.rights_org,
        match_score: report.matched_track_confidence,
    } : null;

    res.set('Cache-Control', 'no-store');
    res.json({
        submission_id: submission.id,
        reference_id: submission.reference,
        status: submission.status,
        has_valid_signature: submission.has_valid_signature,
        created_at: submission.created_at,
        recognized: Boolean(song),
        song,
        processing_stage: report?.processing_stage || null,
    });
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

    res.json({
        cases: buildAuthorityPrototypeCases(req, data),
        generatedAt: new Date().toISOString(),
    });
});

app.post('/api/authority-prototype/cases/:id/stage', async (req, res) => {
    const nextStage = req.body?.stage;
    const actorRole = String(req.body?.actorRole || 'Admin').trim() || 'Admin';
    const details = String(req.body?.note || '').trim();

    if (!isPrototypeCaseStage(nextStage)) {
        return res.status(400).json({ error: 'Invalid prototype case stage' });
    }

    const result = await mutatePlatformData((data) => {
        // Canonical path: stage lives on cases.stage (enum). The frontend speaks
        // CRM labels; we validate the transition in label space (existing graph)
        // then persist the enum + append a caseEvent. This is the authoritative
        // write once cases are populated -- no split-brain with the read path.
        const canonicalCase = (data.cases || []).find((entry) => entry.id === req.params.id || entry.reference === req.params.id);
        if (canonicalCase) {
            const currentLabel = stageToLabel(canonicalCase.stage);
            if (currentLabel !== nextStage && !PROTOTYPE_STAGE_TRANSITIONS[currentLabel]?.includes(nextStage)) {
                throw new Error(`Invalid stage transition: ${currentLabel} -> ${nextStage}`);
            }
            if (currentLabel !== nextStage) {
                const now = new Date().toISOString();
                const fromStage = canonicalCase.stage;
                canonicalCase.stage = labelToStage(nextStage);
                canonicalCase.updatedAt = now;
                if (details) canonicalCase.notes = details;
                if (!Array.isArray(data.caseEvents)) data.caseEvents = [];
                data.caseEvents.push(makeCaseEvent({
                    caseId: canonicalCase.id,
                    eventType: CASE_EVENT_TYPE.STAGE_CHANGE,
                    fromStage,
                    toStage: canonicalCase.stage,
                    actorType: ACTOR_TYPE.STAFF,
                    actorId: actorRole,
                    payload: { note: details || null, fromLabel: currentLabel, toLabel: nextStage },
                }));
            }
            return { canonical: true, id: canonicalCase.id };
        }

        const importedCase = (data.prototypeCases || []).find((entry) => entry.id === req.params.id);
        if (importedCase) {
            const currentStage = importedCase.stage || 'New';
            if (currentStage !== nextStage && !PROTOTYPE_STAGE_TRANSITIONS[currentStage]?.includes(nextStage)) {
                throw new Error(`Invalid stage transition: ${currentStage} -> ${nextStage}`);
            }

            const now = new Date().toISOString();
            const auditTrail = Array.isArray(importedCase.auditTrail) ? importedCase.auditTrail : [];
            if (!auditTrail.length) {
                auditTrail.push({
                    id: `AUD-INIT-${importedCase.id}`,
                    timestamp: importedCase.timestamp || importedCase.createdAt || now,
                    action: 'Case Created',
                    actor: 'System',
                    newStage: currentStage,
                    details: 'Imported from the latest prototype case export.',
                });
            }

            if (currentStage !== nextStage) {
                importedCase.stage = nextStage;
                importedCase.isNew = nextStage === 'New';
                importedCase.updatedAt = now;
                if (details) {
                    importedCase.notes = details;
                }
                auditTrail.push({
                    id: crypto.randomUUID(),
                    timestamp: now,
                    action: 'Stage Updated',
                    actor: actorRole,
                    previousStage: currentStage,
                    newStage: nextStage,
                    details: details || 'No additional notes provided.',
                });
            }
            importedCase.auditTrail = auditTrail;
            return { imported: true, id: importedCase.id };
        }

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
    const updatedCase = buildAuthorityPrototypeCases(req, data).find((entry) => entry.id === req.params.id) || null;
    res.json({
        ok: true,
        case: updatedCase,
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

// Phase 2 trigger: run the deferred advanced pass (Demucs + full forensic
// analysis) on a v2 submission. Enriches the existing Phase 1 quick-ID report in
// place — does NOT delete it, so the song stays even if the heavy pass re-IDs.
// Safe to re-run (re-enriches). Demucs backend is chosen by DEMUCS_BACKEND.
app.post('/api/admin/v2/submissions/:id/process-advanced', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
        const submissionId = req.params.id;
        const data = await readPlatformData();
        const sub = prodFindSubmission(data, submissionId);
        if (!sub) throw new Error(`Production submission not found: ${submissionId}`);
        queueAdvancedProcessing(submissionId);
        res.json({ queued: true, submission_id: submissionId, demucs_backend: process.env.DEMUCS_BACKEND || 'local' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Batch Phase 2: trigger advanced processing for every submission still awaiting
// it (status 'identified' or 'needs_advanced'). Optional ?status= filter.
app.post('/api/admin/v2/process-advanced/batch', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
        const data = await readPlatformData();
        const wanted = req.query.status
            ? new Set(String(req.query.status).split(','))
            : new Set(['identified', 'needs_advanced']);
        const pending = (data.production?.submissions || []).filter((s) => wanted.has(s.status));
        pending.forEach((s) => queueAdvancedProcessing(s.id));
        res.json({ queued: pending.length, references: pending.map((s) => s.reference), demucs_backend: process.env.DEMUCS_BACKEND || 'local' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Back-compat alias: /reprocess now means "run advanced processing in place".
app.post('/api/admin/v2/submissions/:id/reprocess', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
        const submissionId = req.params.id;
        const data = await readPlatformData();
        if (!prodFindSubmission(data, submissionId)) throw new Error(`Production submission not found: ${submissionId}`);
        queueAdvancedProcessing(submissionId);
        res.json({ queued: true, submission_id: submissionId });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
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

app.get('/api/admin/client-activity', requireAuth, requirePlatformAdmin, (req, res) => {
    const clients = Array.from(connectedClients.values())
        .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
        .map((client) => ({
            ...client,
            routes: Object.entries(client.routes || {})
                .sort((a, b) => b[1] - a[1])
                .reduce((summary, [routeFamily, count]) => {
                    summary[routeFamily] = count;
                    return summary;
                }, {}),
        }));

    res.json({
        generatedAt: new Date().toISOString(),
        loggingEnabled: clientActivityLoggingEnabled,
        logFile: clientActivityLoggingEnabled ? clientActivityLogFile : null,
        clientCount: clients.length,
        clients,
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
