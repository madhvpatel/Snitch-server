// Repository seam for the production-shaped capture store (data.production.*).
//
// This is the ONLY module that knows the production tables are backed by the
// JSON document store. When we move to Neon/Postgres, these functions become
// `pg` queries and nothing else in the routes changes shape. For now the write
// functions operate on the in-memory `data` draft so a route can do all its
// writes inside a single mutatePlatformData() transaction; read helpers wrap
// readPlatformData() themselves.

import { readPlatformData } from './platformStore.js';
import {
    makeMobileUser,
    makeDeviceInstall,
    makeCaptureSession,
    makeSubmission,
    makeAsset,
    makeVenue,
    makeReport,
    makeProcessingJob,
    productionTableDefaults,
} from './productionSchema.js';

const ensureProduction = (data) => {
    if (!data.production || typeof data.production !== 'object' || Array.isArray(data.production)) {
        data.production = productionTableDefaults();
    }
    for (const table of Object.keys(productionTableDefaults())) {
        if (!Array.isArray(data.production[table])) {
            data.production[table] = [];
        }
    }
    return data.production;
};

const nowIso = () => new Date().toISOString();

// ─── Writes (operate on the draft inside a mutatePlatformData transaction) ───

// Mirror the legacy mobileUser into production.mobile_users (idempotent by id).
export const mirrorMobileUser = (data, legacyUser) => {
    const prod = ensureProduction(data);
    let row = prod.mobile_users.find((item) => item.id === legacyUser.id);
    if (!row) {
        row = makeMobileUser({
            id: legacyUser.id,
            email: legacyUser.email ?? null,
            display_name: legacyUser.displayName ?? null,
            referral_code: legacyUser.referralCode ?? null,
            trust_tier: legacyUser.trustTier ?? 'new',
            status: legacyUser.status ?? 'active',
            restrictions: Array.isArray(legacyUser.restrictions) ? legacyUser.restrictions : [],
            submission_count: legacyUser.submissionCount ?? 0,
            confirmed_count: legacyUser.confirmedCount ?? 0,
            total_rewards_inr: legacyUser.totalRewardsInr ?? 0,
            password_hash: legacyUser.passwordHash ?? null,
            password_salt: legacyUser.passwordSalt ?? null,
            created_at: legacyUser.createdAt || undefined,
            updated_at: nowIso(),
        });
        prod.mobile_users.push(row);
    }
    return row;
};

// Mirror the legacy anonymousInstall into production.device_installs
// (idempotent by install_id). Refreshes the public key and last_seen.
export const mirrorDeviceInstall = (data, legacyInstall) => {
    const prod = ensureProduction(data);
    let row = prod.device_installs.find((item) => item.install_id === legacyInstall.installId);
    if (!row) {
        row = makeDeviceInstall({
            install_id: legacyInstall.installId,
            mobile_user_id: legacyInstall.mobileUserId ?? null,
            contributor_id: legacyInstall.contributorId ?? null,
            public_key: legacyInstall.publicKey ?? null,
            device_key_id: legacyInstall.deviceKeyId ?? null,
            device_profile_hash: legacyInstall.deviceProfileHash ?? null,
            user_agent_hash: legacyInstall.userAgentHash ?? null,
            ip_hash: legacyInstall.ipHash ?? null,
            device_traits: legacyInstall.deviceTraits ?? {},
            device_model: legacyInstall.deviceModel ?? null,
            os_version: legacyInstall.osVersion ?? null,
            app_version: legacyInstall.appVersion ?? null,
            capture_mode: legacyInstall.captureMode ?? 'mobile_pilot',
            submission_count: legacyInstall.submissionCount ?? 0,
            abuse_score: legacyInstall.abuseScore ?? 0,
            first_seen_at: legacyInstall.firstSeenAt || undefined,
            last_seen_at: nowIso(),
        });
        prod.device_installs.push(row);
    } else {
        row.public_key = legacyInstall.publicKey ?? row.public_key;
        row.device_key_id = legacyInstall.deviceKeyId ?? row.device_key_id;
        row.last_seen_at = nowIso();
    }
    return row;
};

