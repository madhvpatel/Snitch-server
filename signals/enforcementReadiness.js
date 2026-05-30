const READINESS_MODEL_VERSION = 'enforcement-readiness-v1';

export const LICENSE_STATUSES = {
    LICENSED: 'LICENSED',
    UNLICENSED: 'UNLICENSED',
    UNKNOWN: 'UNKNOWN',
    MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
};

export const VENUE_STATUSES = {
    RESOLVED: 'RESOLVED',
    APPROXIMATE: 'APPROXIMATE',
    UNRESOLVED: 'UNRESOLVED',
};

export const READINESS_BANDS = [
    { min: 90, value: 'LITIGATION_READY', label: 'Litigation Ready' },
    { min: 80, value: 'ESCALATION_READY', label: 'Escalation Ready' },
    { min: 68, value: 'CASE_CANDIDATE', label: 'Case Candidate' },
    { min: 50, value: 'MONITOR_ENRICH', label: 'Monitor & Enrich' },
    { min: 0, value: 'INSUFFICIENT_EVIDENCE', label: 'Insufficient Evidence' },
];

const clampScore = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

export const getReadinessBand = (score) => {
    const numeric = clampScore(score);
    return READINESS_BANDS.find((band) => numeric >= band.min) || READINESS_BANDS[READINESS_BANDS.length - 1];
};

export const normalizeLicenseStatus = (value) => {
    const raw = String(value || '').trim().toUpperCase();
    if (raw === 'UNLICENSED' || raw === 'EXPIRED') return LICENSE_STATUSES.UNLICENSED;
    if (raw === 'LICENSED') return LICENSE_STATUSES.LICENSED;
    if (raw === 'MANUAL_REVIEW_REQUIRED' || raw === 'PENDING_LICENSE_VERIFICATION') return LICENSE_STATUSES.MANUAL_REVIEW_REQUIRED;
    return LICENSE_STATUSES.UNKNOWN;
};

export const buildLicenseResolution = ({ caseRecord, report }) => ({
    license_status: normalizeLicenseStatus(caseRecord?.licenseResolution?.license_status || caseRecord?.licenseStatus || report?.licenseAssessment?.status),
    license_source: caseRecord?.licenseResolution?.license_source || caseRecord?.licenseSource || report?.licenseAssessment?.source || null,
    license_checked_at: caseRecord?.licenseResolution?.license_checked_at || caseRecord?.licenseCheckedAt || null,
    license_checked_by: caseRecord?.licenseResolution?.license_checked_by || caseRecord?.licenseCheckedBy || null,
    manual_attestation: caseRecord?.licenseResolution?.manual_attestation || null,
    registry_lookup_id: caseRecord?.licenseResolution?.registry_lookup_id || null,
    registry_response_snapshot: caseRecord?.licenseResolution?.registry_response_snapshot || null,
});

export const getVenueResolutionStatus = (caseView) => {
    if (caseView?.venueAttribution?.status === 'coordinate_only') return VENUE_STATUSES.APPROXIMATE;
    if (caseView?.venueAttribution?.status === 'adjacent_venue_ambiguous') return VENUE_STATUSES.UNRESOLVED;
    if (!caseView?.venueContext?.matchedVenue?.id && !caseView?.venueContext?.matchedVenue?.placeProviderId) return VENUE_STATUSES.UNRESOLVED;
    return VENUE_STATUSES.RESOLVED;
};

export const buildVenueResolutionModel = (caseView) => {
    const venueStatus = getVenueResolutionStatus(caseView);
    return {
        venue_status: venueStatus,
        coordinates: {
            lat: caseView?.location?.lat ?? null,
            lng: caseView?.location?.lng ?? null,
        },
        candidate_venues: caseView?.locationDelta?.nearbyVenueCandidates || [],
        candidate_match_confidence: caseView?.scoring?.venueIdentityScore?.confidence ?? null,
        resolution_status: venueStatus === VENUE_STATUSES.RESOLVED ? 'RESOLVED' : 'READY_FOR_REVIEW',
        resolution_notes: caseView?.venueAttribution?.note || null,
    };
};

