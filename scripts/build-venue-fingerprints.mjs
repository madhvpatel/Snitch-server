// Rebuild the venue hardware-fingerprint registry (data/platform-db.json
// `venueFingerprints`) from trusted case observations.
//
// TRUST RULE (conservative): record a BSSID -> venue binding only when the
// snitcher's *selected* venue is independently corroborated by the connected
// Wi-Fi SSID text. That is, both the human's pick AND the network name agree.
// We never seed the registry from a case whose selection is itself in question
// (SSID points elsewhere) -- those become the discrepancies the registry is
// meant to surface, not ground truth. The registry is fully derived: this script
// can be re-run from scratch at any time and is idempotent (de-dupes by caseId).
//
// Usage:
//   node scripts/build-venue-fingerprints.mjs            # rebuild + write
//   node scripts/build-venue-fingerprints.mjs --dry-run  # report only

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    scoreVenueCueMatch,
    upsertVenueFingerprint,
    normalizeBssid,
} from '../venueFingerprints.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const dbPath = path.join(serverDir, 'data', 'platform-db.json');

const dryRun = process.argv.includes('--dry-run');

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'));

// Same placeholder filter the resolver uses: ignore SSIDs that carry no venue
// identity (emulator networks, "not connected", etc.).
const isUsableWifiCue = (text) => Boolean(text)
    && !/^connected context|^not connected|context captured/i.test(text)
    && !/^androidwifi$/i.test(text.trim());

const getWifiSummary = (c) => (
    c?.radioContext?.wifi?.summary || c?.radioContext?.wifi?.ssid || ''
);

const getCandidates = (c) => (
    c?.venueAttribution?.nearbyVenueCandidates
    || c?.locationDelta?.nearbyVenueCandidates
    || []
);

const data = await readJson(dbPath);
const cases = data.prototypeCases || [];

// Always rebuild from scratch so the registry stays a pure function of the cases.
const registry = [];

let scanned = 0;
let recorded = 0;
let skippedNoBssid = 0;
let skippedNoSsidMatch = 0;
const notes = [];

for (const c of cases) {
    const caseId = c?.id || c?.reference;
    const bssid = c?.radioContext?.wifi?.bssid;
    const ssidText = getWifiSummary(c);
    const selectedName = c?.venueAttribution?.targetVenue || c?.location?.name || '';

    if (!caseId) continue;
    scanned += 1;

    if (!normalizeBssid(bssid)) {
        skippedNoBssid += 1;
        continue;
    }
    if (!isUsableWifiCue(ssidText)) {
        skippedNoSsidMatch += 1;
        notes.push(`${caseId}: BSSID present but SSID '${ssidText || ''}' is not a usable venue cue -> skipped.`);
        continue;
    }

    // Does the connected SSID independently corroborate the user's selected venue?
    const candidates = getCandidates(c);
    const selectedCandidate = candidates.find((cand) => cand?.name === selectedName)
        || { name: selectedName, placeProviderId: null };
    const selectedSupport = scoreVenueCueMatch(selectedName, ssidText).score;

    // Best-supported candidate by SSID, to confirm the selection is also the leader.
    let bestName = selectedName;
    let bestSupport = selectedSupport;
    for (const cand of candidates) {
        const s = scoreVenueCueMatch(cand?.name, ssidText).score;
        if (s > bestSupport) {
            bestSupport = s;
            bestName = cand?.name;
        }
    }

    const ssidConfirmsSelection = selectedSupport > 0 && bestName === selectedName;
    if (!ssidConfirmsSelection) {
        skippedNoSsidMatch += 1;
        notes.push(`${caseId}: SSID '${ssidText}' does not confirm selected '${selectedName}' (support ${selectedSupport}, leader '${bestName}') -> skipped (this is a discrepancy, not ground truth).`);
        continue;
    }

    upsertVenueFingerprint(registry, {
        placeProviderId: selectedCandidate.placeProviderId || null,
        venueName: selectedName,
        address: c?.location?.address || null,
        city: c?.location?.city || null,
        bssid,
        ssid: c?.radioContext?.wifi?.ssid || null,
        caseId,
        observedAt: c?.timestamp || c?.capturedAt || null,
    });
    recorded += 1;
    notes.push(`${caseId}: recorded ${normalizeBssid(bssid)} -> ${selectedName} (SSID support ${selectedSupport}).`);
}

data.venueFingerprints = registry;

if (!dryRun) {
    await fs.writeFile(dbPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

console.log(`Venue fingerprint backfill${dryRun ? ' (dry run)' : ''}.`);
console.log(`Scanned ${scanned} case(s). Recorded ${recorded} observation(s) across ${registry.length} fingerprint record(s).`);
console.log(`Skipped: ${skippedNoBssid} without BSSID, ${skippedNoSsidMatch} without confirming SSID.`);
console.log('Registry:');
for (const r of registry) {
    console.log(`- ${r.bssid} -> ${r.venueName} [${r.placeProviderId || 'no-place-id'}] (${r.caseIds.length} case(s): ${r.caseIds.join(', ')})`);
}
if (notes.length) {
    console.log('Notes:');
    for (const n of notes) console.log(`- ${n}`);
}