// Upsert a production capture_sessions row keyed by id (the app's session id).
export const upsertCaptureSession = (data, input) => {
    const prod = ensureProduction(data);
    const existing = prod.capture_sessions.find((item) => item.id === input.id);
    if (!existing) {
        const row = makeCaptureSession(input);
        prod.capture_sessions.push(row);
        return row;
    }
    // Merge new context (e.g. device_snapshot, geolocation) over the existing row.
    const merged = makeCaptureSession({ ...existing, ...input });
    Object.assign(existing, merged);
    return existing;
};

// Upsert a production venue by place_provider_id (canonical) or fallback_key.
export const upsertVenue = (data, input) => {
    const prod = ensureProduction(data);
    const existing = prod.venues.find((item) => (
        input.place_provider_id
            ? item.place_provider_id === input.place_provider_id
            : (input.fallback_key && item.fallback_key === input.fallback_key)
    ));
    if (!existing) {
        const row = makeVenue(input);
        prod.venues.push(row);
        return row;
    }
    existing.name = input.name ?? existing.name;
    existing.address = input.address ?? existing.address;
    existing.city = input.city ?? existing.city;
    existing.location = input.location ?? existing.location;
    existing.place_provider = existing.place_provider || input.place_provider || null;
    existing.last_seen_at = nowIso();
    return existing;
};

export const insertSubmission = (data, input) => {
    const prod = ensureProduction(data);
    const row = makeSubmission(input);
    prod.submissions.push(row);
    return row;
};

export const insertAsset = (data, input) => {
    const prod = ensureProduction(data);
    const row = makeAsset(input);
    prod.assets.push(row);
    return row;
};

export const insertReport = (data, input) => {
    const prod = ensureProduction(data);
    const row = makeReport(input);
    prod.reports.push(row);
    return row;
};

export const insertProcessingJob = (data, input) => {
    const prod = ensureProduction(data);
    const row = makeProcessingJob(input);
    prod.processing_jobs.push(row);
    return row;
};

export const updateProcessingJob = (data, jobId, fields) => {
    const prod = ensureProduction(data);
    const row = prod.processing_jobs.find((item) => item.id === jobId);
    if (row) Object.assign(row, fields);
    return row || null;
};

// Merges `fields` onto an existing report row (used by Phase 2 to enrich the
// Phase 1 quick-ID report in place rather than inserting a duplicate).
export const updateReportFields = (data, reportId, fields) => {
    const prod = ensureProduction(data);
    const row = prod.reports.find((item) => item.id === reportId);
    if (row) {
        Object.assign(row, fields);
        row.updated_at = nowIso();
    }
    return row || null;
};

// Merges `fields` onto an existing production submission row (used by the
// processing pipeline to record derived_audio_asset_id, report_ids, status, etc.)
export const updateSubmissionFields = (data, submissionId, fields) => {
    const prod = ensureProduction(data);
    const row = prod.submissions.find((item) => item.id === submissionId);
    if (row) {
        Object.assign(row, fields);
        row.updated_at = nowIso();
    }
    return row || null;
};

// ─── Lookups (operate on a draft; sync) ───

export const findSubmission = (data, id, mobileUserId = null) => {
    const prod = ensureProduction(data);
    return prod.submissions.find((item) => (
        item.id === id && (mobileUserId == null || item.mobile_user_id === mobileUserId)
    )) || null;
};

export const findCaptureSession = (data, id) => (
    ensureProduction(data).capture_sessions.find((item) => item.id === id) || null
);

export const findDeviceInstall = (data, installId) => (
    ensureProduction(data).device_installs.find((item) => item.install_id === installId) || null
);

export const findReportsBySubmissionId = (data, submissionId) => (
    ensureProduction(data).reports.filter((item) => item.submission_id === submissionId)
);

// ─── Async read wrappers (own their readPlatformData) ───

export const getSubmissionById = async (id, mobileUserId = null) => {
    const data = await readPlatformData();
    return findSubmission(data, id, mobileUserId);
};

export const getReportsBySubmissionId = async (submissionId) => {
    const data = await readPlatformData();
    return findReportsBySubmissionId(data, submissionId);
};
