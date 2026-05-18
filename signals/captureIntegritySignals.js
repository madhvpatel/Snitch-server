export const buildCaptureIntegritySignals = ({
    req,
    submission,
    report,
    rawAsset,
    audioAsset,
    buildAssetUrl,
    signatureStatus,
}) => ({
    submissionReference: submission?.reference || null,
    captureSessionId: submission?.captureSessionId || null,
    originSurface: submission?.source || null,
    consentVersion: submission?.consentVersion || null,
    durationSeconds: submission?.durationSeconds || null,
    mediaSha256: submission?.mediaSha256 || null,
    signatureStatus,
    clockSkewStatus: submission?.clockSkewFlag ? 'flagged' : 'clear',
    measuredOffsetsMs: {
        start: submission?.measuredStartOffsetMs ?? null,
        end: submission?.measuredEndOffsetMs ?? null,
    },
    timestamps: {
        localStartTime: submission?.localStartTime || null,
        localEndTime: submission?.localEndTime || null,
        finalizedAt: submission?.finalizedAt || null,
        processingStartedAt: submission?.processingStartedAt || null,
        processingCompletedAt: submission?.processingCompletedAt || null,
    },
    device: {
        model: submission?.deviceModel || null,
        osVersion: submission?.osVersion || null,
        appVersion: submission?.appVersion || null,
        deviceTrustBand: report?.deviceTrustBand || null,
    },
    geolocation: {
        start: submission?.geolocationStart || null,
        end: submission?.geolocationEnd || null,
        trackAnalysis: submission?.gpsTrackAnalysis || null,
    },
    assets: {
        rawVideo: rawAsset ? {
            assetId: rawAsset.id,
            mimeType: rawAsset.mimeType,
            sizeBytes: rawAsset.sizeBytes,
            url: buildAssetUrl(req, rawAsset),
        } : null,
        derivedAudio: audioAsset ? {
            assetId: audioAsset.id,
            mimeType: audioAsset.mimeType,
            sizeBytes: audioAsset.sizeBytes,
            url: buildAssetUrl(req, audioAsset),
        } : null,
    },
});
