// ============================================================================
// Migrate legacy collections -> canonical schema (see schema.js).
//
// Idempotent: rebuilds the canonical collections from scratch each run from the
// legacy sources of truth. Touches ONLY the canonical collections; legacy data
// (prototypeCases, submissions, reports, caseLedger, mobileUsers, ...) is left
// untouched so the running server keeps working during the transition.
//
// Reconciliation policy (World A <-> World B):
//   - prototypeCases are the authoritative CASE SPINE (richest, hand-curated).
//   - A prototypeCase whose id matches a caseLedger.reference is the SAME event:
//     we fold that ledger's corroboration reports in as ADDITIONAL submissions
//     (multi-evidence cluster). Exact-id matches only -- no fuzzy guessing.
//   - Unmatched prototypeCases become single-submission cases.
//   - Anything that cannot be reconciled is REPORTED, never silently merged.
//
// Usage:
//   node scripts/migrate-to-canonical-schema.mjs --dry-run
//   node scripts/migrate-to-canonical-schema.mjs
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    makeCompany, makeVenue, makeVenueIdentifier, makeSnitcher, makeSnitcherDevice,
    makeEvidenceSubmission, makeCase, makeCaseEvent,
    IDENTIFIER_TYPE, IDENTIFIER_STATUS, CASE_STAGE, CASE_FLAG, CASE_EVENT_TYPE, ACTOR_TYPE,
} from '../schema.js';
import { normalizeBssid, canonicalVenueKey } from '../venueFingerprints.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '..', 'data', 'platform-db.json');
const dryRun = process.argv.includes('--dry-run');

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const lc = (s) => String(s || '').trim().toLowerCase();
const report = [];
const note = (msg) => report.push(msg);

const data = await readJson(dbPath);

// ---------------------------------------------------------------------------
// Fresh canonical collections (rebuilt every run).
// ---------------------------------------------------------------------------
const companies = [];
const venues = [];
const venueIdentifiers = [];
const snitchers = [];
const snitcherDevices = [];
const evidenceSubmissions = [];
const cases = [];
const caseEvents = [];

// ---------------------------------------------------------------------------
// 1. snitchers  <-  mobileUsers
// ---------------------------------------------------------------------------
const snitcherByLegacyId = new Map();
for (const mu of data.mobileUsers || []) {
    const s = makeSnitcher({
        id: mu.id,
        email: mu.email || null,
        phone: mu.phone || null,
        displayName: mu.displayName || null,
        referralCode: mu.referralCode || null,
        trustTier: mu.trustTier || 'new',
        status: mu.status || 'active',
        restrictions: mu.restrictions || [],
        passwordSalt: mu.passwordSalt || null,
        passwordHash: mu.passwordHash || null,
    });
    s.submissionCount = mu.submissionCount || 0;
    s.confirmedCount = mu.confirmedCount || 0;
    s.totalRewardsInr = mu.totalRewardsInr || 0;
    s.createdAt = mu.createdAt || s.createdAt;
    snitchers.push(s);
    snitcherByLegacyId.set(mu.id, s.id);
}

// ---------------------------------------------------------------------------
// 2. snitcherDevices  <-  anonymousInstalls + chainOfCustody deviceIds
// ---------------------------------------------------------------------------
const deviceByInstallId = new Map();
const ensureDevice = ({ installId = null, deviceId = null, platform = null, trustBand = null, snitcherId = null }) => {
    const key = installId || deviceId;
    if (!key) return null;
    if (deviceByInstallId.has(key)) return deviceByInstallId.get(key);
    const dev = makeSnitcherDevice({
        snitcherId,
        installId: installId || deviceId,
        platform,
        deviceTrustBand: trustBand,
    });
    snitcherDevices.push(dev);
    deviceByInstallId.set(key, dev.id);
    return dev.id;
};
for (const inst of data.anonymousInstalls || []) {
    ensureDevice({ installId: inst.installId, platform: inst.appVersion ? 'mobile' : null, trustBand: inst.abuseScore != null ? null : null });
}

