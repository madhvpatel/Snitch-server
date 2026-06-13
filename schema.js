// ============================================================================
// Snitch canonical data schema (single source of truth).
//
// PHYSICAL: JSON document store (data/platform-db.json). Each export below is a
// "collection" (top-level array). Relationships are by string id, exactly as a
// foreign key would be -- so this maps 1:1 to a relational schema (Postgres)
// when we migrate. Still-fluid, fast-changing structures live in a `raw` JSONB-
// style object so the classifier/valuation work does not force schema churn.
//
// POLICY anchors encoded here:
//   - Venue identifiers (BSSID/SSID/Place ID/...) are admin-gated: a case may
//     only PROPOSE one; resolution trusts status='approved' rows only.
//   - A case clusters one or more evidence submissions (venue + infringement).
//   - Valuation (recoverableValue) is provisional; valuationStatus stays 'tbd'
//     until a real monetary model exists.
//
// The factories produce records with every field present (no undefineds) so the
// shape is stable on disk and trivially diffable.
// ============================================================================

import crypto from 'crypto';

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// ----------------------------------------------------------------------------
// Enums (kept as frozen objects so callers reference SOURCE_CLASS.NO_MUSIC etc.)
// ----------------------------------------------------------------------------

export const VENUE_VERIFICATION = Object.freeze({
    UNVERIFIED: 'unverified',
    VERIFIED: 'verified',
    DISPUTED: 'disputed',
});

export const IDENTIFIER_TYPE = Object.freeze({
    WIFI_BSSID: 'wifi_bssid',
    WIFI_SSID: 'wifi_ssid',
    GOOGLE_PLACE_ID: 'google_place_id',
    PHONE: 'phone',
    SIGNAGE_TEXT: 'signage_text',
    OTHER: 'other',
});

// Admin approval gate. Resolution code MUST read APPROVED only.
export const IDENTIFIER_STATUS = Object.freeze({
    PROPOSED: 'proposed',
    APPROVED: 'approved',
    REJECTED: 'rejected',
});

export const SUBMISSION_STATUS = Object.freeze({
    RECEIVED: 'received',
    PROCESSING: 'processing',
    PROCESSED: 'processed',
    FAILED: 'failed',
    REJECTED: 'rejected',
});

// Case workflow position. Values are the canonical (DB/Postgres-facing) enum,
// aligned 1:1 with the CRM workflow so the existing transition graph is
// preserved. Display labels live in CASE_STAGE_LABEL and are applied only at the
// view/API boundary. Orthogonal flags (below) ride alongside.
export const CASE_STAGE = Object.freeze({
    NEW: 'new',
    MONITOR_ENRICH: 'monitor_enrich',
    BAD_CASE: 'bad_case',
    UNDER_REVIEW: 'under_review',
    AGENT_ASSIGNMENT: 'agent_assignment',
    READY_FOR_LEGAL: 'ready_for_legal',
    RECOVERY_IN_PROGRESS: 'recovery_in_progress',
    CLOSED: 'closed',
});

// Canonical enum <-> CRM display label. The frontend speaks labels; storage
// speaks the enum. Translate at the edges only.
export const CASE_STAGE_LABEL = Object.freeze({
    new: 'New',
    monitor_enrich: 'Monitor / Enrich',
    bad_case: 'Bad Case',
    under_review: 'Under Review',
    agent_assignment: 'Agent Assignment',
    ready_for_legal: 'Ready For Legal',
    recovery_in_progress: 'Recovery In Progress',
    closed: 'Closed',
});

export const stageToLabel = (stage) => CASE_STAGE_LABEL[stage] || 'New';
export const labelToStage = (label) => (
    Object.entries(CASE_STAGE_LABEL).find(([, v]) => v === label)?.[0] || 'new'
);

// Non-exclusive status flags a case can carry regardless of stage.
export const CASE_FLAG = Object.freeze({
    PENDING_LICENSE_VERIFICATION: 'pending_license_verification',
    VENUE_DISCREPANCY_FLAGGED: 'venue_discrepancy_flagged',
    SONG_UNRESOLVED: 'song_unresolved',
    AWAITING_CORROBORATION: 'awaiting_corroboration',
});

export const CASE_EVENT_TYPE = Object.freeze({
    STAGE_CHANGE: 'stage_change',
    STATUS_CHANGE: 'status_change',
    NOTE: 'note',
    CUSTODY: 'custody',
    IDENTIFIER_PROPOSED: 'identifier_proposed',
    IDENTIFIER_APPROVED: 'identifier_approved',
    REVIEW: 'review',
    SUBMISSION_LINKED: 'submission_linked',
});

