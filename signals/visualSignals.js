import { cleanString } from './common.js';

export const sanitizeVisualAnalysis = (analysis, peakWindows = []) => {
    if (!analysis || typeof analysis !== 'object') {
        return null;
    }

    const frameObservationByTimestamp = new Map(
        Array.isArray(analysis.frameObservations)
            ? analysis.frameObservations
                .filter((entry) => entry && typeof entry === 'object')
                .map((entry) => [Number(entry.timestampSeconds), String(entry.observation || '').trim()])
                .filter(([, observation]) => observation)
            : []
    );

    const playbackContext = [
        'likely_installed_pa',
        'likely_small_portable_speaker',
        'likely_personal_device',
        'inconclusive'
    ].includes(analysis.playbackContext)
        ? analysis.playbackContext
        : 'inconclusive';

    return {
        playbackContext,
        confidence: Math.max(0, Math.min(1, Number(analysis.confidence || 0))),
        summary: String(analysis.summary || '').trim() || 'Visual evidence analysis was inconclusive.',
        visibleEquipment: Array.isArray(analysis.visibleEquipment)
            ? analysis.visibleEquipment.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 8)
            : [],
        venueIdentitySignals: Array.isArray(analysis.venueIdentitySignals)
            ? analysis.venueIdentitySignals.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 8)
            : [],
        obstructionFlags: Array.isArray(analysis.obstructionFlags)
            ? analysis.obstructionFlags.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 8)
            : [],
        frameObservations: peakWindows.map((window) => ({
            timestampSeconds: window.timestampSeconds,
            observation: frameObservationByTimestamp.get(window.timestampSeconds) || null
        })).filter((entry) => entry.observation),
        modelVersion: 'visual-v1',
    };
};

export const buildFallbackVisualAnalysis = ({ peakWindows = [], sourceAnalysis, frames = [] }) => ({
    playbackContext: 'inconclusive',
    confidence: 0.3,
    summary: frames.length
        ? 'Peak-aligned frames were extracted, but visual AI analysis was unavailable. Review the saved frames alongside the audio/source signals.'
        : 'Visual AI analysis was unavailable and no peak-aligned frames were extracted.',
    visibleEquipment: [],
    venueIdentitySignals: [],
    obstructionFlags: [],
    frameObservations: peakWindows.map((window) => ({
        timestampSeconds: window.timestampSeconds,
        observation: sourceAnalysis?.sourceClass
            ? `Frame captured at a higher-energy window while audio source scoring remained ${sourceAnalysis.sourceClass.replaceAll('_', ' ')}.`
            : 'Frame captured at a higher-energy window for manual review.'
    })),
    modelVersion: 'visual-v1-fallback',
});

export const looksLikeDegenerateVisualRefresh = (visualAnalysis) => {
    if (!visualAnalysis) {
        return true;
    }

    const summary = cleanString(visualAnalysis.summary || '');
    return !visualAnalysis.visibleEquipment?.length
        && !visualAnalysis.venueIdentitySignals?.length
        && (!summary || summary.includes('no still frames were provided') || summary.includes('visual analysis cannot be performed'));
};
