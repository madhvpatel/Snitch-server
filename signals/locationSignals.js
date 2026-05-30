import { cleanString } from './common.js';

const toRadians = (value) => (Number(value) * Math.PI) / 180;

export const haversineDistanceMeters = (origin, target) => {
    if (!origin || !target) {
        return null;
    }

    const lat1 = Number(origin.lat);
    const lon1 = Number(origin.lon);
    const lat2 = Number(target.lat);
    const lon2 = Number(target.lon);

    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) {
        return null;
    }

    const earthRadiusMeters = 6371000;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return Math.round(earthRadiusMeters * c);
};

export const analyzeGpsTrack = (track) => {
    if (!Array.isArray(track) || track.length < 2) {
        return null;
    }

    const points = track
        .map((p) => ({
            lat: Number(p?.lat),
            lon: Number(p?.lon),
            accuracy: Number(p?.accuracy ?? 9999),
            capturedAt: p?.capturedAt || null,
        }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

    if (points.length < 2) {
        return null;
    }

    let totalPathMeters = 0;
    for (let index = 1; index < points.length; index += 1) {
        const distance = haversineDistanceMeters(points[index - 1], points[index]);
        if (Number.isFinite(distance)) {
            totalPathMeters += distance;
        }
    }

    const anchor = points[0];
    let maxDeviationMeters = 0;
    for (const point of points) {
        const distance = haversineDistanceMeters(anchor, point);
        if (Number.isFinite(distance) && distance > maxDeviationMeters) {
            maxDeviationMeters = distance;
        }
    }

    const avgAccuracy = points.reduce((sum, point) => sum + point.accuracy, 0) / points.length;
    const first = points[0].capturedAt ? new Date(points[0].capturedAt).getTime() : null;
    const last = points[points.length - 1].capturedAt ? new Date(points[points.length - 1].capturedAt).getTime() : null;
    const durationMs = first && last ? last - first : null;
    const velocityMps = durationMs > 0 ? totalPathMeters / (durationMs / 1000) : null;

    let velocityCategory = 'unknown';
    if (velocityMps !== null) {
        if (velocityMps < 2) {
            velocityCategory = 'stationary';
        } else if (velocityMps < 6) {
            velocityCategory = 'walking';
        } else {
            velocityCategory = 'vehicle';
        }
    }

    const avgAcc = Number.isFinite(avgAccuracy) ? avgAccuracy : 35;
    const driftBudget = Math.max(20, avgAcc * 0.8);
    const isStationary = totalPathMeters < Math.max(25, driftBudget) && maxDeviationMeters < driftBudget;

    return {
        pointCount: points.length,
        totalPathMeters: Math.round(totalPathMeters),
        maxDeviationMeters: Math.round(maxDeviationMeters),
        avgAccuracyMeters: Math.round(avgAccuracy),
        velocityMps: velocityMps !== null ? Number(velocityMps.toFixed(2)) : null,
        velocityCategory,
        isStationary,
    };
};

const averageFiniteNumbers = (values = []) => {
    const numeric = values.map((value) => Number(value)).filter(Number.isFinite);
    if (!numeric.length) {
        return null;
    }

    return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
};

const namesLikelyMatch = (left, right) => {
    const normalize = (value) => cleanString(value).replace(/[^a-z0-9]+/g, ' ').trim();
    const a = normalize(left);
    const b = normalize(right);

    if (!a || !b) {
        return false;
    }

    return a === b || a.includes(b) || b.includes(a);
};

const buildGeoBucket = ({ distanceMeters, accuracyMeters }) => {
    if (!Number.isFinite(distanceMeters)) {
        return 'unknown';
    }

    const accuracy = Number.isFinite(accuracyMeters) ? accuracyMeters : 35;
    if (distanceMeters <= Math.max(35, accuracy * 1.2)) {
        return 'inside';
    }
    if (distanceMeters <= Math.max(90, accuracy * 2.2)) {
        return 'perimeter';
    }
    return 'outside';
};

const toLatLonPoint = (value) => {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const lat = Number(value.lat ?? value.latitude);
    const lon = Number(value.lon ?? value.longitude);
    if (![lat, lon].every(Number.isFinite)) {
        return null;
    }

    return { lat, lon };
};

const summarizeVenueDistances = ({ startPoint, endPoint, venuePoint }) => {
    const startDistanceMeters = haversineDistanceMeters(startPoint, venuePoint);
    const endDistanceMeters = haversineDistanceMeters(endPoint, venuePoint);
    const distanceValues = [startDistanceMeters, endDistanceMeters].filter(Number.isFinite);

    return {
        startDistanceMeters,
        endDistanceMeters,
        minDistanceMeters: distanceValues.length ? Math.min(...distanceValues) : null,
        maxDistanceMeters: distanceValues.length ? Math.max(...distanceValues) : null,
        avgDistanceMeters: distanceValues.length
            ? Math.round(distanceValues.reduce((sum, value) => sum + value, 0) / distanceValues.length)
            : null,
    };
};

const getVenueIdentityKey = (venue) => {
    if (!venue) {
        return null;
    }

    return venue.placeProviderId
        || venue.id
        || `${cleanString(venue.name)}:${cleanString(venue.address || '')}`;
};

const buildNearbyVenueCandidates = ({ startPoint, endPoint, candidateVenues = [], selectedVenue, matchedVenue, accuracyEnvelopeMeters }) => {
    if (!Array.isArray(candidateVenues) || !candidateVenues.length || !Number.isFinite(accuracyEnvelopeMeters)) {
        return [];
    }

    const selectedKey = getVenueIdentityKey(selectedVenue);
    const matchedKey = getVenueIdentityKey(matchedVenue);

    return candidateVenues
        .map((candidate) => {
            const venuePoint = toLatLonPoint(candidate);
            if (!venuePoint) {
                return null;
            }

            const distances = summarizeVenueDistances({ startPoint, endPoint, venuePoint });
            if (!Number.isFinite(distances.minDistanceMeters)) {
                return null;
            }

            const identityKey = getVenueIdentityKey(candidate);
            return {
                id: candidate.id || null,
                name: candidate.name || 'Unnamed venue',
                address: candidate.address || null,
                city: candidate.city || null,
                placeProviderId: candidate.placeProviderId || null,
                distanceMeters: distances.minDistanceMeters,
                insideAccuracyEnvelope: distances.minDistanceMeters <= accuracyEnvelopeMeters,
                isSelectedVenue: Boolean(identityKey && selectedKey && identityKey === selectedKey),
                isMatchedVenue: Boolean(identityKey && matchedKey && identityKey === matchedKey),
            };
        })
        .filter(Boolean)
        .filter((candidate) => candidate.insideAccuracyEnvelope)
        .sort((left, right) => left.distanceMeters - right.distanceMeters)
        .slice(0, 8);
};

export const buildLocationDelta = ({ submission, venue, candidateVenues = [] }) => {
    const startPoint = toLatLonPoint(submission?.geolocationStart);
    const endPoint = toLatLonPoint(submission?.geolocationEnd);
    const selectedVenuePoint = toLatLonPoint(submission?.selectedVenue);
    const matchedVenuePoint = toLatLonPoint(venue);
    const selectedVenue = summarizeVenueDistances({ startPoint, endPoint, venuePoint: selectedVenuePoint });
    const matchedVenue = summarizeVenueDistances({ startPoint, endPoint, venuePoint: matchedVenuePoint });
    const averageAccuracyMeters = averageFiniteNumbers([submission?.geolocationStart?.accuracy, submission?.geolocationEnd?.accuracy]);
    const primaryVenueSource = matchedVenue.minDistanceMeters != null
        ? 'matched_venue'
        : selectedVenue.minDistanceMeters != null
            ? 'selected_venue'
            : 'none';
    const primaryDistanceMeters = primaryVenueSource === 'matched_venue'
        ? matchedVenue.minDistanceMeters
        : primaryVenueSource === 'selected_venue'
            ? selectedVenue.minDistanceMeters
            : null;
    const accuracyEnvelopeMeters = Number.isFinite(averageAccuracyMeters)
        ? Math.max(25, Math.round(averageAccuracyMeters * 1.25))
        : null;
    const nearbyVenueCandidates = buildNearbyVenueCandidates({
        startPoint,
        endPoint,
        candidateVenues,
        selectedVenue: submission?.selectedVenue || null,
        matchedVenue: venue || null,
        accuracyEnvelopeMeters,
    });
    const primaryVenueKey = getVenueIdentityKey(venue) || getVenueIdentityKey(submission?.selectedVenue);
    const alternateNearbyVenueCandidates = nearbyVenueCandidates.filter((candidate) => {
        const candidateKey = candidate.placeProviderId || candidate.id || `${cleanString(candidate.name)}:${cleanString(candidate.address || '')}`;
        return !primaryVenueKey || candidateKey !== primaryVenueKey;
    });
    const closestAlternateVenueCandidate = alternateNearbyVenueCandidates[0] || null;
    const closestAlternateDeltaMeters = Number.isFinite(primaryDistanceMeters) && closestAlternateVenueCandidate
        ? Math.abs(closestAlternateVenueCandidate.distanceMeters - primaryDistanceMeters)
        : null;
    const gpsAmbiguityThresholdMeters = Number.isFinite(averageAccuracyMeters)
        ? Math.max(10, Math.round(averageAccuracyMeters * 0.5))
        : 10;

    return {
        selectedVenueDistanceStartMeters: selectedVenue.startDistanceMeters,
        selectedVenueDistanceEndMeters: selectedVenue.endDistanceMeters,
        matchedVenueDistanceStartMeters: matchedVenue.startDistanceMeters,
        matchedVenueDistanceEndMeters: matchedVenue.endDistanceMeters,
        minVenueDistanceMeters: primaryDistanceMeters,
        maxVenueDistanceMeters: primaryVenueSource === 'matched_venue'
            ? matchedVenue.maxDistanceMeters
            : primaryVenueSource === 'selected_venue'
                ? selectedVenue.maxDistanceMeters
                : null,
        avgVenueDistanceMeters: primaryVenueSource === 'matched_venue'
            ? matchedVenue.avgDistanceMeters
            : primaryVenueSource === 'selected_venue'
                ? selectedVenue.avgDistanceMeters
                : null,
        capturePathDeltaMeters: haversineDistanceMeters(startPoint, endPoint),
        venueAnchorDeltaMeters: haversineDistanceMeters(selectedVenuePoint, matchedVenuePoint),
        accuracyStartMeters: Number.isFinite(Number(submission?.geolocationStart?.accuracy))
            ? Number(submission.geolocationStart.accuracy)
            : null,
        accuracyEndMeters: Number.isFinite(Number(submission?.geolocationEnd?.accuracy))
            ? Number(submission.geolocationEnd.accuracy)
            : null,
        averageAccuracyMeters,
        accuracyEnvelopeMeters,
        withinAccuracyEnvelope: Number.isFinite(primaryDistanceMeters) && Number.isFinite(accuracyEnvelopeMeters)
            ? primaryDistanceMeters <= accuracyEnvelopeMeters
            : null,
        geoBucket: buildGeoBucket({
            distanceMeters: primaryDistanceMeters,
            accuracyMeters: averageAccuracyMeters,
        }),
        selectedMatchedAligned: namesLikelyMatch(submission?.selectedVenue?.name, venue?.name || submission?.matchedVenue || null),
        primaryVenueSource,
        nearbyVenueCandidates,
        closestAlternateVenueCandidate,
        adjacentVenueAmbiguity: Boolean(
            closestAlternateVenueCandidate
            && Number.isFinite(closestAlternateDeltaMeters)
            && closestAlternateDeltaMeters <= gpsAmbiguityThresholdMeters
        ),
        closestAlternateDeltaMeters,
        gpsAmbiguityThresholdMeters,
    };
};