export const ACTOR_TYPE = Object.freeze({
    SYSTEM: 'system',
    STAFF: 'staff',
    SNITCHER: 'snitcher',
});

// ----------------------------------------------------------------------------
// Collection factories
// ----------------------------------------------------------------------------

// companies — holding/operator master. Enforcement targets the licensee, so the
// holding company lives here; venues point up to it.
export const makeCompany = ({
    id = `company_${uuid()}`,
    legalName = null,
    holdingCompanyName = null,
    brandNames = [],
    registrationNo = null,      // GST / CIN / equivalent
    jurisdiction = 'IN',
    status = 'active',
} = {}) => ({
    id,
    legalName,
    holdingCompanyName,
    brandNames,
    registrationNo,
    jurisdiction,
    status,
    createdAt: now(),
    updatedAt: now(),
});

// venues — venue master, upserted as new captures arrive. placeProviderId
// (Google Place ID) is the canonical identity; fallbackKey covers the no-Place
// case. companyId links to the holding company.
export const makeVenue = ({
    id = uuid(),
    companyId = null,
    placeProviderId = null,
    fallbackKey = null,
    name = null,
    address = null,
    city = null,
    state = null,
    postalCode = null,
    country = 'IN',
    latitude = null,
    longitude = null,
    verificationStatus = VENUE_VERIFICATION.UNVERIFIED,
} = {}) => ({
    id,
    companyId,
    placeProviderId,
    fallbackKey,
    name,
    address,
    city,
    state,
    postalCode,
    country,
    latitude,
    longitude,
    verificationStatus,
    firstSeenAt: now(),
    lastSeenAt: now(),
    createdAt: now(),
    updatedAt: now(),
});

// venueIdentifiers — the admin-gated table. A case PROPOSES an identifier
// (wifi_bssid, wifi_ssid, google_place_id, ...). It is NOT used for resolution
// until an admin sets status='approved'. The approved wifi_bssid rows are what
// the old venueFingerprints registry held.
export const makeVenueIdentifier = ({
    id = `vid_${uuid()}`,
    venueId,
    type,
    value,
    normalizedValue = null,
    status = IDENTIFIER_STATUS.PROPOSED,
    sourceCaseId = null,
    sourceSubmissionId = null,
    corroboratingCaseIds = [],
    proposedBy = ACTOR_TYPE.SYSTEM,
    reviewedBy = null,           // staffUser id
    reviewedAt = null,
    decisionNote = null,
} = {}) => ({
    id,
    venueId,
    type,
    value,
    normalizedValue: normalizedValue ?? value,
    status,
    sourceCaseId,
    sourceSubmissionId,
    corroboratingCaseIds,
    proposedBy,
    proposedAt: now(),
    reviewedBy,
    reviewedAt,
    decisionNote,
    createdAt: now(),
    updatedAt: now(),
});

// snitchers — user master for the people capturing evidence. "Backend knows who
// submitted what" = every evidence_submission carries snitcherId.
export const makeSnitcher = ({
    id = `snitcher_${uuid()}`,
    email = null,
    phone = null,
    displayName = null,
    referralCode = null,
    trustTier = 'new',
    status = 'active',
    restrictions = [],
    passwordSalt = null,
    passwordHash = null,
} = {}) => ({
    id,
    email,
    phone,
    displayName,
    referralCode,
    trustTier,
    status,
    restrictions,
    submissionCount: 0,
    confirmedCount: 0,
    totalRewardsInr: 0,
    passwordSalt,
    passwordHash,
    createdAt: now(),
    updatedAt: now(),
});

// snitcherDevices — devices/installs under a snitcher. Ties anonymous-feeling
// captures to an identity and surfaces device-farming (one device, many venues).
export const makeSnitcherDevice = ({
    id = `device_${uuid()}`,
    snitcherId = null,
    installId = null,
    platform = null,
    model = null,
    deviceTrustBand = null,
} = {}) => ({
    id,
    snitcherId,
    installId,
    platform,
    model,
    deviceTrustBand,
    firstSeenAt: now(),
    lastSeenAt: now(),
    createdAt: now(),
});

