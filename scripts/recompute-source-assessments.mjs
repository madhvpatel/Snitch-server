import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  DEFAULT_SOURCE_CLASSIFIER_MODE,
  analyzeAudioSource,
  normalizeSourceClassifierMode,
} from '../sourceAnalysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const dbPath = path.join(serverDir, 'data', 'platform-db.json');
const derivedAudioDir = path.join(serverDir, 'data', 'assets', 'derived-audio');

const getArgValue = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || '';
};

const dryRun = process.argv.includes('--dry-run');
const submissionIdFilter = getArgValue('submission-id');
const mode = normalizeSourceClassifierMode(getArgValue('mode'), DEFAULT_SOURCE_CLASSIFIER_MODE);

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'));

const sourceAssessmentChanged = (current, next) => (
  JSON.stringify(current || null) !== JSON.stringify(next || null)
);

const syncApplicationSourceSummary = (assessment, sourceAnalysis) => {
  if (!assessment?.signalSummary || !sourceAnalysis) {
    return false;
  }

  let changed = false;
  if (assessment.signalSummary.sourceClass !== sourceAnalysis.sourceClass) {
    assessment.signalSummary.sourceClass = sourceAnalysis.sourceClass;
    changed = true;
  }
  if (assessment.signalSummary.sourceScore !== sourceAnalysis.score) {
    assessment.signalSummary.sourceScore = sourceAnalysis.score;
    changed = true;
  }
  if (assessment.signalSummary.sourceConfidence !== sourceAnalysis.confidence) {
    assessment.signalSummary.sourceConfidence = sourceAnalysis.confidence;
    changed = true;
  }
  return changed;
};

const data = await readJson(dbPath);
const reportsBySubmissionId = new Map();
for (const report of data.reports || []) {
  const reports = reportsBySubmissionId.get(report.submissionId) || [];
  reports.push(report);
  reportsBySubmissionId.set(report.submissionId, reports);
}

let scanned = 0;
let missingAudio = 0;
let failed = 0;
let updatedSubmissions = 0;
let updatedReports = 0;
const failures = [];

for (const submission of data.submissions || []) {
  if (submissionIdFilter && submission.id !== submissionIdFilter) {
    continue;
  }
  if (!submission.derivedAudioAssetId) {
    continue;
  }

  scanned += 1;
  const audioPath = path.join(derivedAudioDir, `${submission.derivedAudioAssetId}.wav`);
  let audioBuffer;
  try {
    audioBuffer = await fs.readFile(audioPath);
  } catch (error) {
    missingAudio += 1;
    failures.push(`${submission.reference || submission.id}: missing ${audioPath}`);
    continue;
  }

  let sourceAnalysis;
  try {
    sourceAnalysis = analyzeAudioSource(audioBuffer, {
      mode: submission.sourceClassifierMode || mode,
    });
  } catch (error) {
    failed += 1;
    failures.push(`${submission.reference || submission.id}: ${error.message}`);
    continue;
  }

  const now = new Date().toISOString();
  if (sourceAssessmentChanged(submission.sourceAnalysis, sourceAnalysis)) {
    submission.sourceAnalysis = sourceAnalysis;
    submission.updatedAt = now;
    syncApplicationSourceSummary(submission.applicationAssessment, sourceAnalysis);
    updatedSubmissions += 1;
  }

  for (const report of reportsBySubmissionId.get(submission.id) || []) {
    if (sourceAssessmentChanged(report.sourceAnalysis, sourceAnalysis)) {
      report.sourceAnalysis = sourceAnalysis;
      report.updatedAt = now;
      syncApplicationSourceSummary(report.applicationAssessment, sourceAnalysis);
      updatedReports += 1;
    }
  }
}

if (!dryRun) {
  await fs.writeFile(dbPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

console.log(`Recomputed source assessments using ${mode}${dryRun ? ' (dry run)' : ''}.`);
console.log(`Scanned ${scanned} submission(s). Updated ${updatedSubmissions} submission(s), ${updatedReports} report(s).`);
console.log(`Missing audio: ${missingAudio}. Failed analysis: ${failed}.`);
if (failures.length) {
  console.log('Failures:');
  for (const failure of failures.slice(0, 20)) {
    console.log(`- ${failure}`);
  }
  if (failures.length > 20) {
    console.log(`- ... ${failures.length - 20} more`);
  }
}