// ---------------------------------------------------------------------------
// 3. companies  <-  merchantMaster (carries legalEntityName / gstin / venueType)
//    and an index from legacy venueId/placeProviderId so venues can link up.
// ---------------------------------------------------------------------------
const companyByMerchantKey = new Map(); // venueId or placeProviderId -> companyId
const merchantByVenueId = new Map();
const merchantByPlaceId = new Map();
for (const m of data.merchantMaster || []) {
    const co = makeCompany({
        legalName: m.legalEntityName || null,
        holdingCompanyName: m.legalEntityName || null,
        brandNames: m.venueName ? [m.venueName] : [],
        registrationNo: m.gstin || null,
        jurisdiction: 'IN',
        status: 'active',
    });
    co.createdAt = m.createdAt || co.createdAt;
    // metadata that has no home on company/venue yet -> stash for later, non-authoritative
    co.legacyVenueProfile = {
        venueType: m.venueType || null,
        cityTier: m.cityTier || null,
        outletCount: m.outletCount ?? null,
        hotelStarClass: m.hotelStarClass || null,
        eventCapability: m.eventCapability || null,
        rightsLayersApplicable: m.rightsLayersApplicable || [],
    };
    companies.push(co);
    if (m.venueId) { companyByMerchantKey.set(m.venueId, co.id); merchantByVenueId.set(m.venueId, m); }
    if (m.placeProviderId) { companyByMerchantKey.set(m.placeProviderId, co.id); merchantByPlaceId.set(m.placeProviderId, m); }
}

// ---------------------------------------------------------------------------
// 4. venues  <-  upsert from prototypeCase candidates/locations + existing venues.
//    Keyed by canonicalVenueKey (place:<id> | name:<normalized>).
// ---------------------------------------------------------------------------
const venueByKey = new Map();
const upsertVenue = ({ placeProviderId = null, name = null, address = null, city = null, lat = null, lng = null }) => {
    const key = canonicalVenueKey({ placeProviderId, name });
    if (!key) return null;
    if (venueByKey.has(key)) {
        const existing = venueByKey.get(key);
        // enrich if we now have a Place ID / address we didn't before
        if (placeProviderId && !existing.placeProviderId) existing.placeProviderId = placeProviderId;
        if (address && !existing.address) existing.address = address;
        if (city && !existing.city) existing.city = city;
        existing.lastSeenAt = new Date().toISOString();
        return existing;
    }
    const companyId = (placeProviderId && companyByMerchantKey.get(placeProviderId)) || null;
    const v = makeVenue({
        companyId,
        placeProviderId: placeProviderId || null,
        fallbackKey: placeProviderId ? null : key.replace(/^name:/, ''),
        name, address, city,
        latitude: lat, longitude: lng,
    });
    venues.push(v);
    venueByKey.set(key, v);
    return v;
};

// Seed from prototypeCase candidates (rich: have Place IDs) and locations.
for (const c of data.prototypeCases || []) {
    const cands = c?.venueAttribution?.nearbyVenueCandidates || c?.locationDelta?.nearbyVenueCandidates || [];
    for (const cand of cands) {
        upsertVenue({
            placeProviderId: cand.placeProviderId || null,
            name: cand.name, address: cand.address || null, city: cand.city || null,
            lat: cand.lat ?? null, lng: cand.lng ?? null,
        });
    }
    if (c?.location?.name) {
        upsertVenue({
            placeProviderId: null,
            name: c.location.name, address: c.location.address || null, city: c.location.city || null,
            lat: c.location.lat ?? null, lng: c.location.lng ?? null,
        });
    }
}

const findVenueByName = (name) => {
    if (!name) return null;
    return venueByKey.get(canonicalVenueKey({ name }))
        || venues.find((v) => lc(v.name) === lc(name))
        || null;
};

