export const buildAudioIdentificationSignals = ({ submission, report, formatMatchedSong }) => {
    const songIdentity = submission?.songIdentity || null;

    return {
        provider: 'ACRCloud',
        fingerprintSource: submission?.audioDeconstruction?.fingerprintStem
            ? 'audio_deconstruction_stem'
            : 'derived_audio',
        fingerprintStem: submission?.audioDeconstruction?.fingerprintStem || null,
        matchedSong: submission?.matchedSong || formatMatchedSong(songIdentity) || null,
        title: songIdentity?.title || report?.title || null,
        artist: songIdentity?.artist || report?.artist || null,
        label: songIdentity?.label || report?.label || null,
        album: songIdentity?.album || null,
        releaseDate: songIdentity?.release_date || null,
        isrc: songIdentity?.external_ids?.isrc || null,
        upc: songIdentity?.external_ids?.upc || null,
        matchedTrackId: report?.matchedTrackId || null,
        matchedTrackConfidence: report?.matchedTrackConfidence ?? null,
    };
};
