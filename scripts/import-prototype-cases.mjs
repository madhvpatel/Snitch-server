import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { mutatePlatformData } from '../platformStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const defaultSourcePath = '/Users/madhavpatel/cases.json';

const getArgValue = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || '';
};

const dryRun = process.argv.includes('--dry-run');
const sourcePath = path.resolve(getArgValue('source') || defaultSourcePath);

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'));

const getPrototypeAudioStatusScore = (caseData) => {
  const layer = (caseData?.scoring?.evidenceLayers || []).find((item) => item?.id === 'audio_identity');
  return Number(layer?.score || 0);
};

const toPrototypeTenPointScore = (score) => Math.max(1, Math.min(10, Math.round(Number(score || 0) / 10)));

const hasResolvedPrototypeSong = (song = {}) => {
  const title = String(song?.title || '').trim().toLowerCase();
  const isrc = String(song?.isrc || '').trim().toLowerCase();
  const upc = String(song?.upc || '').trim().toLowerCase();
  const hasTitle = title && !['unknown track', 'unknown', 'unavailable', 'n/a'].includes(title);
  const hasIdentifier = [isrc, upc].some((value) => value && !['unavailable', 'unknown', 'n/a', 'none'].includes(value));
  return Boolean(hasTitle && hasIdentifier);
};

const cleanTokenText = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const getImportedBadCaseReasons = (caseData) => {
  const reasons = [];
  const venueStatus = String(caseData?.venueAttribution?.status || '').toLowerCase();
  const venueName = String(caseData?.location?.name || '');
  const visualText = cleanTokenText([
    caseData?.absoluteProof?.performanceContext,
    caseData?.absoluteProof?.obstructionFlags,
    caseData?.aiExplanation,
  ].filter(Boolean).join(' '));
  const sourceSignals = caseData?.sourceAssessment?.signals || {};
  const silenceRatio = Number(sourceSignals.silenceRatio || 0);
  const overallRms = Number(sourceSignals.overallRms || 0);

  if (venueStatus === 'coordinate_only' || /^Approx\. Venue/i.test(venueName)) {
    reasons.push('coordinate_only_venue');
  }
  if (visualText.includes('residential') || visualText.includes('living room') || visualText.includes('home')) {
    reasons.push('private_or_home_visual_context');
  }
  if (visualText.includes('checkerboard') || visualText.includes('television displaying')) {
    reasons.push('screen_or_test_pattern_visual');
  }
  if (visualText.includes('no audio') || visualText.includes('completely silent') || silenceRatio >= 0.9 || overallRms <= 0.0001) {
    reasons.push('silent_or_no_music_audio');
  }

  return [...new Set(reasons)];
};

const derivePrototypeQualityScore = (caseData) => {
  const trustGates = caseData?.trustGates || {};
  const song = caseData?.songAssessment || {};
  const absoluteProof = caseData?.absoluteProof || {};
  const locationDelta = caseData?.locationDelta || {};
  const source = caseData?.sourceAssessment || {};
  const sourceClass = String(source?.sourceClass || '').toLowerCase();
  const sourceScore = Number(source?.score || 0);
  const sourceConfidence = Number(source?.confidence || 0);
  const demucsStatus = String(
    caseData?.audioDeconstruction?.status
    || caseData?.demucsEvaluation?.status
    || ''
  ).toLowerCase();
  const frames = Array.isArray(absoluteProof?.venueImages) ? absoluteProof.venueImages : [];
  const aiText = String(caseData?.aiExplanation || '').toLowerCase();
  const hasResolvedSong = hasResolvedPrototypeSong(song);

  let score = 20;

  if (trustGates.mediaHashKey) score += 12;
  if (trustGates.payloadSignature) score += 14;
  if (trustGates.clockSkewDetection) score += 8;
  if (trustGates.geofencingContinuity) score += 4;
  if (trustGates.deviceTrustBand) score += 4;
  if (hasResolvedSong) {
    score += Math.min(18, Math.max(8, Math.round(getPrototypeAudioStatusScore(caseData) * 0.18)));
  }
  if (frames.length) score += 8;
  if (absoluteProof?.performanceContext) score += 4;
  if (locationDelta?.withinAccuracyEnvelope === true) score += 4;
  if (locationDelta?.selectedMatchedAligned === true) score += 3;
  if (sourceClass === 'likely_pa_system') score += sourceScore >= 90 ? 10 : 7;
  if (sourceClass === 'likely_pa_system' && sourceConfidence >= 0.75) score += 3;
  if (sourceClass === 'likely_small_speaker' && sourceScore >= 60) score += 4;
  if (demucsStatus === 'completed') score += 6;
  if (aiText.includes('direct feed') || aiText.includes('digital audio overlay')) score -= 18;

  const boundedScore = Math.max(0, Math.min(100, score));
  return hasResolvedSong ? boundedScore : Math.min(55, boundedScore);
};