export const evaluateLitigationGates = ({ caseView, licenseResolution = null }) => {
    const license = licenseResolution || caseView?.licenseResolution || {};
    const gates = [];
    const addGate = (code, passed, explanation, requiredResolution) => {
        gates.push({ code, passed: Boolean(passed), explanation, required_resolution: requiredResolution || null });
    };

    addGate(
        'RIGHTS_LICENSE_STATUS_RESOLVED',
        license.license_status === LICENSE_STATUSES.UNLICENSED || license.license_status === LICENSE_STATUSES.LICENSED,
        'Rights/license status must be resolved before litigation submission.',
        'Resolve license status through registry lookup or manual attestation.'
    );
    addGate(
        'VENUE_IDENTITY_RESOLVED',
        getVenueResolutionStatus(caseView) === VENUE_STATUSES.RESOLVED && !caseView?.venueAttribution?.legalBlock,
        'Venue identity must be resolved without adjacent, approximate, or wrong-unit ambiguity.',
        'Resolve venue attribution or confirm the correct venue through the venue resolution workflow.'
    );
    addGate(
        'MINIMUM_EVIDENCE_CONFIDENCE_MET',
        Number(caseView?.scoring?.evidenceStrengthScore?.score || caseView?.qualityScore || 0) >= 60,
        'Minimum evidence confidence must be met.',
        'Collect stronger media, source, visual, or chain-of-custody evidence.'
    );
    addGate(
        'REQUIRED_FORENSIC_ARTIFACTS_PRESENT',
        Boolean(caseView?.videoProofUrl)
            && Boolean(caseView?.trustGates?.mediaHashKey)
            && Array.isArray(caseView?.absoluteProof?.venueImages)
            && caseView.absoluteProof.venueImages.length > 0,
        'Required forensic artifacts must be present.',
        'Attach raw video, media hash, and reviewable frame evidence.'
    );
    addGate(
        'BLOCKING_QUESTIONS_CLEARED',
        !caseView?.venueAttribution?.legalBlock && !['coordinate_only', 'adjacent_venue_ambiguous', 'wrong_venue_or_unit', 'visual_target_mismatch'].includes(caseView?.venueAttribution?.status),
        'Open blocking questions must be cleared.',
        'Clear legal blocks and unresolved venue/source questions.'
    );

    return {
        modelVersion: READINESS_MODEL_VERSION,
        gates,
        blocking_reasons: gates
            .filter((gate) => !gate.passed)
            .map((gate) => ({ code: gate.code, explanation: gate.explanation })),
        required_resolutions: gates
            .filter((gate) => !gate.passed && gate.required_resolution)
            .map((gate) => ({ code: gate.code, action: gate.required_resolution })),
    };
};

export const calculateProsecutionStrength = ({ caseView, gates }) => {
    const history = caseView?.historicalEvidence || {};
    const venueScore = Number(caseView?.scoring?.venueIdentityScore?.score || 0);
    const evidenceScore = Number(caseView?.scoring?.evidenceStrengthScore?.score || caseView?.qualityScore || 0);
    const confirmedIncidentCount = Math.max(1, Number(history.confirmedVenueReportCount || 0) + 1);
    const repeatPatternBonus = Math.min(18, Math.max(0, confirmedIncidentCount - 1) * 6);
    const blockerPenalty = (gates?.blocking_reasons?.length || 0) * 10;
    const score = clampScore((venueScore * 0.3) + (evidenceScore * 0.35) + 25 + repeatPatternBonus - blockerPenalty);
    const label = score >= 80 ? 'STRONG' : score >= 60 ? 'MODERATE' : score >= 40 ? 'LIMITED' : 'WEAK';
    const reasons = [
        `${confirmedIncidentCount} confirmed incident signal(s) considered.`,
        `Venue identity contributes ${Math.round(venueScore)} / 100.`,
        `Evidence completeness contributes ${Math.round(evidenceScore)} / 100.`,
    ];
    if (repeatPatternBonus > 0) reasons.push('Repeat capture history increases prosecution strength.');
    if (blockerPenalty > 0) reasons.push('Open litigation blockers reduce prosecution strength.');

    return {
        prosecution_strength_score: score,
        prosecution_strength_label: label,
        prosecution_strength_reasons: reasons,
    };
};

export const evaluateCaseReadiness = ({ caseView, licenseResolution = null }) => {
    const gates = evaluateLitigationGates({ caseView, licenseResolution });
    const legalScore = Number(caseView?.scoring?.legalReadinessScore?.score || 0);
    const blockerPenalty = gates.blocking_reasons.length * 8;
    const readinessScore = clampScore(legalScore - blockerPenalty);
    const band = getReadinessBand(readinessScore);
    const prosecutionStrength = calculateProsecutionStrength({ caseView, gates });
    const readinessReasons = [
        `Legal readiness score is ${Math.round(legalScore)} before gate penalties.`,
        `${gates.blocking_reasons.length} blocking gate(s) are active.`,
        ...gates.blocking_reasons.map((entry) => entry.explanation),
    ];
    const nextActions = gates.required_resolutions.map((entry) => entry.action);
    if (!nextActions.length && readinessScore < 90) {
        nextActions.push('Continue enrichment until litigation-ready threshold is met.');
    }

    return {
        modelVersion: READINESS_MODEL_VERSION,
        readiness_score: readinessScore,
        readiness_band: band.value,
        readiness_label: band.label,
        readiness_reasons: readinessReasons,
        next_actions: [...new Set(nextActions)],
        gates,
        ...prosecutionStrength,
    };
};

export const evaluateLitigationEligibility = ({ caseView, licenseResolution = null, evaluatedAt = new Date().toISOString() }) => {
    const readiness = evaluateCaseReadiness({ caseView, licenseResolution });
    return {
        case_id: caseView?.id || null,
        can_send_to_litigation: readiness.readiness_band === 'LITIGATION_READY' && readiness.gates.blocking_reasons.length === 0,
        blocking_reasons: readiness.gates.blocking_reasons,
        required_resolutions: readiness.gates.required_resolutions,
        evaluated_at: evaluatedAt,
        readiness,
    };
};
