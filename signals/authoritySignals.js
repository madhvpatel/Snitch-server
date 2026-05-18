export const buildPrototypeChainOfCustody = ({ reportView, caseRecord }) => {
    const capture = reportView?.evidencePackage?.captureIntegrity || {};
    const audio = reportView?.evidencePackage?.audioIdentification || {};
    const timeline = [];
    const deviceId = capture?.captureSessionId || capture?.device?.model || caseRecord?.primarySubmissionId || 'UNKNOWN-DEVICE';
    const mediaHash = capture?.mediaSha256 || 'sha256:pending';

    if (capture?.timestamps?.localStartTime || capture?.geolocation?.start?.capturedAt) {
        timeline.push({
            timestamp: capture.timestamps?.localStartTime || capture.geolocation.start.capturedAt,
            event: 'Initial Capture',
            actor: capture?.originSurface || 'Field Recorder',
            hash: mediaHash,
            deviceId,
            status: capture?.mediaSha256 ? 'Verified' : 'Pending',
        });
    }

    if (capture?.timestamps?.finalizedAt) {
        timeline.push({
            timestamp: capture.timestamps.finalizedAt,
            event: 'Payload Finalized',
            actor: capture?.signatureStatus === 'signed_and_verified' ? 'Integrity Service' : 'Finalize Service',
            hash: capture?.signatureStatus || 'unsigned_or_unverified',
            deviceId,
            status: capture?.signatureStatus === 'signed_and_verified' ? 'Verified' : 'Pending',
        });
    }

    if (capture?.timestamps?.processingCompletedAt) {
        timeline.push({
            timestamp: capture.timestamps.processingCompletedAt,
            event: 'Evidence Processing Completed',
            actor: 'Media Pipeline',
            hash: audio?.matchedTrackId ? `track:${audio.matchedTrackId}` : mediaHash,
            deviceId: 'PIPELINE',
            status: audio?.matchedTrackConfidence ? 'Verified' : 'Pending',
        });
    }

    if (!timeline.length) {
        timeline.push({
            timestamp: caseRecord?.createdAt || new Date().toISOString(),
            event: 'Case Created',
            actor: 'System',
            hash: mediaHash,
            deviceId,
            status: 'Pending',
        });
    }

    return timeline.sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
};

export const derivePrototypeQualityScore = ({ reportView, caseRecord }) => {
    const capture = reportView?.evidencePackage?.captureIntegrity || {};
    const audio = reportView?.evidencePackage?.audioIdentification || {};
    const visual = reportView?.evidencePackage?.visualContext || {};
    const rights = reportView?.evidencePackage?.rightsAndCaseContext || {};
    const merchant = reportView?.evidencePackage?.venueContext?.merchant || null;

    let score = 20;

    if (capture?.mediaSha256) score += 12;
    if (capture?.signatureStatus === 'signed_and_verified') score += 14;
    if (capture?.clockSkewStatus === 'clear') score += 8;
    if (capture?.durationSeconds >= 15 && capture?.durationSeconds <= 20) score += 8;
    score += Math.min(18, Math.round(Number(audio?.matchedTrackConfidence || 0) * 18));
    if (Array.isArray(visual?.frames) && visual.frames.length) score += 8;
    if ((visual?.venueIdentitySignals || []).length) score += 5;
    if ((visual?.obstructionFlags || []).length) score -= 6;
    if (merchant?.gstin) score += 5;
    if (['unlicensed', 'expired'].includes(String(rights?.licenseAssessment?.status || '').toLowerCase())) score += 6;
    if (Number(caseRecord?.realizedValueInr || 0) > 0) score += 4;

    return Math.max(0, Math.min(100, score));
};
