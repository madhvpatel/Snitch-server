// Production-shaped row factories for the capture write path.
//
// These mirror the PostgreSQL tables in production-db-design.md EXACTLY:
// snake_case columns, every field present (no undefineds), so the rows are
// stable on disk and a future migration to Postgres is a 1:1 per-table insert.
// They live in the JSON store under data.production.<table> for now; the only
// module that reads/writes them is productionStore.js (the repository seam).
//
// Columns marked "(extension)" are lossless additions beyond the doc — they
// carry signals the app already sends that the doc did not enumerate. They map
// cleanly to extra jsonb columns when we move to Postgres.

import crypto from 'crypto';

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// mobile_users — snitching app users. Mirrored from the legacy mobileUser at
// submission time so the production store is self-consistent for migration.
export const makeMobileUser = ({
    id = `mobile_${uuid()}`,
    email = null,
    display_name = null,
    referral_code = null,
    trust_tier = 'new',
    status = 'active',
    restrictions = [],
    submission_count = 0,
    confirmed_count = 0,
    total_rewards_inr = 0,
    password_hash = null,
    password_salt = null,
    created_at = now(),
    updated_at = now(),
} = {}) => ({
    id,
    email,
    display_name,
    referral_code,
    trust_tier,
    status,
    restrictions,
    submission_count,
    confirmed_count,
    total_rewards_inr,
    password_hash,
    password_salt,
    created_at,
    updated_at,
});

// device_installs — one row per app/browser install. Holds the signing public
// key the finalize step verifies against.
export const makeDeviceInstall = ({
    id = uuid(),
    install_id,
    mobile_user_id = null,
    contributor_id = null,
    public_key = null,
    device_key_id = null,
    device_profile_hash = null,
    user_agent_hash = null,
    ip_hash = null,
    device_traits = {},
    device_model = null,
    os_version = null,
    app_version = null,
    capture_mode = 'mobile_pilot',
    submission_count = 0,
    abuse_score = 0,
    first_seen_at = now(),
    last_seen_at = now(),
} = {}) => ({
    id,
    install_id,
    mobile_user_id,
    contributor_id,
    public_key,
    device_key_id,
    device_profile_hash,
    user_agent_hash,
    ip_hash,
    device_traits,
    device_model,
    os_version,
    app_version,
    capture_mode,
    submission_count,
    abuse_score,
    first_seen_at,
    last_seen_at,
});

// capture_sessions — capture timing + device state. device_snapshot is the
// previously-dropped device_context (compass, cellular, OS/timezone/locale).
export const makeCaptureSession = ({
    id,
    install_id,
    session_nonce = null,
    issued_server_time = null,
    start_server_time = null,
    end_server_time = null,
    local_start_time = null,
    measured_start_offset_ms = null,
    measured_end_offset_ms = null,
    geolocation_start = null,        // { lat, lng } — PostGIS geography later
    geolocation_end = null,
    geolocation_start_raw = null,    // full jsonb incl. altitude/speed/heading
    geolocation_end_raw = null,
    device_snapshot = null,          // jsonb ← device_context (lossless)
    status = 'stored',
    created_at = now(),
} = {}) => ({
    id,
    install_id,
    session_nonce,
    issued_server_time,
    start_server_time,
    end_server_time,
    local_start_time,
    measured_start_offset_ms,
    measured_end_offset_ms,
    geolocation_start,
    geolocation_end,
    geolocation_start_raw,
    geolocation_end_raw,
    device_snapshot,
    status,
    created_at,
});

// submissions — the raw capture package. radio_context keeps the FULL radio
// bundle (incl. wifi.networks[] + BLE enrichment) that the legacy path drops.
export const makeSubmission = ({
    id = uuid(),
    reference,
    capture_session_id = null,
    install_id = null,
    mobile_user_id = null,
    raw_video_asset_id = null,
    derived_audio_asset_id = null,
    media_sha256 = null,
    duration_seconds = null,
    mime_type = null,
    file_name = null,
    file_size = null,
    consent_version = 'snitchv1-mobile',
    status = 'received',
    upload_token_hash = null,
    has_valid_signature = false,
    signature_status = 'unsigned_or_unverified',
    payload_signature = false,
    signature_verified_at = null,
    geolocation_start = null,        // { lat, lng } — PostGIS geography later
    geolocation_end = null,
    geolocation_start_raw = null,    // full jsonb incl. altitude/speed/heading
    geolocation_end_raw = null,
    radio_context = null,            // jsonb — full, lossless radio bundle
    selected_venue_context = null,   // jsonb — chosen venue payload
    capture_context = null,          // jsonb (extension) — note/business/gstin/classifier mode
    audio_level_envelope = null,     // jsonb array (extension) — Android RMS envelope
    created_at = now(),
    updated_at = now(),
} = {}) => ({
    id,
    reference,
    capture_session_id,
    install_id,
    mobile_user_id,
    raw_video_asset_id,
    derived_audio_asset_id,
    media_sha256,
    duration_seconds,
    mime_type,
    file_name,
    file_size,
    consent_version,
    status,
    upload_token_hash,
    has_valid_signature,
    signature_status,
    payload_signature,
    signature_verified_at,
    geolocation_start,
    geolocation_end,
    geolocation_start_raw,
    geolocation_end_raw,
    radio_context,
    selected_venue_context,
    capture_context,
    audio_level_envelope,
    created_at,
    updated_at,
});

