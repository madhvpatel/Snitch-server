const cleanName = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

export const namesLikelyMatch = (left, right) => {
  const a = cleanName(left);
  const b = cleanName(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
};

const includesAnyPattern = (text, patterns = []) => patterns.some((pattern) => pattern.test(text));

export const getVenueName = (venue) => String(venue?.name || '').trim();

export const getTargetVenueNameFromCase = (caseRecord) => (
  caseRecord?.venueContext?.selectedVenue?.name
  || caseRecord?.venueContext?.matchedVenue?.name
  || caseRecord?.location?.name
  || 'Venue unresolved'
);

export const getMatchedVenueNameFromCase = (caseRecord) => (
  caseRecord?.venueContext?.matchedVenue?.name
  || caseRecord?.location?.name
  || null
);

export const extractVisualVenueName = (visual = {}) => {
  const rawText = [
    visual.summary,
    visual.performanceContext,
    ...(visual.visibleEquipment || []),
    ...(visual.venueIdentitySignals || []),
    ...(visual.obstructionFlags || []),
    ...(visual.frameObservations || []).map((entry) => entry.observation),
  ].filter(Boolean).join(' ');

  if (/\bcontradicts?\b/i.test(rawText) || /\bprovided venue identity\b/i.test(rawText) || /\bidentified venue\b/i.test(rawText)) {
    return null;
  }

  const quoted = rawText.match(/(?:interior of|identified as|identified venue|commercial venue identified as)\s+['"]([^'"]+)['"]/i);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const described = rawText.match(/(?:interior of|identified as|identified venue|commercial venue identified as)\s+([^,.]+)/i);
  return described?.[1]?.trim().replace(/^['"]|['"]$/g, '') || null;
};

export const extractVisualVenueNameFromCase = (caseRecord) => extractVisualVenueName({
  performanceContext: caseRecord?.absoluteProof?.performanceContext,
  obstructionFlags: [caseRecord?.absoluteProof?.obstructionFlags].filter(Boolean),
});

const buildAttributionMeta = ({ evidencePackage = {}, matchedVenue, selectedVenue, visualSource }) => {
  const locationDelta = evidencePackage?.locationDelta || {};
  const selectedVenueName = getVenueName(selectedVenue);
  const matchedVenueName = getVenueName(matchedVenue);

  return {
    targetVenue: selectedVenueName || matchedVenueName || 'Venue unresolved',
    matchedVenue: matchedVenueName || null,
    visualSource: visualSource || null,
    selectedVenueDistanceStartMeters: locationDelta.selectedVenueDistanceStartMeters ?? null,
    selectedVenueDistanceEndMeters: locationDelta.selectedVenueDistanceEndMeters ?? null,
    matchedVenueDistanceStartMeters: locationDelta.matchedVenueDistanceStartMeters ?? null,
    matchedVenueDistanceEndMeters: locationDelta.matchedVenueDistanceEndMeters ?? null,
    minVenueDistanceMeters: locationDelta.minVenueDistanceMeters ?? null,
    venueAnchorDeltaMeters: locationDelta.venueAnchorDeltaMeters ?? null,
    accuracyEnvelopeMeters: locationDelta.accuracyEnvelopeMeters ?? null,
    withinAccuracyEnvelope: locationDelta.withinAccuracyEnvelope ?? null,
    selectedMatchedAligned: locationDelta.selectedMatchedAligned ?? null,
  };
};

const finiteNumbers = (values = []) => values
  .filter((value) => value !== null && value !== undefined && value !== '')
  .map((value) => Number(value))
  .filter(Number.isFinite);

const summarizeSelectedVenueDelta = (locationDelta = {}) => {
  const selectedDistances = finiteNumbers([
    locationDelta.selectedVenueDistanceStartMeters,
    locationDelta.selectedVenueDistanceEndMeters,
  ]);
  const minSelectedVenueDistanceMeters = selectedDistances.length ? Math.min(...selectedDistances) : null;
  const avgSelectedVenueDistanceMeters = selectedDistances.length
    ? Math.round(selectedDistances.reduce((sum, value) => sum + value, 0) / selectedDistances.length)
    : null;
  const accuracyEnvelope = Number(locationDelta.accuracyEnvelopeMeters);
  const selectedVenueInsideEnvelope = Number.isFinite(minSelectedVenueDistanceMeters) && Number.isFinite(accuracyEnvelope)
    ? minSelectedVenueDistanceMeters <= Math.max(25, accuracyEnvelope)
    : null;
  const selectedVenueClose = Number.isFinite(minSelectedVenueDistanceMeters)
    ? minSelectedVenueDistanceMeters <= Math.max(45, Number.isFinite(accuracyEnvelope) ? accuracyEnvelope : 0)
    : false;

  return {
    minSelectedVenueDistanceMeters,
    avgSelectedVenueDistanceMeters,
    selectedVenueInsideEnvelope,
    selectedVenueClose,
  };
};

export const inferVenueAttribution = ({ evidencePackage = {}, matchedVenue, selectedVenue }) => {
  const locationDelta = evidencePackage?.locationDelta || {};
  const visual = evidencePackage?.visualContext || {};
  const selectedDelta = summarizeSelectedVenueDelta(locationDelta);
  const visualSource = extractVisualVenueName(visual);
  const attributionMeta = buildAttributionMeta({
    evidencePackage,
    matchedVenue,
    selectedVenue,
    visualSource,
  });
  const visualText = cleanName([
    visual.summary,
    visual.performanceContext,
    ...(visual.visibleEquipment || []),
    ...(visual.venueIdentitySignals || []),
    ...(visual.obstructionFlags || []),
    ...(visual.frameObservations || []).map((entry) => entry.observation),
  ].filter(Boolean).join(' '));
  const targetVenueName = getVenueName(selectedVenue) || getVenueName(matchedVenue);
  const matchedVenueName = getVenueName(matchedVenue);
  const venueName = targetVenueName || matchedVenueName || '';
  const isCoordinateFallback = !matchedVenue?.placeProviderId && String(venueName).startsWith('Approx.');
  const minDistance = Number(locationDelta.minVenueDistanceMeters);
  const accuracyEnvelope = Number(locationDelta.accuracyEnvelopeMeters);
  const insideEnvelope = locationDelta.withinAccuracyEnvelope === true
    || (Number.isFinite(minDistance) && Number.isFinite(accuracyEnvelope) && minDistance <= accuracyEnvelope);
  const closeToAnchor = Number.isFinite(minDistance)
    ? minDistance <= Math.max(45, Number.isFinite(accuracyEnvelope) ? accuracyEnvelope : 0)
    : false;
  const selectedMatchedAligned = selectedVenue?.name ? locationDelta.selectedMatchedAligned !== false : true;
  const hasSelectedCoordinates = selectedVenue?.latitude != null
    && selectedVenue?.longitude != null
    && Number.isFinite(Number(selectedVenue.latitude))
    && Number.isFinite(Number(selectedVenue.longitude));
  const hasMatchedCoordinates = matchedVenue?.latitude != null
    && matchedVenue?.longitude != null
    && Number.isFinite(Number(matchedVenue.latitude))
    && Number.isFinite(Number(matchedVenue.longitude));
  const closeToSelectedVenue = selectedDelta.selectedVenueClose || (!hasSelectedCoordinates && closeToAnchor);
  const selectedVenueOutsideEnvelope = hasSelectedCoordinates
    && selectedDelta.selectedVenueInsideEnvelope === false
    && Number.isFinite(selectedDelta.minSelectedVenueDistanceMeters)
    && selectedDelta.minSelectedVenueDistanceMeters > Math.max(45, Number.isFinite(accuracyEnvelope) ? accuracyEnvelope : 0);
  const commercialVenueCue = includesAnyPattern(visualText, [
    /\bcafe\b/i,
    /\bcoffee\b/i,
    /\brestaurant\b/i,
    /\bsports bar\b/i,
    /\bbar\b/i,
    /\blounge\b/i,
    /\bpatron\b/i,
    /\bstaff\b/i,
    /\btables?\b/i,
    /\bseating\b/i,
    /\bsignage\b/i,
    /\bmenu\b/i,
    /\bcommercial venue\b/i,
    /\bvenue identified\b/i,
  ]);
  const hardContradiction = includesAnyPattern(visualText, [
    /\bstrongly contradicts\b/i,
    /\bcontradicts the (provided|identified|selected) venue\b/i,
    /\bcontradicts the provided venue identity\b/i,
    /\boffice\b/i,
    /\bcoworking\b/i,
    /\bco-working\b/i,
    /\bprivate residence\b/i,
    /\bhouse\b/i,
    /\bhome\b/i,
    /\bbedroom\b/i,
  ]);
  const nonVenueSpaceCue = includesAnyPattern(visualText, [
    /\boffice\b/i,
    /\bcoworking\b/i,
    /\bco-working\b/i,
    /\bcorporate\b/i,
    /\bprivate residence\b/i,
    /\bhouse\b/i,
    /\bhome\b/i,
    /\bbedroom\b/i,
  ]);
  const visualMatchesTarget = visualSource && namesLikelyMatch(visualSource, targetVenueName);
  const visualMatchesMatchedVenue = visualSource && namesLikelyMatch(visualSource, matchedVenueName);
  const visualSupportsSelectedVenue = Boolean(visualMatchesTarget || (!visualSource && commercialVenueCue));
  const targetVisualMismatch = selectedVenue?.name
    ? visualSource && !visualMatchesTarget
    : visualSource && !visualMatchesTarget && !visualMatchesMatchedVenue;

  if (targetVisualMismatch) {
    return {
      status: 'visual_target_mismatch',
      actualSource: visualSource,
      ...attributionMeta,
      score: 40,
      unitAmbiguityRisk: 'high',
      adjacentCaptureRisk: 'medium',
      legalBlock: true,
      recommendedDisposition: 'manual_review',
      note: `AI-assisted visual enrichment names ${visualSource}, but the selected target is ${targetVenueName || 'unresolved'}${matchedVenueName ? ` and the matched venue is ${matchedVenueName}` : ''}. Correct the venue attribution or send the case for manual review.`,
    };
  }

  if (isCoordinateFallback) {
    return {
      status: 'coordinate_only',
      actualSource: 'Unresolved',
      ...attributionMeta,
      score: 22,
      unitAmbiguityRisk: 'high',
      adjacentCaptureRisk: 'high',
      legalBlock: true,
      recommendedDisposition: 'manual_review',
      note: 'The venue is only a coordinate fallback, so GPS cannot attribute music to a business.',
    };
  }

  if (hardContradiction || nonVenueSpaceCue) {
    return {
      status: 'wrong_venue_or_unit',
      actualSource: nonVenueSpaceCue ? 'Office, co-working, or private space' : 'Unresolved alternate source',
      ...attributionMeta,
      score: 30,
      unitAmbiguityRisk: 'high',
      adjacentCaptureRisk: insideEnvelope ? 'medium' : 'high',
      legalBlock: true,
      recommendedDisposition: 'manual_review',
      note: 'AI-assisted visual enrichment conflicts with the named venue or indicates a non-venue/private capture. Device proximity is not enough to attribute playback to the venue.',
    };
  }

  if (!hasSelectedCoordinates && hasMatchedCoordinates && !visualSource && !commercialVenueCue) {
    return {
      status: 'same_building_unresolved_unit',
      actualSource: 'Unresolved unit or nearby source',
      ...attributionMeta,
      score: 46,
      unitAmbiguityRisk: 'high',
      adjacentCaptureRisk: 'medium',
      legalBlock: true,
      recommendedDisposition: 'build_corroboration',
      note: 'Device proximity is strong, but selected venue coordinates and visual source corroboration are missing. Treat this as unresolved unit/source attribution until corroborated.',
    };
  }

  if (selectedVenueOutsideEnvelope && !visualMatchesTarget) {
    return {
      status: 'adjacent_public_space',
      actualSource: visualSource || 'Nearby or unresolved public source',
      ...attributionMeta,
      score: 38,
      unitAmbiguityRisk: 'medium',
      adjacentCaptureRisk: 'high',
      legalBlock: true,
      recommendedDisposition: 'manual_review',
      note: `Captured coordinates are ${Math.round(selectedDelta.minSelectedVenueDistanceMeters)} m from the snitch-selected venue, outside the current accuracy envelope. Visual enrichment does not independently name the selected venue.`,
    };
  }

  if (closeToSelectedVenue && insideEnvelope && visualSupportsSelectedVenue && selectedMatchedAligned) {
    return {
      status: 'target_venue_supported',
      actualSource: visualSource || venueName || 'Named venue',
      ...attributionMeta,
      score: selectedDelta.minSelectedVenueDistanceMeters != null && selectedDelta.minSelectedVenueDistanceMeters <= 25 ? 90 : 84,
      unitAmbiguityRisk: 'low',
      adjacentCaptureRisk: 'low',
      legalBlock: false,
      recommendedDisposition: 'build_corroboration',
      note: selectedDelta.minSelectedVenueDistanceMeters != null
        ? `Captured coordinates are close to the snitch-selected venue (${Math.round(selectedDelta.minSelectedVenueDistanceMeters)} m minimum delta), and AI-assisted visual context supports the real venue.`
        : 'Captured coordinates are close to the selected/matched venue anchor and visual enrichment supports the real venue.',
    };
  }

  if (!insideEnvelope && Number.isFinite(minDistance) && minDistance > Math.max(45, accuracyEnvelope || 0)) {
    return {
      status: 'adjacent_public_space',
      actualSource: 'Nearby or unresolved public source',
      ...attributionMeta,
      score: 42,
      unitAmbiguityRisk: 'medium',
      adjacentCaptureRisk: 'high',
      legalBlock: true,
      recommendedDisposition: 'manual_review',
      note: 'Captured coordinates sit outside the venue accuracy envelope, so the target venue attribution is not proven.',
    };
  }

  return {
    status: commercialVenueCue ? 'target_venue_plausible' : 'same_building_unresolved_unit',
    actualSource: visualSource || venueName || 'Named venue',
    ...attributionMeta,
    score: commercialVenueCue ? 68 : 52,
    unitAmbiguityRisk: commercialVenueCue ? 'medium' : 'high',
    adjacentCaptureRisk: commercialVenueCue ? 'medium' : 'medium',
    legalBlock: false,
    recommendedDisposition: 'build_corroboration',
    note: commercialVenueCue
      ? 'Visual enrichment supports a venue-like source, but attribution should still be corroborated before enforcement.'
      : 'GPS/device presence is usable, but visual enrichment does not yet prove the exact unit or floor.',
  };
};

export const inferVenueAttributionFromCase = (caseRecord) => inferVenueAttribution({
  evidencePackage: {
    locationDelta: caseRecord?.locationDelta || {},
    visualContext: {
      performanceContext: caseRecord?.absoluteProof?.performanceContext,
      obstructionFlags: [caseRecord?.absoluteProof?.obstructionFlags].filter(Boolean),
    },
  },
  selectedVenue: caseRecord?.venueContext?.selectedVenue || null,
  matchedVenue: caseRecord?.venueContext?.matchedVenue || caseRecord?.location || null,
});
