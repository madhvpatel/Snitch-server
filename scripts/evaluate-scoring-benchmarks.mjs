import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildLocationDelta } from '../signals/locationSignals.js';
import {
    buildHistoricalEvidenceContext,
    scoreEvidenceStrength,
    scoreLegalReadiness,
    scoreVenueIdentity,
} from '../signals/evidenceScoring.js';
import { inferVenueAttribution } from '../signals/venueAttribution.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchmarkPath = path.join(serverRoot, 'scoring/benchmarks/venue-evidence-benchmarks.json');
const benchmarks = JSON.parse(await fs.readFile(benchmarkPath, 'utf8'));

const check = (label, actual, expected) => ({ label, actual, expected, pass: actual === expected });
const checkMin = (label, actual, expected) => ({ label, actual, expected: `>= ${expected}`, pass: Number(actual) >= Number(expected) });
const checkMax = (label, actual, expected) => ({ label, actual, expected: `<= ${expected}`, pass: Number(actual) <= Number(expected) });

const results = benchmarks.map((benchmark) => {
    const data = {
        venues: benchmark.candidateVenues || [],
        reports: benchmark.history?.reports || [],
        submissions: benchmark.history?.submissions || [],
        caseLedger: benchmark.history?.caseLedger || [],
        reviewLedger: benchmark.history?.reviewLedger || [],
    };
    const report = {
        id: `${benchmark.id}-report`,
        venueId: benchmark.venue?.id || null,
        createdAt: '2026-05-29T00:00:00.000Z',
    };
    const locationDelta = buildLocationDelta({
        submission: benchmark.submission,
        venue: benchmark.venue,
        candidateVenues: benchmark.candidateVenues || [],
    });
    const historicalEvidence = buildHistoricalEvidenceContext({
        data,
        report,
        submission: benchmark.submission,
        venue: benchmark.venue,
        caseRecord: null,
        reviews: [],
        now: new Date('2026-05-29T00:00:00.000Z'),
    });
    const venueAttribution = inferVenueAttribution({
        evidencePackage: { locationDelta, visualContext: benchmark.visualContext || {} },
        matchedVenue: benchmark.venue,
        selectedVenue: benchmark.submission?.selectedVenue || null,
    });
    const venueIdentityScore = scoreVenueIdentity({
        locationDelta,
        visualContext: benchmark.visualContext || {},
        radioContext: benchmark.radioContext || {},
        venueContext: {
            selectedVenue: benchmark.submission?.selectedVenue || null,
            matchedVenue: benchmark.venue || null,
        },
        historicalEvidence,
    });
    const evidenceStrengthScore = scoreEvidenceStrength({
        captureIntegrity: benchmark.captureIntegrity || {},
        audioIdentification: benchmark.audioIdentification || {},
        audioDeconstruction: benchmark.audioDeconstruction || null,
        sourceAssessment: benchmark.sourceAssessment || null,
        visualContext: benchmark.visualContext || {},
        rightsAndCaseContext: benchmark.rightsAndCaseContext || {},
        historicalEvidence,
    });
    const legalReadinessScore = scoreLegalReadiness({
        venueIdentityScore,
        evidenceStrengthScore,
        venueAttribution,
        applicationLayer: locationDelta.adjacentVenueAmbiguity ? { locationContext: 'outlet_ambiguity' } : null,
        historicalEvidence,
    });

    const checks = [
        check('adjacentVenueAmbiguity', locationDelta.adjacentVenueAmbiguity, benchmark.expected.adjacentVenueAmbiguity),
        check('venueAttributionStatus', venueAttribution.status, benchmark.expected.venueAttributionStatus),
        check('legalReadinessStatus', legalReadinessScore.status, benchmark.expected.legalReadinessStatus),
    ];
    if (benchmark.expected.venueIdentityMinScore != null) {
        checks.push(checkMin('venueIdentityScore', venueIdentityScore.score, benchmark.expected.venueIdentityMinScore));
    }
    if (benchmark.expected.venueIdentityMaxScore != null) {
        checks.push(checkMax('venueIdentityScore', venueIdentityScore.score, benchmark.expected.venueIdentityMaxScore));
    }

    return {
        id: benchmark.id,
        pass: checks.every((entry) => entry.pass),
        checks,
        scores: {
            venueIdentity: venueIdentityScore.score,
            evidenceStrength: evidenceStrengthScore.score,
            legalReadiness: legalReadinessScore.score,
        },
    };
});

for (const result of results) {
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.id}`);
    console.log(`  scores: venue=${result.scores.venueIdentity} evidence=${result.scores.evidenceStrength} legal=${result.scores.legalReadiness}`);
    for (const entry of result.checks) {
        console.log(`  ${entry.pass ? 'OK' : 'NO'} ${entry.label}: ${entry.actual} expected ${entry.expected}`);
    }
}

if (results.some((result) => !result.pass)) {
    process.exitCode = 1;
}
