import {
    LICENSE_STATUSES,
    evaluateCaseReadiness,
    evaluateLitigationEligibility,
    getReadinessBand,
} from '../signals/enforcementReadiness.js';

const checks = [];
const addCheck = (label, actual, expected) => {
    checks.push({ label, actual, expected, pass: actual === expected });
};

[
    [49, 'INSUFFICIENT_EVIDENCE'],
    [50, 'MONITOR_ENRICH'],
    [67, 'MONITOR_ENRICH'],
    [68, 'CASE_CANDIDATE'],
    [79, 'CASE_CANDIDATE'],
    [80, 'ESCALATION_READY'],
    [89, 'ESCALATION_READY'],
    [90, 'LITIGATION_READY'],
].forEach(([score, expected]) => addCheck(`readiness boundary ${score}`, getReadinessBand(score).value, expected));

const baseCase = {
    id: 'CASE-READY',
    qualityScore: 95,
    videoProofUrl: '/media/raw-video/example.mov',
    trustGates: { mediaHashKey: true },
    absoluteProof: { venueImages: ['/media/video-frame/example.jpg'] },
    venueAttribution: { status: 'target_venue_supported', legalBlock: false },
    venueContext: { matchedVenue: { id: 'venue-1', name: 'Venue One' } },
    scoring: {
        venueIdentityScore: { score: 95, confidence: 0.95 },
        evidenceStrengthScore: { score: 96, confidence: 0.96 },
        legalReadinessScore: { score: 100 },
    },
    historicalEvidence: { confirmedVenueReportCount: 1 },
};

const eligible = evaluateLitigationEligibility({
    caseView: baseCase,
    licenseResolution: { license_status: LICENSE_STATUSES.UNLICENSED },
});
addCheck('eligible case can submit', eligible.can_send_to_litigation, true);
addCheck('eligible case band', eligible.readiness.readiness_band, 'LITIGATION_READY');

const blockedCase = {
    ...baseCase,
    venueAttribution: { status: 'adjacent_venue_ambiguous', legalBlock: true },
    scoring: {
        ...baseCase.scoring,
        legalReadinessScore: { score: 72 },
    },
};
const blocked = evaluateLitigationEligibility({
    caseView: blockedCase,
    licenseResolution: { license_status: LICENSE_STATUSES.UNKNOWN },
});
addCheck('blocked case cannot submit', blocked.can_send_to_litigation, false);
addCheck('unknown license blocks', blocked.blocking_reasons.some((entry) => entry.code === 'RIGHTS_LICENSE_STATUS_RESOLVED'), true);
addCheck('ambiguous venue blocks', blocked.blocking_reasons.some((entry) => entry.code === 'VENUE_IDENTITY_RESOLVED'), true);

const readiness = evaluateCaseReadiness({
    caseView: blockedCase,
    licenseResolution: { license_status: LICENSE_STATUSES.UNKNOWN },
});
addCheck('blocked readiness has next actions', readiness.next_actions.length > 0, true);

for (const check of checks) {
    console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.label}: ${check.actual} expected ${check.expected}`);
}

if (checks.some((check) => !check.pass)) {
    process.exitCode = 1;
}