// evidenceSubmissions — one capture. Typed columns are the few fields the CRM
// filters/sorts on; everything still-fluid lives under `raw` (JSONB later).
export const makeEvidenceSubmission = ({
    id = uuid(),
    reference = null,
    snitcherId = null,
    deviceId = null,
    caseId = null,               // nullable until clustered into a case
    claimedVenueName = null,
    claimedLat = null,
    claimedLng = null,
    claimedAddress = null,
    claimedCity = null,
    capturedAt = null,
    status = SUBMISSION_STATUS.RECEIVED,
    assetIds = [],
    mediaSha256 = null,
    durationSeconds = null,
    hasValidSignature = false,
} = {}) => ({
    id,
    reference,
    snitcherId,
    deviceId,
    caseId,
    claimedVenueName,
    claimedLat,
    claimedLng,
    claimedAddress,
    claimedCity,
    capturedAt,
    submittedAt: now(),
    status,
    assetIds,
    mediaSha256,
    durationSeconds,
    hasValidSignature,

    // --- typed analysis outputs (queryable) ---
    sourceClass: null,
    supportsVenuePlayback: null,
    evidenceValidity: null,
    enforcementReadiness: null,
    songMatchStatus: null,
    matchedTrackId: null,
    matchedTrackConfidence: null,
    venueResolutionRecommendation: null,   // confirms_selected | suggests_alternate | insufficient_evidence
    resolvedVenueId: null,
    discrepancySeverity: null,             // high | medium | low | null

    // --- fluid blobs (-> JSONB) ---
    raw: {
        radioContext: null,
        geolocationDelta: null,
        sourceAssessment: null,
        songAssessment: null,
        venueResolutionReview: null,
        visualAnalysis: null,
        trustGates: null,
    },

    createdAt: now(),
    updatedAt: now(),
});

// cases — the enforcement unit. Clusters one+ submissions for a venue +
// infringement. Carries the live stage AND orthogonal status flags.
export const makeCase = ({
    id = null,                   // CASE-XXXXXX, assigned by caller
    reference = null,
    resolvedVenueId = null,
    companyId = null,
    stage = CASE_STAGE.INTAKE,
    statusFlags = [],
    primarySubmissionId = null,
    submissionIds = [],
    pastOffences = 0,
    licenseStatus = 'unknown',
    licenseSource = null,
    rightsOwnerOrgId = null,
    matchedTrackId = null,
    recoverableValue = 0,
    valuationStatus = 'tbd',
} = {}) => ({
    id,
    reference,
    resolvedVenueId,
    companyId,
    stage,
    statusFlags,
    primarySubmissionId,
    submissionIds,
    evidenceCount: submissionIds.length,
    pastOffences,
    licenseStatus,
    licenseSource,
    rightsOwnerOrgId,
    matchedTrackId,
    recoverableValue,
    valuationStatus,
    openedAt: now(),
    createdAt: now(),
    updatedAt: now(),
});

// caseEvents — append-only timeline: stage/status transitions, chain of custody,
// identifier proposals/approvals, analyst notes. Replaces the scattered
// auditTrail / chainOfCustody / readiness_reasons arrays with one log.
export const makeCaseEvent = ({
    id = `evt_${uuid()}`,
    caseId,
    eventType,
    fromStage = null,
    toStage = null,
    actorType = ACTOR_TYPE.SYSTEM,
    actorId = null,
    payload = {},
} = {}) => ({
    id,
    caseId,
    eventType,
    fromStage,
    toStage,
    actorType,
    actorId,
    payload,
    createdAt: now(),
});

// ----------------------------------------------------------------------------
// Collection registry. `derived: true` collections are rebuildable caches/indexes
// (not a source of truth). Used by the store for defaults and by tooling.
// ----------------------------------------------------------------------------

export const CANONICAL_COLLECTIONS = Object.freeze({
    // masters / reference
    companies: { derived: false, note: 'Holding/operator master (holding company names).' },
    venues: { derived: false, note: 'Venue master; upserted as captures arrive.' },
    venueIdentifiers: { derived: false, note: 'Admin-gated venue identifiers (proposed->approved).' },
    snitchers: { derived: false, note: 'User master for evidence contributors.' },
    snitcherDevices: { derived: false, note: 'Devices/installs under a snitcher.' },
    // operational
    evidenceSubmissions: { derived: false, note: 'One capture each; typed outputs + raw blob.' },
    cases: { derived: false, note: 'Enforcement unit; clusters submissions; has stage + flags.' },
    caseEvents: { derived: false, note: 'Append-only case timeline / audit / custody.' },
});

// Empty defaults for every canonical collection (for the store to backfill).
export const canonicalCollectionDefaults = () => Object.fromEntries(
    Object.keys(CANONICAL_COLLECTIONS).map((key) => [key, []]),
);
