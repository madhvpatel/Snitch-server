// Capture-context reconciliation: the trust seam between what the SNITCHER
// DECLARES (a low-trust claim) and what the PIPELINE DETECTS (evidence).
//
// Design contract — "declaration routes, evidence decides":
//   • Declared context is a CLAIM. It is stored attributed to a contributor and
//     is allowed to influence ROUTING ONLY (which queue, what priority,
//     spaceClass). It must never, by itself, set liability/reward/legal.
//   • Detected signals (audio source class, visual playback context, the LLM
//     application assessment) are EVIDENCE. The LLM reasons on evidence only.
//   • reconcileContext() fuses the two into a DERIVED block (spaceClass,
//     agreement, mismatch flags, review reason, disposition overlay). This
//     derived block is the only thing routing/sorting should read — never the
//     raw declaration. A lie therefore moves a case sideways into review, never
//     into a payout, and always lights up as a declaration↔evidence mismatch.
//
// Pure module: no I/O, fully unit-testable. Mirrors snake_case storage shape.

import {
    sourceClassSupportsVenuePlayback,
    isNonMusicSourceClass,
} from './sourceAnalysis.js';

// ─── Declared vocabulary (the only values the claim block may hold) ───

export const EVENT_TYPES = Object.freeze([
    'bar_restaurant_cafe',
    'housing_society_event',
    'wedding_banquet',
    'dj_night',
    'gym_retail_salon',
    'hotel_resort',
    'private_home',
    'other',
]);

export const MUSIC_CONTROL = Object.freeze(['venue', 'dj', 'organiser', 'individual', 'unknown']);
export const TICKETED = Object.freeze(['yes', 'no', 'unknown']);
export const AUDIENCE = Object.freeze(['public', 'members_residents', 'private_invite', 'unknown']);
export const CROWD_BANDS = Object.freeze(['under_10', '10_50', '50_200', 'over_200', 'unknown']);

// ─── Derived spaceClass vocabulary (routing sorts on THIS, not the claim) ───

export const SPACE_CLASSES = Object.freeze([
    'COMMERCIAL_PUBLIC',     // bar/cafe/gym/hotel/dj night — public commercial use
    'RESIDENTIAL_EVENT',     // society/clubhouse/lawn event — private-looking but liable
    'PRIVATE_EVENT_LIABLE',  // wedding/banquet — invite-only but organised + often licensable
    'PRIVATE_NON_LIABLE',    // someone's home, individual playback
    'NEEDS_REVIEW',          // unknown/other — no declared anchor
]);

// event_type → base spaceClass. The routing concern. Lives server-side only.
const EVENT_TYPE_SPACE_CLASS = Object.freeze({
    bar_restaurant_cafe: 'COMMERCIAL_PUBLIC',
    dj_night: 'COMMERCIAL_PUBLIC',
    gym_retail_salon: 'COMMERCIAL_PUBLIC',
    hotel_resort: 'COMMERCIAL_PUBLIC',
    housing_society_event: 'RESIDENTIAL_EVENT',
    wedding_banquet: 'PRIVATE_EVENT_LIABLE',
    private_home: 'PRIVATE_NON_LIABLE',
    other: 'NEEDS_REVIEW',
});

// spaceClasses where private-looking visuals are EXPECTED, not contradictory —
// the declaration is precisely what resolves the "looks private but is liable"
// ambiguity. These must never be auto-discarded on private-space signals.
const RESIDENTIAL_LIABLE_CLASSES = Object.freeze(['RESIDENTIAL_EVENT', 'PRIVATE_EVENT_LIABLE']);

const oneOf = (value, allowed, fallback) => (
    allowed.includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : fallback
);

// Normalize an inbound declared block to the vocabulary, defaulting unknowns.
// This is the only sanctioned way to read a declaration into the system.
export const normalizeDeclaredContext = (input = {}) => {
    const safe = input && typeof input === 'object' ? input : {};
    return {
        event_type: oneOf(safe.event_type, EVENT_TYPES, 'other'),
        music_control: oneOf(safe.music_control, MUSIC_CONTROL, 'unknown'),
        ticketed: oneOf(safe.ticketed, TICKETED, 'unknown'),
        audience: oneOf(safe.audience, AUDIENCE, 'unknown'),
        crowd_band: oneOf(safe.crowd_band, CROWD_BANDS, 'unknown'),
    };
};

// True when the declaration claims venue/event-scale playback (i.e. the snitcher
// is asserting an enforceable music-use context, not casual personal listening).
const declaresOrganisedPlayback = (declared) => (
    ['venue', 'dj', 'organiser'].includes(declared.music_control)
    || ['bar_restaurant_cafe', 'dj_night', 'gym_retail_salon', 'hotel_resort',
        'housing_society_event', 'wedding_banquet'].includes(declared.event_type)
);

// ─── The fusion: declared (claim) × detected (evidence) → derived routing ───

