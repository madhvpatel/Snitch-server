import { cleanString, scoreZeroToOne } from './common.js';

const SCORING_MODEL_VERSION = 'venue-evidence-scoring-v1';
const DAY_MS = 24 * 60 * 60 * 1000;

const clampScore = (value) => Math.max(0, Math.min(100, Math.round(value)));

const factor = (signal, effect, reason, evidence = {}) => ({
    signal,
    effect,
    reason,
    evidence,
});

const daysBetween = (left, right) => {
    const leftMs = new Date(left).getTime();
    const rightMs = new Date(right).getTime();
    if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
        return null;
    }

    return Math.abs(rightMs - leftMs) / DAY_MS;
};

export const buildHistoricalEvidenceContext = ({
    data,
    report,
    submission,
    venue,
    caseRecord,
    reviews = [],
    now = new Date(),
}) => {
    const nowMs = now.getTime();
    const venueId = venue?.id || report?.venueId || caseRecord?.venueId || null;
    const installId = submission?.installId || caseRecord?.primaryInstallId || null;
    const reportId = report?.id || null;
    const caseId = caseRecord?.id || report?.caseId || null;
    const sameVenueReports = venueId
        ? (data?.reports || []).filter((entry) => entry.venueId === venueId && entry.id !== reportId)
        : [];
    const sameInstallSubmissions = installId
        ? (data?.submissions || []).filter((entry) => entry.installId === installId && entry.id !== submission?.id)
        : [];
    const sameVenueCases = venueId
        ? (data?.caseLedger || []).filter((entry) => entry.venueId === venueId && entry.id !== caseId)
        : [];
    const recentVenueReports30d = sameVenueReports.filter((entry) => nowMs - new Date(entry.createdAt).getTime() <= 30 * DAY_MS);
    const recentVenueReports90d = sameVenueReports.filter((entry) => nowMs - new Date(entry.createdAt).getTime() <= 90 * DAY_MS);
    const recentInstallSubmissions30d = sameInstallSubmissions.filter((entry) => nowMs - new Date(entry.createdAt).getTime() <= 30 * DAY_MS);
    const confirmedVenueReports = sameVenueReports.filter((entry) => ['confirmed', 'verified', 'actionable'].includes(cleanString(entry.analystStatus || entry.status)));
    const weakVenueReports = sameVenueReports.filter((entry) => ['rejected', 'weak', 'needs_more_evidence'].includes(cleanString(entry.analystStatus || entry.status)));
    const historicalReviews = [
        ...reviews,
        ...(data?.reviewLedger || []).filter((entry) => entry.reportId && sameVenueReports.some((item) => item.id === entry.reportId)),
    ];
    const favorableReviews = historicalReviews.filter((entry) => ['confirm', 'confirmed', 'approve', 'approved'].includes(cleanString(entry.verdict)));
    const adverseReviews = historicalReviews.filter((entry) => ['reject', 'rejected', 'insufficient', 'weak'].includes(cleanString(entry.verdict)));
    const lastVenueReport = sameVenueReports
        .slice()
        .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0] || null;
    const lastReportAgeDays = lastVenueReport ? daysBetween(lastVenueReport.createdAt, now.toISOString()) : null;

    return {
        modelVersion: SCORING_MODEL_VERSION,
        sameVenueReportCount: sameVenueReports.length,
        sameVenueReports30d: recentVenueReports30d.length,
        sameVenueReports90d: recentVenueReports90d.length,
        confirmedVenueReportCount: confirmedVenueReports.length,
        weakVenueReportCount: weakVenueReports.length,
        sameVenueCaseCount: sameVenueCases.length,
        sameInstallSubmissionCount30d: recentInstallSubmissions30d.length,
        sameInstallDistinctVenueCount30d: new Set(recentInstallSubmissions30d.map((entry) => entry.venueId || entry.matchedVenue || entry.selectedVenue?.name).filter(Boolean)).size,
        favorableReviewCount: favorableReviews.length,
        adverseReviewCount: adverseReviews.length,
        lastVenueReportAt: lastVenueReport?.createdAt || null,
        lastVenueReportAgeDays: lastReportAgeDays != null ? Math.round(lastReportAgeDays) : null,
    };
};

