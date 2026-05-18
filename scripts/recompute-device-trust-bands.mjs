import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const CLOCK_SKEW_TOLERANCE_MS = 5000;

const deriveDeviceTrustBand = ({ abuseScore, startOffset, endOffset }) => {
  const maxSkew = Math.max(Math.abs(Number(startOffset || 0)), Math.abs(Number(endOffset || 0)));
  if (maxSkew > CLOCK_SKEW_TOLERANCE_MS || Number(abuseScore || 0) >= 60) {
    return 'low';
  }
  if (Number(abuseScore || 0) >= 25 || maxSkew > 2500) {
    return 'medium';
  }
  return 'high';
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '..', 'data', 'platform-db.json');
const installIdArg = process.argv.find((arg) => arg.startsWith('--install-id='))?.slice('--install-id='.length)
  || process.argv[2]
  || '';

const raw = await fs.readFile(dbPath, 'utf8');
const data = JSON.parse(raw);
const submissionsById = new Map(data.submissions.map((submission) => [submission.id, submission]));
const installsById = new Map(data.anonymousInstalls.map((install) => [install.installId, install]));

let updated = 0;
const touchedInstalls = new Set();

data.reports = data.reports.map((report) => {
  const submission = submissionsById.get(report.submissionId);
  if (!submission?.installId) {
    return report;
  }

  if (installIdArg && submission.installId !== installIdArg) {
    return report;
  }

  const install = installsById.get(submission.installId);
  if (!install) {
    return report;
  }

  const nextBand = deriveDeviceTrustBand({
    abuseScore: install.abuseScore || 0,
    startOffset: submission.measuredStartOffsetMs,
    endOffset: submission.measuredEndOffsetMs,
  });

  if (report.deviceTrustBand === nextBand) {
    return report;
  }

  updated += 1;
  touchedInstalls.add(submission.installId);
  return {
    ...report,
    deviceTrustBand: nextBand,
    updatedAt: new Date().toISOString(),
  };
});

await fs.writeFile(dbPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

const scopeLabel = installIdArg || 'all installs';
console.log(`Recomputed device trust bands for ${scopeLabel}. Updated ${updated} report(s).`);
if (touchedInstalls.size) {
  console.log(`Touched install IDs: ${[...touchedInstalls].join(', ')}`);
}