// ---------------------------------------------------------------------------
// 5. venueIdentifiers
//    (a) approved  <-  venueFingerprints (already trusted by the backfill)
//    (b) proposed  <-  each case's radioContext wifi bssid/ssid + Place ID
// ---------------------------------------------------------------------------
for (const fp of data.venueFingerprints || []) {
    const venue = (fp.placeProviderId && venueByKey.get(`place:${fp.placeProviderId}`))
        || findVenueByName(fp.venueName);
    if (!venue) { note(`identifier(approved) skipped: no venue for fingerprint ${fp.bssid} -> ${fp.venueName}`); continue; }
    venueIdentifiers.push(makeVenueIdentifier({
        venueId: venue.id,
        type: IDENTIFIER_TYPE.WIFI_BSSID,
        value: fp.bssid,
        normalizedValue: normalizeBssid(fp.bssid),
        status: IDENTIFIER_STATUS.APPROVED,
        sourceCaseId: fp.caseIds?.[0] || null,
        corroboratingCaseIds: fp.caseIds || [],
        proposedBy: ACTOR_TYPE.SYSTEM,
        reviewedBy: 'migration:backfilled-trusted',
        reviewedAt: new Date().toISOString(),
        decisionNote: 'Imported as approved from the trusted venueFingerprints backfill.',
    }));
}

// ---------------------------------------------------------------------------
// 6 + 7. evidenceSubmissions + cases (the spine)
// ---------------------------------------------------------------------------
const ledgerByRef = new Map((data.caseLedger || []).map((l) => [l.reference, l]));
const reportById = new Map((data.reports || []).map((r) => [r.id, r]));
const submissionById = new Map((data.submissions || []).map((s) => [s.id, s]));

const rightsOrgFromAssociation = (assoc) => {
    const a = lc(assoc);
    if (a.includes('iprs') || a.includes('collective')) return 'org_collective_iprs';
    if (a.includes('saregama') || a.includes('label')) return 'org_label_saregama';
    return null;
};

const deriveStageAndFlags = (c, ledger) => {
    const flags = [];
    const sourceClass = lc(c?.sourceAssessment?.sourceClass);
    const vaStatus = lc(c?.venueAttribution?.status);
    const licenseStatus = lc(c?.licenseResolution?.license_status || ledger?.licenseStatus);
    const songResolved = Boolean(c?.songAssessment?.title) && Boolean(c?.songAssessment?.isrc);

    const nonMusic = ['no_music', 'speech_ambience', 'tv_screen'].includes(sourceClass);
    const coordinateOnly = vaStatus === 'coordinate_only' || /^approx\. venue/i.test(c?.location?.name || '');

    let stage = CASE_STAGE.NEW;
    if (nonMusic || coordinateOnly) stage = CASE_STAGE.BAD_CASE;
    else if (!songResolved) { stage = CASE_STAGE.MONITOR_ENRICH; flags.push(CASE_FLAG.SONG_UNRESOLVED); }

    if (!licenseStatus || licenseStatus === 'unknown') flags.push(CASE_FLAG.PENDING_LICENSE_VERIFICATION);
    if (['wrong_venue_or_unit', 'adjacent_venue_ambiguous', 'same_building_unresolved_unit'].includes(vaStatus)) {
        flags.push(CASE_FLAG.VENUE_DISCREPANCY_FLAGGED);
    }
    return { stage, flags };
};

let multiEvidenceCount = 0;