export const scoreVenueIdentity = ({
    locationDelta = {},
    visualContext = {},
    radioContext = {},
    venueContext = {},
    historicalEvidence = {},
}) => {
    let score = 35;
    const factors = [];
    const minDistance = Number(locationDelta.minVenueDistanceMeters);
    const envelope = Number(locationDelta.accuracyEnvelopeMeters);
    const visualSignals = [
        ...(visualContext.venueIdentitySignals || []),
        ...(visualContext.frameObservations || []).map((entry) => entry.observation),
    ].filter(Boolean);
    const genericVisualVenueCue = cleanString(visualContext.summary || '').match(/\b(bar|pub|restaurant|cafe|tavern|lounge|commercial venue)\b/);
    const hasVenueSpecificVisual = visualSignals.length > 0;
    const wifiSummary = radioContext.wifi?.ssid || radioContext.wifi?.summary || null;
    const targetName = venueContext.selectedVenue?.name || venueContext.matchedVenue?.name || null;
    const radioNameHint = wifiSummary && targetName
        ? cleanString(wifiSummary).includes(cleanString(targetName).split(' ')[0] || '')
        : false;

    if (Number.isFinite(minDistance) && Number.isFinite(envelope) && minDistance <= envelope) {
        const effect = minDistance <= 15 ? 18 : 12;
        score += effect;
        factors.push(factor('GPS proximity', effect, `Capture is ${Math.round(minDistance)} m from the primary venue anchor inside a ${Math.round(envelope)} m envelope.`, { minDistance, envelope }));
    } else if (locationDelta.withinAccuracyEnvelope === false) {
        score -= 18;
        factors.push(factor('GPS outside envelope', -18, 'Capture sits outside the current GPS accuracy envelope for the primary venue anchor.'));
    }

    if (locationDelta.selectedMatchedAligned === true) {
        score += 10;
        factors.push(factor('Selected/matched alignment', 10, 'Selected venue and matched venue names align.'));
    } else if (locationDelta.selectedMatchedAligned === false) {
        score -= 14;
        factors.push(factor('Selected/matched mismatch', -14, 'Selected venue and matched venue names do not align cleanly.'));
    }

    if (locationDelta.adjacentVenueAmbiguity === true) {
        const alternateName = locationDelta.closestAlternateVenueCandidate?.name || 'another nearby venue';
        score -= 30;
        factors.push(factor('Adjacent venue ambiguity', -30, `${alternateName} is also inside the GPS accuracy envelope; closest-pin attribution is not decisive.`, {
            alternateVenue: locationDelta.closestAlternateVenueCandidate || null,
            closestAlternateDeltaMeters: locationDelta.closestAlternateDeltaMeters ?? null,
        }));
    }

    if (hasVenueSpecificVisual) {
        score += 18;
        factors.push(factor('Venue-specific visual identity', 18, 'Visual analysis found venue identity cues.', { cueCount: visualSignals.length }));
    } else if (genericVisualVenueCue) {
        score += 6;
        factors.push(factor('Generic venue visual context', 6, 'Visuals support a venue-like environment but not a specific venue identity.'));
    } else {
        score -= 8;
        factors.push(factor('Missing visual identity', -8, 'Visuals do not identify the exact venue.'));
    }

    if (radioContext.wifi?.status === 'captured' && radioNameHint) {
        score += 10;
        factors.push(factor('Radio venue hint', 10, 'Connected Wi-Fi context appears consistent with the target venue.', { wifiSummary }));
    } else if (radioContext.wifi?.status === 'captured') {
        score += 3;
        factors.push(factor('Radio context captured', 3, 'Wi-Fi context was captured, but it is corroborating only.', { wifiSummary }));
    }

    if (historicalEvidence.confirmedVenueReportCount > 0) {
        const effect = Math.min(12, historicalEvidence.confirmedVenueReportCount * 4);
        score += effect;
        factors.push(factor('Historical venue corroboration', effect, 'Prior confirmed reports exist for this venue.', {
            confirmedVenueReportCount: historicalEvidence.confirmedVenueReportCount,
        }));
    }

    if (historicalEvidence.weakVenueReportCount >= 2 || historicalEvidence.adverseReviewCount >= 2) {
        score -= 10;
        factors.push(factor('Historical weak evidence', -10, 'Prior venue reports or reviews were weak/adverse.', {
            weakVenueReportCount: historicalEvidence.weakVenueReportCount,
            adverseReviewCount: historicalEvidence.adverseReviewCount,
        }));
    }

    const finalScore = clampScore(score);
    return {
        modelVersion: SCORING_MODEL_VERSION,
        score: finalScore,
        confidence: scoreZeroToOne(finalScore / 100, 0),
        status: finalScore >= 80 ? 'strong' : finalScore >= 60 ? 'moderate' : finalScore >= 45 ? 'ambiguous' : 'weak',
        factors,
    };
};