const normalizeCase = (caseData, existingCase, importedAt) => {
  const sourceAssessment = caseData?.sourceAssessment || null;
  const qualityScore = derivePrototypeQualityScore(caseData);
  const hasResolvedSong = hasResolvedPrototypeSong(caseData?.songAssessment || {});
  const badCaseReasons = getImportedBadCaseReasons(caseData);
  const isBadCase = badCaseReasons.length >= 2;
  const effectiveQualityScore = isBadCase ? Math.min(20, qualityScore) : qualityScore;
  const stage = isBadCase ? 'Bad Case' : hasResolvedSong ? (caseData.stage || 'New') : 'Monitor / Enrich';

  return {
    ...caseData,
    id: caseData.id,
    stage,
    isNew: stage === 'New',
    qualityScore: effectiveQualityScore,
    qualityScore10: toPrototypeTenPointScore(effectiveQualityScore),
    scoreScale: '1-10',
    badCaseReasons,
    venueSourceConfidence: caseData?.venueAttribution?.score ?? null,
    songEnforcementConfidence: isBadCase ? 0 : hasResolvedSong ? effectiveQualityScore : Math.min(35, effectiveQualityScore),
    enforcementBlockReason: isBadCase
      ? `Bad case: ${badCaseReasons.join(', ')}. Extract signals only; do not enrich for enforcement.`
      : hasResolvedSong ? null : 'Track identity is unresolved; keep monitoring/enriching before enforcement.',
    scoreRecomputedAt: importedAt,
    importedFrom: sourcePath,
    importedAt,
    auditTrail: existingCase?.auditTrail || caseData.auditTrail || [],
    notes: existingCase?.notes || caseData.notes,
    signalSummary: caseData.signalSummary || (sourceAssessment ? {
      sourceClass: sourceAssessment.sourceClass || null,
      sourceScore: sourceAssessment.score ?? null,
      sourceConfidence: sourceAssessment.confidence ?? null,
      classifierMode: sourceAssessment.classifierMode || sourceAssessment.requestedMode || null,
    } : null),
  };
};

const payload = await readJson(sourcePath);
const cases = Array.isArray(payload) ? payload : payload.cases;

if (!Array.isArray(cases)) {
  throw new Error(`Expected ${sourcePath} to contain an array or { cases: [...] }`);
}

const importedAt = new Date().toISOString();
const normalizedCases = cases
  .filter((caseData) => caseData?.id)
  .map((caseData) => JSON.parse(JSON.stringify(caseData)));

if (!normalizedCases.length) {
  throw new Error(`No case records with ids were found in ${sourcePath}`);
}

let beforeCount = 0;
let afterCount = 0;

if (dryRun) {
  const ids = new Set(normalizedCases.map((caseData) => caseData.id));
  console.log(`Dry run: would import ${ids.size} prototype case(s) from ${sourcePath}.`);
  console.log(normalizedCases.map((caseData) => ({
    id: caseData.id,
    venue: caseData.location?.name,
    score: derivePrototypeQualityScore(caseData),
    stage: caseData.stage || 'New',
  })));
  process.exit(0);
}

await mutatePlatformData((data) => {
  const existingById = new Map((data.prototypeCases || []).map((caseData) => [caseData.id, caseData]));
  beforeCount = data.prototypeCases?.length || 0;
  data.prototypeCases = normalizedCases.map((caseData) => normalizeCase(
    caseData,
    existingById.get(caseData.id),
    importedAt,
  ));
  data.prototypeCasesImportedAt = importedAt;
  data.prototypeCasesSource = sourcePath;
  afterCount = data.prototypeCases.length;
});

console.log(`Imported ${afterCount} prototype case(s) from ${sourcePath}.`);
console.log(`Previous prototype case count: ${beforeCount}.`);
console.log(`Server data file: ${path.join(serverDir, 'data', 'platform-db.json')}`);
