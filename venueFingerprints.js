// Venue hardware fingerprint registry.
//
// A Wi-Fi access point's BSSID (the AP's MAC address) is a stable, per-venue
// hardware fingerprint: unlike an SSID it is hard to spoof casually and does not
// change when a venue renames its network. This module maintains a derived,
// rebuildable registry mapping BSSID -> venue, accumulated only from *trusted*
// case confirmations. It is intentionally pure (no I/O): the caller owns
// persistence (platform-db.json `venueFingerprints`) and the trust decision
// about which cases may contribute an observation.
//
// POLICY: this registry is a corroboration signal for the review-only resolver.
// It never auto-corrects a snitcher's selected venue. A BSSID match raises the
// system's recommendation/discrepancy confidence; a human still confirms.

const cleanString = (value) => (value || '').trim().toLowerCase();

// Generic words that should never, on their own, identify a venue. A token match
// on one of these is near-worthless for telling two nearby venues apart, so they
// are kept (a faint signal) but heavily down-weighted rather than dropped.
export const VENUE_TOKEN_STOPLIST = new Set([
    'the', 'and', 'for', 'with', 'cafe', 'coffee', 'restaurant', 'tavern', 'bar',
    'pub', 'club', 'lounge', 'kitchen', 'grill', 'house', 'bistro', 'eatery',
    'roasters', 'roastery', 'estate', 'street', 'road', 'avenue', 'sports',
    'venue', 'area', 'down', 'room', 'hotel', 'inn', 'place', 'food', 'drinks',
    'company', 'co', 'ltd', 'inc',
]);

const tokenizeVenueCueText = (value) => cleanString(value)
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

// Distinctive tokens (longer, not generic) carry more weight; a hit on a generic
// word like "coffee" or "bar" barely moves the score, while a hit on "taphaus"
// or "macdougal" is strong evidence.
const venueTokenWeight = (token) => {
    if (VENUE_TOKEN_STOPLIST.has(token)) return 0.15;
    if (token.length >= 7) return 2;
    if (token.length >= 4) return 1;
    return 0.5;
};

// Scores how well a free-text cue (Wi-Fi SSID, visual signage narrative, ...)
// supports a given venue name. Returns { score, matchedTokens }.
export const scoreVenueCueMatch = (venueName, cueText) => {
    const normalizedCue = cleanString(cueText);
    if (!normalizedCue) {
        return { score: 0, matchedTokens: [] };
    }
    const matchedTokens = [];
    let score = 0;
    for (const token of tokenizeVenueCueText(venueName)) {
        if (normalizedCue.includes(token)) {
            score += venueTokenWeight(token);
            matchedTokens.push(token);
        }
    }
    return { score: Number(score.toFixed(2)), matchedTokens };
};

// Normalize a BSSID to lowercase colon-separated form. Accepts colon, dash, or
// bare 12-hex input. Returns null if it is not a plausible MAC.
export const normalizeBssid = (bssid) => {
    if (typeof bssid !== 'string') return null;
    const hex = bssid.toLowerCase().replace(/[^0-9a-f]/g, '');
    if (hex.length !== 12) return null;
    return hex.match(/.{2}/g).join(':');
};

const normalizeName = (name) => String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Canonical key for a venue. Google Place IDs are the canonical identity when
// available; otherwise fall back to a normalized name so two cases for the same
// named venue still collapse onto one fingerprint record.
export const canonicalVenueKey = ({ placeProviderId, name } = {}) => {
    if (placeProviderId) return `place:${placeProviderId}`;
    const normalized = normalizeName(name);
    return normalized ? `name:${normalized}` : null;
};

const emptyObservation = () => ({ caseIds: [], firstObservedAt: null, lastObservedAt: null });

// Record one (bssid -> venue) observation from a trusted case. Mutates and
// returns the registry array. De-duplicates by caseId so re-running the backfill
// is idempotent and does not inflate corroboration counts.
export const upsertVenueFingerprint = (registry, {
    placeProviderId = null,
    venueName = null,
    address = null,
    city = null,
    bssid,
    ssid = null,
    caseId,
    observedAt = null,
} = {}) => {
    const list = Array.isArray(registry) ? registry : [];
    const normBssid = normalizeBssid(bssid);
    const venueKey = canonicalVenueKey({ placeProviderId, name: venueName });
    if (!normBssid || !venueKey || !caseId) {
        return list;
    }

    let record = list.find((entry) => entry.bssid === normBssid && entry.venueKey === venueKey);
    if (!record) {
        record = {
            bssid: normBssid,
            venueKey,
            placeProviderId: placeProviderId || null,
            venueName: venueName || null,
            address: address || null,
            city: city || null,
            ssids: [],
            ...emptyObservation(),
        };
        list.push(record);
    }

    // Refresh best-known venue metadata (later trusted observations win).
    if (placeProviderId) record.placeProviderId = placeProviderId;
    if (venueName) record.venueName = venueName;
    if (address) record.address = address;
    if (city) record.city = city;
    if (ssid && !record.ssids.includes(ssid)) record.ssids.push(ssid);

    if (!record.caseIds.includes(caseId)) {
        record.caseIds.push(caseId);
    }
    const ts = observedAt || new Date().toISOString();
    if (!record.firstObservedAt || ts < record.firstObservedAt) record.firstObservedAt = ts;
    if (!record.lastObservedAt || ts > record.lastObservedAt) record.lastObservedAt = ts;

    return list;
};

// Look up which venue(s) a BSSID has been fingerprinted to. `excludeCaseId`
// drops the calling case's own observation so a case cannot self-confirm; only
// *independent* corroborating cases count. Returns the matching records (with
// their independent corroboration count), strongest first, or [] if none.
export const lookupVenueByBssid = (registry, bssid, { excludeCaseId = null } = {}) => {
    const list = Array.isArray(registry) ? registry : [];
    const normBssid = normalizeBssid(bssid);
    if (!normBssid) return [];

    return list
        .filter((entry) => entry.bssid === normBssid)
        .map((entry) => {
            const corroboratingCaseIds = entry.caseIds.filter((id) => id !== excludeCaseId);
            return { ...entry, corroboratingCount: corroboratingCaseIds.length, corroboratingCaseIds };
        })
        .filter((entry) => entry.corroboratingCount >= 1)
        .sort((a, b) => b.corroboratingCount - a.corroboratingCount);
};

// Score how strongly the BSSID fingerprint history supports a given candidate
// venue, from the perspective of a specific case (self-excluded). Returns:
//   0 -> no independent fingerprint match for this candidate
//   2 -> one independent corroborating case
//   3 -> two or more independent corroborating cases (strong)
export const scoreBssidVenueMatch = (registry, bssid, candidate, { excludeCaseId = null } = {}) => {
    const matches = lookupVenueByBssid(registry, bssid, { excludeCaseId });
    if (!matches.length) {
        return { score: 0, corroboratingCount: 0, matchedVenue: null };
    }
    const candidateKey = canonicalVenueKey({
        placeProviderId: candidate?.placeProviderId,
        name: candidate?.name,
    });
    const hit = matches.find((entry) => entry.venueKey === candidateKey);
    if (!hit) {
        return { score: 0, corroboratingCount: 0, matchedVenue: null };
    }
    const score = hit.corroboratingCount >= 2 ? 3 : 2;
    return {
        score,
        corroboratingCount: hit.corroboratingCount,
        matchedVenue: hit.venueName || candidate?.name || null,
    };
};