for (const c of data.prototypeCases || []) {
    const ledger = ledgerByRef.get(c.id) || null;
    const resolvedVenue = findVenueByName(c?.venueAttribution?.matchedVenue || c?.location?.name);
    const companyId = resolvedVenue?.companyId
        || (ledger?.merchantMasterId && companyByMerchantKey.get(ledger?.venueId))
        || null;

    // --- primary submission (the prototypeCase capture itself) ---
    const sa = c?.sourceAssessment || {};
    const song = c?.songAssessment || {};
    const songResolved = Boolean(song.title) && Boolean(song.isrc);
    const deviceId = ensureDevice({
        deviceId: c?.chainOfCustody?.[0]?.deviceId || null,
        installId: ledger?.primaryInstallId || null,
    });

    const primary = makeEvidenceSubmission({
        reference: c.id,
        snitcherId: null, // prototypeCases carry no snitcher link (chainOfCustody is device-only)
        deviceId,
        claimedVenueName: c?.location?.name || null,
        claimedLat: c?.location?.lat ?? null,
        claimedLng: c?.location?.lng ?? null,
        claimedAddress: c?.location?.address || null,
        claimedCity: c?.location?.city || null,
        capturedAt: c?.timestamp || null,
        assetIds: c?.videoProofUrl ? [c.videoProofUrl.split('/').pop()] : [],
    });
    primary.sourceClass = sa.sourceClass || null;
    primary.supportsVenuePlayback = sa.supportsVenuePlayback ?? null;
    primary.songMatchStatus = songResolved ? 'matched' : 'unresolved';
    primary.matchedTrackId = null; // no catalog match for these fixtures
    primary.matchedTrackConfidence = null;
    primary.resolvedVenueId = resolvedVenue?.id || null;
    // venueResolutionRecommendation / discrepancySeverity / evidenceValidity /
    // enforcementReadiness are DERIVED -> populated by the CRM read-path step.
    primary.raw = {
        radioContext: c?.radioContext || null,
        geolocationDelta: c?.locationDelta || null,
        sourceAssessment: c?.sourceAssessment || null,
        songAssessment: c?.songAssessment || null,
        venueAttribution: c?.venueAttribution || null,
        trustGates: c?.trustGates || null,
        aiExplanation: c?.aiExplanation || null,
        absoluteProof: c?.absoluteProof || null,
        // Full source record preserved during transition so the CRM read path
        // can render losslessly while typed columns are still being pulled out.
        legacyCase: c,
    };
    primary.status = 'processed';
    evidenceSubmissions.push(primary);

    const submissionIds = [primary.id];

    // --- fold in caseLedger corroboration reports as ADDITIONAL submissions ---
    if (ledger && Array.isArray(ledger.corroborationReportIds) && ledger.corroborationReportIds.length) {
        for (const repId of ledger.corroborationReportIds) {
            const rep = reportById.get(repId);
            if (!rep) { note(`case ${c.id}: corroboration report ${repId} not found`); continue; }
            const sub = submissionById.get(rep.submissionId);
            const corr = makeEvidenceSubmission({
                reference: rep.reference || repId,
                snitcherId: sub?.installId ? (snitcherByLegacyId.get(sub.installId) || null) : null,
                deviceId: ensureDevice({ installId: sub?.installId || null }),
                claimedVenueName: c?.location?.name || null,
                capturedAt: rep.createdAt || sub?.createdAt || null,
                assetIds: sub?.rawVideoAssetId ? [sub.rawVideoAssetId] : [],
            });
            corr.sourceClass = rep?.sourceAnalysis?.sourceClass || null;
            corr.resolvedVenueId = resolvedVenue?.id || null;
            corr.status = 'processed';
            corr.raw = { sourceAnalysis: rep?.sourceAnalysis || null, fromLegacyReport: repId };
            evidenceSubmissions.push(corr);
            submissionIds.push(corr.id);
        }
        if (submissionIds.length > 1) multiEvidenceCount += 1;
    }

    // --- the case (cluster) ---
    const { stage, flags } = deriveStageAndFlags(c, ledger);
    const caseRec = makeCase({
        id: c.id,
        reference: c.id,
        resolvedVenueId: resolvedVenue?.id || null,
        companyId,
        stage,
        statusFlags: flags,
        primarySubmissionId: primary.id,
        submissionIds,
        pastOffences: c?.pastOffences || 0,
        licenseStatus: lc(c?.licenseResolution?.license_status || ledger?.licenseStatus) || 'unknown',
        licenseSource: c?.licenseResolution?.license_source || ledger?.licenseSource || null,
        rightsOwnerOrgId: rightsOrgFromAssociation(song.rightsAssociation) || ledger?.rightsOwnerOrgId || null,
        matchedTrackId: null,
        recoverableValue: Number(c?.recoverableValue || ledger?.estimatedRecoverableValueInr || 0),
    });
    caseRec.openedAt = c?.timestamp || caseRec.openedAt;
    cases.push(caseRec);

    // backfill submission.caseId now that the case exists
    for (const sid of submissionIds) {
        const s = evidenceSubmissions.find((e) => e.id === sid);
        if (s) s.caseId = caseRec.id;
    }

    // --- case events: intake + chain of custody ---
    caseEvents.push(makeCaseEvent({
        caseId: caseRec.id, eventType: CASE_EVENT_TYPE.STAGE_CHANGE,
        fromStage: null, toStage: stage, actorType: ACTOR_TYPE.SYSTEM, actorId: 'migration',
        payload: { reason: 'Migrated from prototypeCases', evidenceCount: submissionIds.length, reconciledWithLedger: Boolean(ledger) },
    }));
    for (const coc of c?.chainOfCustody || []) {
        caseEvents.push(makeCaseEvent({
            caseId: caseRec.id, eventType: CASE_EVENT_TYPE.CUSTODY,
            actorType: ACTOR_TYPE.SNITCHER, actorId: coc.actor || null,
            payload: { event: coc.event, hash: coc.hash, deviceId: coc.deviceId, status: coc.status, timestamp: coc.timestamp },
        }));
    }

    // --- (b) proposed venue identifiers from this case's radio context ---
    const wifi = c?.radioContext?.wifi || {};
    const selectedCand = (c?.venueAttribution?.nearbyVenueCandidates || []).find((x) => x.isSelectedVenue) || null;
    const proposeFor = resolvedVenue || (selectedCand && findVenueByName(selectedCand.name));
    if (proposeFor && normalizeBssid(wifi.bssid)) {
        const alreadyApproved = venueIdentifiers.some((vi) =>
            vi.type === IDENTIFIER_TYPE.WIFI_BSSID && vi.normalizedValue === normalizeBssid(wifi.bssid) && vi.venueId === proposeFor.id);
        if (!alreadyApproved) {
            venueIdentifiers.push(makeVenueIdentifier({
                venueId: proposeFor.id, type: IDENTIFIER_TYPE.WIFI_BSSID,
                value: wifi.bssid, normalizedValue: normalizeBssid(wifi.bssid),
                status: IDENTIFIER_STATUS.PROPOSED, sourceCaseId: c.id, sourceSubmissionId: primary.id,
                decisionNote: 'Proposed from capture radio context; awaiting admin approval.',
            }));
        }
    }
    if (proposeFor && wifi.ssid) {
        venueIdentifiers.push(makeVenueIdentifier({
            venueId: proposeFor.id, type: IDENTIFIER_TYPE.WIFI_SSID,
            value: wifi.ssid, normalizedValue: lc(wifi.ssid),
            status: IDENTIFIER_STATUS.PROPOSED, sourceCaseId: c.id, sourceSubmissionId: primary.id,
            decisionNote: 'Proposed from capture radio context; awaiting admin approval.',
        }));
    }
}