// detected = {
//   sourceClass,            // from audio source analysis
//   visualPlaybackContext,  // from visual analysis (likely_personal_device | inconclusive | ...)
//   locationContext,        // from the LLM application assessment (private_home | inside_venue | ...)
//   privateSpaceRisk,       // 0..1 from the LLM application assessment
// }
export const reconcileContext = ({ declared: declaredInput, detected = {} } = {}) => {
    const declared = normalizeDeclaredContext(declaredInput);
    const baseClass = EVENT_TYPE_SPACE_CLASS[declared.event_type] || 'NEEDS_REVIEW';

    const sourceClass = String(detected.sourceClass || '').toLowerCase();
    const visualCtx = String(detected.visualPlaybackContext || '').toLowerCase();
    const locationCtx = String(detected.locationContext || '').toLowerCase();
    const privateSpaceRisk = Number.isFinite(Number(detected.privateSpaceRisk))
        ? Number(detected.privateSpaceRisk) : null;

    const audioSupportsVenue = sourceClassSupportsVenuePlayback(sourceClass);
    const audioIsPersonalOrNonMusic = sourceClass === 'likely_personal_device'
        || isNonMusicSourceClass(sourceClass);
    const visualSaysPersonalDevice = visualCtx === 'likely_personal_device';
    const visualSaysPrivateHome = locationCtx === 'private_home';

    const mismatchFlags = [];

    // Contradiction 1: snitcher declares organised/venue playback, but the AUDIO
    // sounds like a phone/TV/no-music — the core "it doesn't sound like an event"
    // tell. Strongest single fraud signal we can derive here.
    if (declaresOrganisedPlayback(declared) && audioIsPersonalOrNonMusic) {
        mismatchFlags.push('declared_event_audio_personal_device');
    }

    // Contradiction 2: declared a PUBLIC COMMERCIAL venue, but every spatial cue
    // says private home AND the visual says a personal device. Claimed a bar,
    // looks like a living room with a phone.
    if (baseClass === 'COMMERCIAL_PUBLIC' && visualSaysPrivateHome && visualSaysPersonalDevice) {
        mismatchFlags.push('declared_commercial_visual_private_home');
    }

    // Note: for RESIDENTIAL_EVENT / PRIVATE_EVENT_LIABLE, private-looking visuals
    // are EXPECTED and are NOT a mismatch — that is the whole point of the
    // declaration. We do not flag those here.

    let agreement;
    if (mismatchFlags.length) {
        agreement = 'mismatch';
    } else if (audioSupportsVenue || (declared.event_type !== 'other' && (audioSupportsVenue || visualCtx))) {
        // Evidence is consistent with (or actively supports) the declaration.
        agreement = audioSupportsVenue && declaresOrganisedPlayback(declared) ? 'aligned' : 'consistent';
    } else {
        agreement = 'unverifiable';
    }

    // spaceClass stays anchored to the declared event_type (the routing anchor);
    // a hard mismatch demotes it to NEEDS_REVIEW so it can't ride the declared
    // class into a confident queue.
    const spaceClass = mismatchFlags.length ? 'NEEDS_REVIEW' : baseClass;

    const residentialLiable = RESIDENTIAL_LIABLE_CLASSES.includes(spaceClass);
    const ticketed = declared.ticketed === 'yes';

    // Deterministic disposition overlay — the bounded, auditable way the
    // declaration influences routing. The LLM never sees this; it only reasons
    // on evidence. We overlay on top of its evidence-based recommendation.
    let dispositionOverride = null;
    let priorityEscalated = false;
    const reviewReasons = [];

    if (mismatchFlags.length) {
        dispositionOverride = 'manual_review';
        reviewReasons.push('Declared context contradicts the captured evidence; needs human adjudication.');
    } else if (residentialLiable) {
        // The case the whole layer exists for: private-looking space, but the
        // snitcher declares an organised event. Never auto-discard — route to a
        // human, and say why the residential visuals are not disqualifying.
        dispositionOverride = 'manual_review';
        reviewReasons.push(
            `Snitcher declares ${ticketed ? 'a ticketed ' : 'an '}organised ${declared.event_type === 'wedding_banquet' ? 'private event' : 'society/residential event'}; `
            + 'residential-looking visuals are consistent with that setting and are not disqualifying.',
        );
        if (ticketed && audioSupportsVenue) {
            // Ticketed + actual venue-scale playback in a private-looking space =
            // the most-missed, most-liable case. Jump the queue.
            priorityEscalated = true;
            reviewReasons.push('Ticketed entry plus venue-scale playback detected — prioritised for review.');
        }
    }

    return {
        declared,
        spaceClass,
        baseSpaceClass: baseClass,
        agreement,                 // aligned | consistent | unverifiable | mismatch
        mismatchFlags,
        dispositionOverride,       // null | 'manual_review' (overlay, not the final word)
        priorityEscalated,
        reviewReason: reviewReasons.join(' ') || null,
        modelVersion: 'context-reconcile-v1',
    };
};
