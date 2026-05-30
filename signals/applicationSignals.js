import {
    cleanString,
    includesAnyPattern,
    scoreZeroToOne,
} from './common.js';
import { analyzeGpsTrack, buildLocationDelta } from './locationSignals.js';
import { getLatestRadioEntry } from './radioSignals.js';

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

export const buildApplicationAssessmentContext = ({
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
    const locationDelta = buildLocationDelta({ submission, venue, candidateVenues: data?.venues || [] });
    const averageAccuracyMeters = locationDelta.averageAccuracyMeters;
    const geoDistanceMeters = locationDelta.minVenueDistanceMeters;
    const geoBucket = locationDelta.geoBucket;
    const selectedVenueDistanceValues = [
        locationDelta.selectedVenueDistanceStartMeters,
        locationDelta.selectedVenueDistanceEndMeters,
    ]
        .filter((value) => value !== null && value !== undefined && value !== '')
        .map((value) => Number(value))
        .filter(Number.isFinite);
    const selectedVenueMinDistanceMeters = selectedVenueDistanceValues.length
        ? Math.min(...selectedVenueDistanceValues)
        : null;
    const selectedVenueAvgDistanceMeters = selectedVenueDistanceValues.length
        ? Math.round(selectedVenueDistanceValues.reduce((sum, value) => sum + value, 0) / selectedVenueDistanceValues.length)
        : null;
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
            selectedVenueMinDistanceMeters,
            selectedVenueAvgDistanceMeters,
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
                connected: wifiEvidence?.status === 'connected',
                status: wifiEvidence?.status || null,
                transport: wifiEvidence?.transport || null,
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

export const sanitizeApplicationAssessment = (assessment, context, fallbackModelVersion = 'application-v1') => {
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
            adjacentVenueAmbiguity: context.locationDelta.adjacentVenueAmbiguity === true,
            closestAlternateVenueCandidate: context.locationDelta.closestAlternateVenueCandidate || null,
            closestAlternateDeltaMeters: context.locationDelta.closestAlternateDeltaMeters ?? null,
            selectedVenueMinDistanceMeters: context.venue.selectedVenueMinDistanceMeters,
            selectedVenueAvgDistanceMeters: context.venue.selectedVenueAvgDistanceMeters,
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

export const buildFallbackApplicationAssessment = (context) => {
    const text = context.visual.narrativeText || '';
    const selectedMatchedAligned = Boolean(context.venue.selectedMatchedAligned);
    const sourceClass = context.audio.sourceClass;
    const sourcePersonal = ['likely_small_speaker', 'likely_personal_device'].includes(sourceClass);
    const sourcePa = sourceClass === 'likely_pa_system';
    const nearField = context.audio.nearFieldBloomSuspicion >= 1;
    const crowdCue = includesAnyPattern(text, crowdPatterns);
    const publicVenueCue = includesAnyPattern(text, publicVenuePatterns);
    const strongVenueContext = selectedMatchedAligned
        && context.capture.geoBucket === 'inside'
        && (crowdCue || publicVenueCue || context.visual.venueCueCount >= 3);
    const selectedVenueDeltaMeters = Number(context.venue.selectedVenueMinDistanceMeters);
    const selectedVenueHasDelta = Number.isFinite(selectedVenueDeltaMeters);
    const selectedVenueEnvelope = Number(context.locationDelta.accuracyEnvelopeMeters);
    const selectedVenueClose = selectedVenueHasDelta
        && selectedVenueDeltaMeters <= Math.max(45, Number.isFinite(selectedVenueEnvelope) ? selectedVenueEnvelope : 0);
    const selectedVenueVeryClose = selectedVenueHasDelta && selectedVenueDeltaMeters <= 25;
    const selectedVenueFar = selectedVenueHasDelta
        && selectedVenueDeltaMeters > Math.max(75, Number.isFinite(selectedVenueEnvelope) ? selectedVenueEnvelope * 1.4 : 0);
    const homeCue = includesAnyPattern(text, privateHomePatterns) && !strongVenueContext;
    const screenCue = includesAnyPattern(text, screenReplayPatterns) && !strongVenueContext;
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
    const adjacentVenueAmbiguity = context.locationDelta.adjacentVenueAmbiguity === true;
    const obstructionPenalty = Math.min(0.3, (context.visual.obstructionFlags.length || 0) * 0.08);
    const venueCueSupport = Math.min(0.28, context.visual.venueCueCount * 0.08);
    const venueContextMitigation = strongVenueContext ? 0.26 : 0;
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
    if (selectedVenueClose) {
        attributionConfidence += selectedVenueVeryClose ? 0.18 : 0.12;
    }
    attributionConfidence += venueCueSupport;
    if (crowdCue) {
        attributionConfidence += 0.08;
    }
    if (context.radio.wifi.connected && (context.radio.wifi.ssidPresent || context.radio.wifi.bssidPresent)) {
        attributionConfidence += 0.05;
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
    if (screenCue || homeCue || vehicleCue || trackConfirmedVehicle) {
        attributionConfidence -= 0.18;
    }
    if (context.locationDelta.withinAccuracyEnvelope === false) {
        attributionConfidence -= 0.1;
    }
    if (selectedVenueFar) {
        attributionConfidence -= 0.18;
    }
    if (anchorMismatch) {
        attributionConfidence -= 0.08;
    }
    if (adjacentVenueAmbiguity) {
        attributionConfidence -= 0.18;
    }
    attributionConfidence -= obstructionPenalty;
    attributionConfidence = scoreZeroToOne(attributionConfidence, 0.15);

    const venueAttributionRisk = scoreZeroToOne(
        (1 - attributionConfidence)
        + (context.capture.geoBucket === 'outside' ? 0.12 : 0)
        + (context.locationDelta.withinAccuracyEnvelope === false ? 0.08 : 0)
        + (selectedVenueFar ? 0.16 : 0)
        + (adjacentVenueAmbiguity ? 0.18 : 0)
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
        - installedPlaybackMitigation,
        0.3
    );
    const replayRisk = scoreZeroToOne(
        (screenCue ? 0.48 : 0)
        + (sourcePersonal ? 0.16 : 0)
        + (nearField ? 0.12 : 0)
        + (context.visual.venueCueCount === 0 ? 0.08 : 0)
        + (!crowdCue ? 0.06 : 0)
        - venueContextMitigation
        - installedPlaybackMitigation,
        0.25
    );
    const outletAmbiguityRisk = scoreZeroToOne(
        (propertyAmbiguityCue ? 0.32 : 0)
        + (anchorMismatch ? 0.22 : 0)
        + (adjacentVenueAmbiguity ? 0.24 : 0)
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
    } else if ((adjacentVenueAmbiguity || outletAmbiguityRisk >= 0.58) && context.capture.geoBucket !== 'outside') {
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
    }
    if (context.locationDelta.selectedVenueDistanceStartMeters != null || context.locationDelta.selectedVenueDistanceEndMeters != null) {
        reasons.push(`Selected venue delta: start ${context.locationDelta.selectedVenueDistanceStartMeters != null ? `${Math.round(context.locationDelta.selectedVenueDistanceStartMeters)} m` : 'n/a'} / end ${context.locationDelta.selectedVenueDistanceEndMeters != null ? `${Math.round(context.locationDelta.selectedVenueDistanceEndMeters)} m` : 'n/a'}.`);
        if (selectedVenueClose) {
            reasons.push(`Snitch-selected venue coordinate is within the capture accuracy envelope (${Math.round(selectedVenueDeltaMeters)} m minimum delta).`);
        }
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
    if (adjacentVenueAmbiguity) {
        const alternateName = context.locationDelta.closestAlternateVenueCandidate?.name || 'another nearby venue';
        reasons.push(`${alternateName} is also inside the GPS accuracy envelope; closest-pin attribution is ambiguous.`);
        edgeCaseTags.push('gps_ambiguity');
        edgeCaseTags.push('wrong_unit');
        evidenceGaps.push('Require venue-specific visual or radio corroboration before treating the closest map pin as the source.');
    }
    if (selectedVenueFar) {
        evidenceGaps.push(`Capture is ${Math.round(selectedVenueDeltaMeters)} m from the snitch-selected venue coordinate, which weakens venue attribution.`);
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
    if (sourcePersonal || nearField) {
        reasons.push('Audio source signals lean toward near-field or personal-device playback.');
    }
    if (screenCue) {
        edgeCaseTags.push('screen_replay');
        if (/\blivestream\b|\breel\b|\binstagram\b/i.test(text)) {
            edgeCaseTags.push('livestream_replay');
        }
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


export async function generateApplicationAssessment({ context, frames = [], generateText }) {
    if (typeof generateText !== 'function') {
        throw new Error('generateText function is required for application assessment.');
    }

    const parts = [];

    frames.slice(0, 3).forEach((frame, index) => {
        parts.push({
            text: `Frame ${index + 1} was captured at ${Number(frame.timestampSeconds || 0).toFixed(2)} seconds.`
        });
        parts.push({
            inlineData: {
                data: frame.buffer.toString('base64'),
                mimeType: frame.mimeType || 'image/jpeg'
            }
        });
    });
    parts.push({ text: buildApplicationAssessmentPrompt(context) });

    const text = await generateText({ parts, label: 'application assessment' });
    return sanitizeApplicationAssessment(parseModelJson(text), context, 'application-v1');
}