// ---------------------------------------------------------------------------
// Write canonical collections back (canonical only; legacy untouched).
// ---------------------------------------------------------------------------
Object.assign(data, {
    companies, venues, venueIdentifiers, snitchers, snitcherDevices,
    evidenceSubmissions, cases, caseEvents,
});

if (!dryRun) {
    await fs.writeFile(dbPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const matched = (data.prototypeCases || []).filter((c) => ledgerByRef.has(c.id)).map((c) => c.id);
const unmatched = (data.prototypeCases || []).filter((c) => !ledgerByRef.has(c.id)).map((c) => c.id);

console.log(`Canonical migration${dryRun ? ' (dry run)' : ''}.`);
console.log('Counts:');
console.log(`  companies:           ${companies.length}`);
console.log(`  venues:              ${venues.length}`);
console.log(`  venueIdentifiers:    ${venueIdentifiers.length}  (${venueIdentifiers.filter((v) => v.status === 'approved').length} approved, ${venueIdentifiers.filter((v) => v.status === 'proposed').length} proposed)`);
console.log(`  snitchers:           ${snitchers.length}`);
console.log(`  snitcherDevices:     ${snitcherDevices.length}`);
console.log(`  evidenceSubmissions: ${evidenceSubmissions.length}`);
console.log(`  cases:               ${cases.length}  (${multiEvidenceCount} multi-evidence clusters)`);
console.log(`  caseEvents:          ${caseEvents.length}`);
console.log('');
console.log(`Reconciliation: ${matched.length} cases matched a caseLedger ref, ${unmatched.length} standalone.`);
console.log(`  matched:   ${matched.join(', ')}`);
console.log(`  standalone:${unmatched.join(', ')}`);
console.log('');
console.log('Stage distribution:');
const byStage = {};
for (const cs of cases) byStage[cs.stage] = (byStage[cs.stage] || 0) + 1;
for (const [k, v] of Object.entries(byStage)) console.log(`  ${k}: ${v}`);
if (report.length) {
    console.log('\nNotes / unreconciled:');
    for (const r of report) console.log(`- ${r}`);
}
