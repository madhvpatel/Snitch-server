import assert from 'assert/strict';
import fs from 'fs';

import {
  DEFAULT_SOURCE_CLASSIFIER_MODE,
  analyzeAudioSource,
} from './sourceAnalysis.js';

const fixtures = [
  {
    name: 'Taphaus sports-bar playback does not classify as small speaker with score 100',
    path: 'data/assets/derived-audio/f4f9f280-484e-471b-9732-8b73336827db.wav',
    check(result) {
      assert.equal(result.sourceClass, 'likely_pa_system');
      assert.equal(result.score, 100);
      assert.match(result.explanation.at(-1), /likely pa system/i);
    },
  },
  {
    name: 'Lounge room playback uses FFT classifier and resolves as PA',
    path: 'data/assets/derived-audio/1569497d-3a9a-45d7-a287-cbf7f9d13416.wav',
    check(result) {
      assert.equal(result.sourceClass, 'likely_pa_system');
      assert.equal(result.classifierMode, DEFAULT_SOURCE_CLASSIFIER_MODE);
    },
  },
  {
    name: 'Music-free capture is labelled no_music, not a playback class',
    path: 'data/assets/derived-audio/e9a90e0f-0ff6-48ca-a016-2517ce834b0a.wav',
    check(result) {
      assert.equal(result.sourceClass, 'no_music');
      assert.equal(result.supportsVenuePlayback, false);
      assert.equal(result.operationalLabel, 'No music');
      assert.equal(result.signals.nonMusicGuardrail, 'no_music');
    },
  },
];

for (const fixture of fixtures) {
  if (!fs.existsSync(fixture.path)) {
    console.log(`SKIP ${fixture.name}: missing ${fixture.path}`);
    continue;
  }

  const result = analyzeAudioSource(fs.readFileSync(fixture.path), {
    mode: DEFAULT_SOURCE_CLASSIFIER_MODE,
  });
  fixture.check(result);
  console.log(`PASS ${fixture.name}`);
}