// assets — metadata for media artifacts. The bytes live in object storage
// (local filesystem for now); object_key is the storage path.
export const makeAsset = ({
    id = uuid(),
    kind,
    storage_provider = 'local',
    bucket = null,
    object_key,
    public_url = null,
    file_name = null,
    mime_type = null,
    size_bytes = null,
    sha256 = null,
    metadata = {},
    created_at = now(),
} = {}) => ({
    id,
    kind,
    storage_provider,
    bucket,
    object_key,
    public_url,
    file_name,
    mime_type,
    size_bytes,
    sha256,
    metadata,
    created_at,
});

// reports — processed evidence report generated from a submission.
export const makeReport = ({
    id = uuid(),
    reference,
    submission_id,
    venue_id = null,
    place_provider_id = null,
    matched_track_id = null,
    matched_track_confidence = 0,
    rights_owner_org_id = null,
    rights_type = null,
    title = 'Unknown Track',
    artist = 'Unknown Artist',
    label = 'Unknown Label',
    rights_org = null,
    forensic_summary = null,
    device_trust_band = 'unscored',
    analyst_status = 'unreviewed',
    export_status = 'not_exported',
    // Two-phase processing marker: 'quick_id' = light ACRCloud-only pass at
    // submit (song + ownership for the snitcher); 'full' = deferred advanced
    // pass (Demucs, source/visual/application analysis, reconciliation).
    processing_stage = 'quick_id',
    source_analysis = null,
    visual_analysis = null,
    application_assessment = null,
    license_assessment = null,
    // Derived routing fields fused from the snitcher's declared context and the
    // detected evidence (see captureContext.reconcileContext). space_class is a
    // top-level column so routing/sorting can index it directly; the full fusion
    // record (agreement, mismatch flags, review reason) lives in
    // context_reconciliation. These are the ONLY context fields routing reads —
    // never the raw declaration on the submission.
    space_class = 'NEEDS_REVIEW',
    context_reconciliation = null,
    merchant_master_id = null,
    created_at = now(),
    updated_at = now(),
} = {}) => ({
    id,
    reference,
    submission_id,
    venue_id,
    place_provider_id,
    matched_track_id,
    matched_track_confidence,
    rights_owner_org_id,
    rights_type,
    title,
    artist,
    label,
    rights_org,
    forensic_summary,
    device_trust_band,
    analyst_status,
    export_status,
    processing_stage,
    source_analysis,
    visual_analysis,
    application_assessment,
    license_assessment,
    space_class,
    context_reconciliation,
    merchant_master_id,
    created_at,
    updated_at,
});

// processing_jobs — tracks async pipeline work (ACRCloud, Gemini, Demucs, frames).
// One row per processing run; no per-provider granularity this slice.
export const makeProcessingJob = ({
    id = uuid(),
    submission_id = null,
    report_id = null,
    case_id = null,
    job_type = 'full_pipeline',
    provider = 'internal',
    status = 'pending',
    attempt = 1,
    input_asset_id = null,
    output_asset_ids = [],
    request_payload = null,
    response_payload = null,
    error_message = null,
    started_at = null,
    finished_at = null,
    created_at = now(),
} = {}) => ({
    id,
    submission_id,
    report_id,
    case_id,
    job_type,
    provider,
    status,
    attempt,
    input_asset_id,
    output_asset_ids,
    request_payload,
    response_payload,
    error_message,
    started_at,
    finished_at,
    created_at,
});

// venues — canonical venue records, upserted as captures arrive.
export const makeVenue = ({
    id = uuid(),
    place_provider = null,
    place_provider_id = null,
    fallback_key = null,
    name = null,
    address = null,
    city = null,
    location = null,                 // { lat, lng } — PostGIS geography later
    created_at = now(),
    last_seen_at = now(),
} = {}) => ({
    id,
    place_provider,
    place_provider_id,
    fallback_key,
    name,
    address,
    city,
    location,
    created_at,
    last_seen_at,
});

// The set of production tables this slice writes. Used by the store to seed
// empty arrays and by tooling/migration.
export const PRODUCTION_TABLES = Object.freeze([
    'mobile_users',
    'device_installs',
    'capture_sessions',
    'submissions',
    'assets',
    'venues',
    'reports',
    'processing_jobs',
]);

export const productionTableDefaults = () => Object.fromEntries(
    PRODUCTION_TABLES.map((table) => [table, []]),
);