export const scoreEvidenceStrength = ({
    captureIntegrity = {},
    audioIdentification = {},
    audioDeconstruction = null,
    sourceAssessment = null,
    visualContext = {},
    rightsAndCaseContext = {},
    historicalEvidence = {},
}) => {
    let score = 25;
    const factors = [];

    if (captureIntegrity.mediaSha256) {
        score += 12;
        factors.push(factor('Media hash', 12, 'Raw media has a stored hash.'));
    }
    if (captureIntegrity.signatureStatus === 'signed_and_verified') {
        score += 14;
        factors.push(factor('Payload signature', 14, 'Capture payload signature is verified.'));
    } else {
        score -= 8;
        factors.push(factor('Payload signature missing', -8, 'Capture payload is unsigned or unverified.'));
    }
    if (captureIntegrity.clockSkewStatus === 'clear') {
        score += 6;
        factors.push(factor('Clock skew', 6, 'Capture clock skew status is clear.'));
    }

    const matchConfidence = Number(audioIdentification.matchedTrackConfidence || 0);
    if (audioIdentification.title || audioIdentification.matchedSong) {
        const effect = matchConfidence ? Math.min(16, Math.round(matchConfidence * 16)) : 8;
        score += effect;
        factors.push(factor('Song identification', effect, 'Audio identification produced a track candidate.', {
            title: audioIdentification.title || audioIdentification.matchedSong,
            confidence: matchConfidence || null,
        }));
    }

    if (sourceAssessment?.sourceClass === 'likely_pa_system') {
        const effect = Math.min(16, Math.max(8, Math.round(Number(sourceAssessment.confidence || 0.5) * 16)));
        score += effect;
        factors.push(factor('Playback source', effect, 'Source assessment supports venue-scale playback.', {
            sourceClass: sourceAssessment.sourceClass,
            confidence: sourceAssessment.confidence ?? null,
        }));
    } else if (sourceAssessment?.sourceClass) {
        score -= 8;
        factors.push(factor('Playback source risk', -8, `Source assessment is ${sourceAssessment.sourceClass}.`, {
            sourceClass: sourceAssessment.sourceClass,
        }));
    }

    if (Array.isArray(visualContext.frames) && visualContext.frames.length) {
        score += 8;
        factors.push(factor('Peak-aligned frames', 8, 'Visual frame evidence is available.', { frameCount: visualContext.frames.length }));
    }
    if ((visualContext.obstructionFlags || []).length) {
        score -= 6;
        factors.push(factor('Visual obstruction', -6, 'Visual evidence has obstruction or quality flags.', { obstructionFlags: visualContext.obstructionFlags }));
    }

    if (audioDeconstruction?.status === 'completed') {
        score += 8;
        factors.push(factor('Audio deconstruction', 8, 'Stem deconstruction completed for forensic review.'));
    } else if (audioDeconstruction?.status === 'failed') {
        score -= 4;
        factors.push(factor('Audio deconstruction failed', -4, 'Stem deconstruction was unavailable; raw audio was used.'));
    }

    const licenseStatus = cleanString(rightsAndCaseContext.licenseAssessment?.status);
    if (['unlicensed', 'expired'].includes(licenseStatus)) {
        score += 8;
        factors.push(factor('Rights context', 8, `License assessment is ${licenseStatus}.`));
    }

    if (historicalEvidence.sameVenueReports90d >= 2) {
        score += 6;
        factors.push(factor('Historical evidence density', 6, 'Multiple recent reports exist for this venue.', {
            sameVenueReports90d: historicalEvidence.sameVenueReports90d,
        }));
    }

    const finalScore = clampScore(score);
    return {
        modelVersion: SCORING_MODEL_VERSION,
        score: finalScore,
        confidence: scoreZeroToOne(finalScore / 100, 0),
        status: finalScore >= 80 ? 'strong' : finalScore >= 60 ? 'moderate' : finalScore >= 45 ? 'limited' : 'weak',
        factors,
    };
};

export const scoreLegalReadiness = ({ venueIdentityScore, evidenceStrengthScore, venueAttribution, applicationLayer, historicalEvidence = {} }) => {
    let score = Math.round((Number(venueIdentityScore?.score || 0) * 0.45) + (Number(evidenceStrengthScore?.score || 0) * 0.45));
    const factors = [
        factor('Venue identity score', Math.round(Number(venueIdentityScore?.score || 0) * 0.45), 'Weighted venue identity contribution.'),
        factor('Evidence strength score', Math.round(Number(evidenceStrengthScore?.score || 0) * 0.45), 'Weighted evidence strength contribution.'),
    ];

    if (venueAttribution?.legalBlock) {
        score -= 35;
        factors.push(factor('Legal block', -35, `Venue attribution is blocked: ${venueAttribution.status || 'unknown'}.`));
    }
    if (applicationLayer?.locationContext === 'outlet_ambiguity') {
        score -= 12;
        factors.push(factor('Outlet ambiguity', -12, 'Application layer classifies the location as outlet ambiguity.'));
    }
    if (historicalEvidence.favorableReviewCount > 0) {
        const effect = Math.min(8, historicalEvidence.favorableReviewCount * 3);
        score += effect;
        factors.push(factor('Prior favorable review', effect, 'Historical analyst review supports this venue/case pattern.'));
    }

    const finalScore = clampScore(score);
    return {
        modelVersion: SCORING_MODEL_VERSION,
        score: finalScore,
        status: finalScore >= 75 ? 'ready_for_legal' : finalScore >= 55 ? 'build_corroboration' : 'manual_review',
        factors,
    };
};

