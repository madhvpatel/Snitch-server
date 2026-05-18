const EPSILON = 1e-6;
const ANALYSIS_WINDOW_SECONDS = 3;
const WINDOW_SCAN_STEP_SECONDS = 0.25;

export const SOURCE_CLASSIFIER_MODES = Object.freeze({
    STABLE: 'source-v1',
    FFT_EXPERIMENTAL: 'source-v2-fft',
});

export const normalizeSourceClassifierMode = (value, fallback = SOURCE_CLASSIFIER_MODES.STABLE) => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';

    if (
        normalized === SOURCE_CLASSIFIER_MODES.FFT_EXPERIMENTAL
        || normalized === 'source-v2'
        || normalized === 'fft'
        || normalized === 'experimental'
    ) {
        return SOURCE_CLASSIFIER_MODES.FFT_EXPERIMENTAL;
    }

    if (
        normalized === SOURCE_CLASSIFIER_MODES.STABLE
        || normalized === 'stable'
        || normalized === 'legacy'
        || normalized === 'default'
    ) {
        return SOURCE_CLASSIFIER_MODES.STABLE;
    }

    return fallback;
};

export const DEFAULT_SOURCE_CLASSIFIER_MODE = normalizeSourceClassifierMode(
    process.env.SOURCE_CLASSIFIER_MODE,
    SOURCE_CLASSIFIER_MODES.STABLE
);

const THIRD_OCTAVE_CENTERS = [
    25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315,
    400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
    4000, 5000, 6300, 8000, 10000, 12500,
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const average = (values) => (
    values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0
);

const variance = (values) => {
    if (!values.length) {
        return 0;
    }

    const mean = average(values);
    return average(values.map((value) => {
        const delta = value - mean;
        return delta * delta;
    }));
};

const percentile = (values, ratio) => {
    if (!values.length) {
        return 0;
    }

    const sorted = values.slice().sort((left, right) => left - right);
    const index = clamp(Math.floor((sorted.length - 1) * ratio), 0, sorted.length - 1);
    return sorted[index];
};

const rms = (values) => {
    if (!values.length) {
        return 0;
    }

    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
        sum += values[index] * values[index];
    }
    return Math.sqrt(sum / values.length);
};

const peak = (values) => {
    let max = 0;
    for (let index = 0; index < values.length; index += 1) {
        const amplitude = Math.abs(values[index]);
        if (amplitude > max) {
            max = amplitude;
        }
    }
    return max;
};

const toRatio = (numerator, denominator) => numerator / Math.max(denominator, EPSILON);

const readAscii = (buffer, start, end) => buffer.toString('ascii', start, end);

const decodeMonoWav = (wavBuffer) => {
    if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length < 44) {
        throw new Error('WAV buffer is too small');
    }
    if (readAscii(wavBuffer, 0, 4) !== 'RIFF' || readAscii(wavBuffer, 8, 12) !== 'WAVE') {
        throw new Error('Unsupported WAV container');
    }

    let fmt = null;
    let dataOffset = -1;
    let dataSize = 0;
    let offset = 12;

    while (offset + 8 <= wavBuffer.length) {
        const chunkId = readAscii(wavBuffer, offset, offset + 4);
        const chunkSize = wavBuffer.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;
        const chunkEnd = chunkStart + chunkSize;

        if (chunkEnd > wavBuffer.length) {
            break;
        }

        if (chunkId === 'fmt ') {
            fmt = {
                audioFormat: wavBuffer.readUInt16LE(chunkStart),
                channels: wavBuffer.readUInt16LE(chunkStart + 2),
                sampleRate: wavBuffer.readUInt32LE(chunkStart + 4),
                bitsPerSample: wavBuffer.readUInt16LE(chunkStart + 14),
            };
        } else if (chunkId === 'data') {
            dataOffset = chunkStart;
            dataSize = chunkSize;
            break;
        }

        offset = chunkEnd + (chunkSize % 2);
    }

    if (!fmt || dataOffset === -1 || !dataSize) {
        throw new Error('WAV file is missing fmt/data chunks');
    }

    const bytesPerSample = fmt.bitsPerSample / 8;
    const bytesPerFrame = bytesPerSample * fmt.channels;
    const frameCount = Math.floor(dataSize / bytesPerFrame);
    const samples = new Float32Array(frameCount);

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        let monoValue = 0;

        for (let channel = 0; channel < fmt.channels; channel += 1) {
            const sampleOffset = dataOffset + (frameIndex * bytesPerFrame) + (channel * bytesPerSample);
            let channelValue = 0;

            if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) {
                channelValue = wavBuffer.readInt16LE(sampleOffset) / 32768;
            } else if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
                channelValue = wavBuffer.readFloatLE(sampleOffset);
            } else {
                throw new Error(`Unsupported WAV encoding: format=${fmt.audioFormat} bits=${fmt.bitsPerSample}`);
            }

            monoValue += channelValue;
        }

        samples[frameIndex] = monoValue / Math.max(fmt.channels, 1);
    }

    return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bitsPerSample,
        durationSeconds: frameCount / fmt.sampleRate,
        samples,
    };
};

const extractWindow = (samples, sampleRate) => {
    const targetLength = Math.min(samples.length, Math.max(1, Math.floor(sampleRate * ANALYSIS_WINDOW_SECONDS)));
    if (samples.length <= targetLength) {
        return {
            window: samples,
            startSample: 0,
        };
    }

    const scanStep = Math.max(1, Math.floor(sampleRate * WINDOW_SCAN_STEP_SECONDS));
    let bestStart = 0;
    let bestEnergy = -1;

    for (let start = 0; start + targetLength <= samples.length; start += scanStep) {
        let sum = 0;
        const stride = 32;
        for (let index = start; index < start + targetLength; index += stride) {
            const value = samples[index];
            sum += value * value;
        }

        if (sum > bestEnergy) {
            bestEnergy = sum;
            bestStart = start;
        }
    }

    return {
        window: samples.subarray(bestStart, bestStart + targetLength),
        startSample: bestStart,
    };
};

const extractWindowSegments = (samples, sampleRate) => {
    const targetLength = Math.min(samples.length, Math.max(1, Math.floor(sampleRate * ANALYSIS_WINDOW_SECONDS)));

    if (samples.length <= targetLength) {
        return [{
            window: samples,
            startSample: 0,
        }];
    }

    const scanStep = Math.max(1, Math.floor(sampleRate * WINDOW_SCAN_STEP_SECONDS));
    const segments = [];

    for (let start = 0; start + targetLength <= samples.length; start += scanStep) {
        segments.push({
            window: samples.subarray(start, start + targetLength),
            startSample: start,
        });
    }

    const lastStart = samples.length - targetLength;
    if (!segments.length || segments[segments.length - 1].startSample !== lastStart) {
        segments.push({
            window: samples.subarray(lastStart, lastStart + targetLength),
            startSample: lastStart,
        });
    }

    return segments;
};

const frameSignal = (samples, sampleRate, frameMs = 50, hopMs = 25) => {
    const frameLength = Math.max(1, Math.floor(sampleRate * (frameMs / 1000)));
    const hopLength = Math.max(1, Math.floor(sampleRate * (hopMs / 1000)));
    const frames = [];

    for (let start = 0; start + frameLength <= samples.length; start += hopLength) {
        frames.push(rms(samples.subarray(start, start + frameLength)));
    }

    return frames;
};

const measureTemporalFeatures = (window, sampleRate) => {
    const frameRms = frameSignal(window, sampleRate);
    const overallRms = rms(window);
    const peakAmplitude = peak(window);
    const p10 = percentile(frameRms, 0.1);
    const p25 = percentile(frameRms, 0.25);
    const p90 = percentile(frameRms, 0.9);
    const silenceThreshold = Math.max(p10 * 1.25, p90 * 0.12);
    const silenceRatio = frameRms.length
        ? frameRms.filter((value) => value <= silenceThreshold).length / frameRms.length
        : 1;

    return {
        overallRms,
        peakAmplitude,
        p10,
        p25,
        p90,
        silenceRatio,
        ambientContinuity: toRatio(p25, p90),
        dynamicRange: toRatio(p90, p10 || overallRms * 0.25 || EPSILON),
        crestFactor: toRatio(peakAmplitude, overallRms),
    };
};

const summarizeDistribution = (values) => {
    const mean = average(values);
    const p10 = percentile(values, 0.1);
    const p25 = percentile(values, 0.25);
    const median = percentile(values, 0.5);
    const p90 = percentile(values, 0.9);
    const valueVariance = variance(values);
    const stdDev = Math.sqrt(valueVariance);

    return {
        mean,
        p10,
        p25,
        median,
        p90,
        variance: valueVariance,
        stdDev,
        cv: toRatio(stdDev, mean),
    };
};

const computeNormalizedSlope = (values) => {
    if (values.length < 2) {
        return 0;
    }

    const meanY = average(values);
    const meanX = (values.length - 1) / 2;
    let numerator = 0;
    let denominator = 0;

    for (let index = 0; index < values.length; index += 1) {
        const x = index - meanX;
        numerator += x * (values[index] - meanY);
        denominator += x * x;
    }

    if (!denominator) {
        return 0;
    }

    const slopePerWindow = numerator / denominator;
    return (slopePerWindow / Math.max(meanY, EPSILON)) * Math.max(values.length - 1, 1);
};

const goertzelPower = (samples, sampleRate, targetFrequency) => {
    if (!samples.length || targetFrequency <= 0 || targetFrequency >= sampleRate / 2) {
        return 0;
    }

    const omega = (2 * Math.PI * targetFrequency) / sampleRate;
    const coeff = 2 * Math.cos(omega);
    let q0 = 0;
    let q1 = 0;
    let q2 = 0;

    for (let index = 0; index < samples.length; index += 1) {
        q0 = coeff * q1 - q2 + samples[index];
        q2 = q1;
        q1 = q0;
    }

    const power = q1 * q1 + q2 * q2 - coeff * q1 * q2;
    return Math.max(power, 0) / samples.length;
};

const measureProbeBandEnergy = (samples, sampleRate, frequencies) => {
    const magnitudes = frequencies
        .map((frequency) => Math.sqrt(goertzelPower(samples, sampleRate, frequency)))
        .filter((value) => Number.isFinite(value));

    return average(magnitudes);
};

const nextPowerOfTwo = (value) => {
    let power = 1;
    while (power < value) {
        power *= 2;
    }
    return power;
};

const fftRadix2 = (real, imag) => {
    const size = real.length;
    let j = 0;

    for (let i = 0; i < size; i += 1) {
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }

        let bit = size >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
    }

    for (let len = 2; len <= size; len <<= 1) {
        const angle = (-2 * Math.PI) / len;
        const halfLen = len >> 1;
        const wLenCos = Math.cos(angle);
        const wLenSin = Math.sin(angle);

        for (let start = 0; start < size; start += len) {
            let wCos = 1;
            let wSin = 0;

            for (let offset = 0; offset < halfLen; offset += 1) {
                const evenIndex = start + offset;
                const oddIndex = evenIndex + halfLen;

                const oddReal = real[oddIndex] * wCos - imag[oddIndex] * wSin;
                const oddImag = real[oddIndex] * wSin + imag[oddIndex] * wCos;

                real[oddIndex] = real[evenIndex] - oddReal;
                imag[oddIndex] = imag[evenIndex] - oddImag;
                real[evenIndex] += oddReal;
                imag[evenIndex] += oddImag;

                const nextCos = wCos * wLenCos - wSin * wLenSin;
                const nextSin = wCos * wLenSin + wSin * wLenCos;
                wCos = nextCos;
                wSin = nextSin;
            }
        }
    }
};

const computeThirdOctaveBandProfile = (samples, sampleRate) => {
    const fftSize = nextPowerOfTwo(samples.length);
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);
    const denominator = Math.max(samples.length - 1, 1);

    for (let index = 0; index < samples.length; index += 1) {
        const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / denominator);
        real[index] = samples[index] * hann;
    }

    fftRadix2(real, imag);

    const nyquist = sampleRate / 2;
    const binSize = sampleRate / fftSize;
    const powers = new Float64Array(Math.floor(fftSize / 2) + 1);

    for (let bin = 1; bin < powers.length; bin += 1) {
        powers[bin] = real[bin] * real[bin] + imag[bin] * imag[bin];
    }

    const bands = THIRD_OCTAVE_CENTERS
        .filter((centerHz) => centerHz < nyquist)
        .map((centerHz) => {
            const lower = centerHz / (2 ** (1 / 6));
            const upper = centerHz * (2 ** (1 / 6));
            const startBin = clamp(Math.floor(lower / binSize), 1, powers.length - 1);
            const endBin = clamp(Math.ceil(upper / binSize), startBin, powers.length - 1);

            let sum = 0;
            let count = 0;
            for (let bin = startBin; bin <= endBin; bin += 1) {
                sum += powers[bin];
                count += 1;
            }

            const energy = Math.sqrt(sum / Math.max(count, 1));
            return { centerHz, energy };
        });

    const maxEnergy = Math.max(...bands.map((band) => band.energy), EPSILON);
    const bandCoverageRatio = bands.length
        ? bands.filter((band) => band.energy >= maxEnergy * 0.12).length / bands.length
        : 0;

    return {
        bands,
        bandCoverageRatio,
    };
};

const aggregateBandRangeEnergy = (bands, minHz, maxHz) => {
    const selected = bands
        .filter((band) => band.centerHz >= minHz && band.centerHz <= maxHz)
        .map((band) => band.energy);

    return average(selected);
};

const aggregateBandRangeDistribution = (bandStats, minHz, maxHz, metric = 'median') => {
    const selected = bandStats
        .filter((band) => band.centerHz >= minHz && band.centerHz <= maxHz)
        .map((band) => band[metric]);

    return average(selected);
};

const computeBandCoverageRatio = (bandStats, metric = 'median') => {
    const energies = bandStats.map((band) => band[metric]).filter((value) => Number.isFinite(value));
    const maxEnergy = Math.max(...energies, EPSILON);

    return energies.length
        ? energies.filter((value) => value >= maxEnergy * 0.12).length / energies.length
        : 0;
};

const buildExplanationV1 = (features, score, sourceClass) => {
    const notes = [];

    if (features.subToMidRatio >= 0.18) {
        notes.push('Low-end energy is strong relative to mids, which is more consistent with larger playback hardware.');
    } else if (features.subToMidRatio <= 0.05) {
        notes.push('Sub-bass is weak relative to mids, which is more consistent with phone or laptop playback.');
    }

    if (features.ambientContinuity >= 0.2) {
        notes.push('Energy remains present between louder moments, which suggests room playback rather than close direct playback.');
    } else if (features.ambientContinuity <= 0.08) {
        notes.push('The recording has a thin, close-feeling energy floor with limited room bed.');
    }

    if (features.highToMidRatio <= 0.06) {
        notes.push('High-frequency roll-off is steep, which weakens the case for a larger installed PA.');
    } else if (features.highToMidRatio >= 0.14) {
        notes.push('High-frequency extension is reasonably preserved, which is less typical of tiny device speakers.');
    }

    if (features.silenceRatio >= 0.35) {
        notes.push('Large portions of the analysis window fall near silence, so the result is less decisive.');
    }

    if (features.nearFieldBloomSuspicion >= 1) {
        notes.push('Strong bass combined with unusually steady loudness can also come from a nearby phone or small speaker, so PA certainty is reduced.');
    }

    if (!notes.length) {
        notes.push('The measured signals are mixed, so the result should be treated as directional rather than conclusive.');
    }

    notes.push(`Deterministic source score: ${Math.round(score)}/100 (${sourceClass.replaceAll('_', ' ')}).`);
    return notes;
};

const buildExplanationV2 = (features, score, sourceClass) => {
    const notes = [];

    if (features.lowMidToMidRatio >= 0.3) {
        notes.push('Low-mid continuity through roughly 160–315 Hz is preserved, which is more consistent with fuller playback systems.');
    } else if (features.lowMidToMidRatio <= 0.14) {
        notes.push('Energy thins out through the 160–315 Hz region, which is more consistent with small personal playback devices.');
    }

    if (features.subToMidRatio >= 0.16) {
        notes.push('Sub-bass remains present relative to the mid-band, which supports larger playback hardware more than phone playback.');
    } else if (features.subToMidRatio <= 0.06) {
        notes.push('Sub-bass support is weak relative to the mid-band, which weakens the case for venue-scale playback.');
    }

    if (features.bandCoverageRatio >= 0.45) {
        notes.push('Energy is distributed across a broader third-octave span, which is less typical of tiny built-in speakers.');
    } else if (features.bandCoverageRatio <= 0.22) {
        notes.push('The spectral footprint is narrow across third-octave bands, which is more consistent with constrained playback hardware.');
    }

    if (features.ambientContinuity >= 0.42) {
        notes.push('Cross-window energy stays comparatively stable across the clip, which is more consistent with installed playback than with a nearby handheld device.');
    } else if (features.ambientContinuity <= 0.2) {
        notes.push('Cross-window energy swings sharply across the clip, which is more consistent with personal-device movement or unstable near-field playback.');
    }

    if (features.windowEnergySlope <= -0.3) {
        notes.push('Energy decays across the clip rather than holding flat, which weakens the case for fixed venue playback.');
    } else if (Math.abs(features.windowEnergySlope) <= 0.12) {
        notes.push('The clip envelope stays comparatively flat over time, which is consistent with steady room playback.');
    }

    if (features.windowEnergyCv <= 0.5) {
        notes.push('Window-to-window variance remains controlled, which supports a stable playback source.');
    } else if (features.windowEnergyCv >= 0.95) {
        notes.push('Window-to-window variance is high, which is more consistent with personal or moving playback sources.');
    }

    if (features.nearFieldBloomSuspicion >= 1) {
        notes.push('Bass is strong, but the spectral shape and steadiness still fit a nearby small speaker or phone, so PA certainty is reduced.');
    }

    if (!notes.length) {
        notes.push('The third-octave profile is mixed, so this result should be treated as directional rather than conclusive.');
    }

    notes.push(`Experimental FFT source score: ${Math.round(score)}/100 (${sourceClass.replaceAll('_', ' ')}).`);
    return notes;
};

const finalizeClassification = ({
    score,
    sourceClass,
    confidence,
    features,
    explanation,
    modelVersion,
}) => ({
    sourceClass,
    confidence: Number(confidence.toFixed(2)),
    score: Math.round(score),
    signals: features,
    explanation,
    modelVersion,
});

const analyzeAudioSourceV1 = (decoded, window, startSample) => {
    const temporal = measureTemporalFeatures(window, decoded.sampleRate);
    const subEnergy = measureProbeBandEnergy(window, decoded.sampleRate, [30, 40, 50, 60]);
    const bassEnergy = measureProbeBandEnergy(window, decoded.sampleRate, [80, 100, 120]);
    const midEnergy = measureProbeBandEnergy(window, decoded.sampleRate, [300, 500, 800, 1200, 1800]);
    const highEnergy = measureProbeBandEnergy(window, decoded.sampleRate, [6000, 8000, 10000]);

    const subToMidRatio = toRatio(subEnergy, midEnergy);
    const bassToMidRatio = toRatio(bassEnergy, midEnergy);
    const highToMidRatio = toRatio(highEnergy, midEnergy);
    const nearFieldBloomSuspicion = Number(
        subToMidRatio >= 0.3
        && bassToMidRatio >= 0.5
        && temporal.ambientContinuity >= 0.55
        && temporal.dynamicRange <= 2.5
        && temporal.silenceRatio >= 0.3
    );

    let score = 50;

    if (subToMidRatio >= 0.18) {
        score += 18;
    } else if (subToMidRatio >= 0.1) {
        score += 9;
    } else if (subToMidRatio <= 0.05) {
        score -= 18;
    } else if (subToMidRatio <= 0.08) {
        score -= 8;
    }

    if (bassToMidRatio >= 0.22) {
        score += 8;
    } else if (bassToMidRatio <= 0.08) {
        score -= 6;
    }

    if (highToMidRatio >= 0.14) {
        score += 4;
    } else if (highToMidRatio <= 0.06) {
        score -= 6;
    }

    if (temporal.ambientContinuity >= 0.2) {
        score += 10;
    } else if (temporal.ambientContinuity >= 0.12) {
        score += 4;
    } else if (temporal.ambientContinuity <= 0.08) {
        score -= 10;
    }

    if (temporal.silenceRatio <= 0.18) {
        score += 4;
    } else if (temporal.silenceRatio >= 0.35) {
        score -= 6;
    }

    if (temporal.crestFactor <= 4.5) {
        score += 4;
    } else if (temporal.crestFactor >= 8) {
        score -= 4;
    }

    if (temporal.dynamicRange <= 6) {
        score += 4;
    } else if (temporal.dynamicRange >= 12) {
        score -= 4;
    }

    if (subToMidRatio >= 0.16 && temporal.ambientContinuity >= 0.16) {
        score += 6;
    }
    if (subToMidRatio <= 0.05 && temporal.ambientContinuity <= 0.08 && highToMidRatio <= 0.06) {
        score -= 8;
    }
    if (nearFieldBloomSuspicion) {
        score -= 20;
    }

    score = clamp(score, 0, 100);

    const weakSignal = temporal.overallRms < 0.01 || temporal.p90 < 0.015;
    const conflictingSignals = (
        (subToMidRatio >= 0.15 && temporal.ambientContinuity <= 0.08)
        || (subToMidRatio <= 0.06 && temporal.ambientContinuity >= 0.2)
    );
    const paDisqualifier = nearFieldBloomSuspicion || temporal.silenceRatio >= 0.35;

    let sourceClass = 'inconclusive';
    if (!weakSignal && !conflictingSignals) {
        if (score >= 72 && !paDisqualifier) {
            sourceClass = 'likely_pa_system';
        } else if (score >= 56) {
            sourceClass = 'likely_small_speaker';
        } else if (score <= 35) {
            sourceClass = 'likely_personal_device';
        }
    }

    let confidence = clamp(0.45 + (Math.abs(score - 50) / 50) * 0.4, 0.45, 0.9);
    if (sourceClass === 'inconclusive') {
        confidence = clamp(confidence - 0.15, 0.3, 0.65);
    }
    if (weakSignal) {
        confidence = clamp(confidence - 0.1, 0.25, 0.6);
    }
    if (conflictingSignals) {
        confidence = clamp(confidence - 0.12, 0.25, 0.6);
    }
    if (nearFieldBloomSuspicion) {
        confidence = clamp(confidence - 0.08, 0.25, 0.7);
    }

    const features = {
        subToMidRatio: Number(subToMidRatio.toFixed(3)),
        bassToMidRatio: Number(bassToMidRatio.toFixed(3)),
        highToMidRatio: Number(highToMidRatio.toFixed(3)),
        ambientContinuity: Number(temporal.ambientContinuity.toFixed(3)),
        silenceRatio: Number(temporal.silenceRatio.toFixed(3)),
        dynamicRange: Number(temporal.dynamicRange.toFixed(3)),
        crestFactor: Number(temporal.crestFactor.toFixed(3)),
        overallRms: Number(temporal.overallRms.toFixed(4)),
        nearFieldBloomSuspicion,
        analysisWindowStartSeconds: Number((startSample / decoded.sampleRate).toFixed(2)),
        analysisWindowDurationSeconds: Number((window.length / decoded.sampleRate).toFixed(2)),
    };

    return finalizeClassification({
        score,
        sourceClass,
        confidence,
        features,
        explanation: buildExplanationV1(features, score, sourceClass),
        modelVersion: SOURCE_CLASSIFIER_MODES.STABLE,
    });
};

const analyzeAudioSourceV2 = (decoded, window, startSample) => {
    const representativeTemporal = measureTemporalFeatures(window, decoded.sampleRate);
    const windowSegments = extractWindowSegments(decoded.samples, decoded.sampleRate);
    const windowAnalyses = windowSegments.map((segment) => {
        const temporal = measureTemporalFeatures(segment.window, decoded.sampleRate);
        const spectral = computeThirdOctaveBandProfile(segment.window, decoded.sampleRate);
        const bandCoverageRatio = spectral.bandCoverageRatio;

        return {
            startSample: segment.startSample,
            temporal,
            spectral,
            bandCoverageRatio,
            subEnergy: aggregateBandRangeEnergy(spectral.bands, 31.5, 63),
            bassEnergy: aggregateBandRangeEnergy(spectral.bands, 80, 125),
            lowMidEnergy: aggregateBandRangeEnergy(spectral.bands, 160, 315),
            midEnergy: aggregateBandRangeEnergy(spectral.bands, 400, 1600),
            presenceEnergy: aggregateBandRangeEnergy(spectral.bands, 2000, 3150),
            highEnergy: aggregateBandRangeEnergy(spectral.bands, 4000, 10000),
        };
    });

    const peakWindowAnalysis = windowAnalyses.find((analysis) => analysis.startSample === startSample) || {
        startSample,
        temporal: representativeTemporal,
        spectral: computeThirdOctaveBandProfile(window, decoded.sampleRate),
        bandCoverageRatio: 0,
        subEnergy: 0,
        bassEnergy: 0,
        lowMidEnergy: 0,
        midEnergy: 0,
        presenceEnergy: 0,
        highEnergy: 0,
    };

    if (!peakWindowAnalysis.bandCoverageRatio) {
        peakWindowAnalysis.bandCoverageRatio = peakWindowAnalysis.spectral.bandCoverageRatio;
        peakWindowAnalysis.subEnergy = aggregateBandRangeEnergy(peakWindowAnalysis.spectral.bands, 31.5, 63);
        peakWindowAnalysis.bassEnergy = aggregateBandRangeEnergy(peakWindowAnalysis.spectral.bands, 80, 125);
        peakWindowAnalysis.lowMidEnergy = aggregateBandRangeEnergy(peakWindowAnalysis.spectral.bands, 160, 315);
        peakWindowAnalysis.midEnergy = aggregateBandRangeEnergy(peakWindowAnalysis.spectral.bands, 400, 1600);
        peakWindowAnalysis.presenceEnergy = aggregateBandRangeEnergy(peakWindowAnalysis.spectral.bands, 2000, 3150);
        peakWindowAnalysis.highEnergy = aggregateBandRangeEnergy(peakWindowAnalysis.spectral.bands, 4000, 10000);
    }

    const bandTemplate = peakWindowAnalysis.spectral.bands;
    const bandStats = bandTemplate.map((band, bandIndex) => {
        const energies = windowAnalyses.map((analysis) => analysis.spectral.bands[bandIndex]?.energy || 0);
        return {
            centerHz: band.centerHz,
            ...summarizeDistribution(energies),
        };
    });

    const lowMidStats = summarizeDistribution(windowAnalyses.map((analysis) => analysis.lowMidEnergy));
    const bandCoverageStats = summarizeDistribution(windowAnalyses.map((analysis) => analysis.bandCoverageRatio));
    const overallEnergyStats = summarizeDistribution(windowAnalyses.map((analysis) => analysis.temporal.overallRms));
    const silenceStats = summarizeDistribution(windowAnalyses.map((analysis) => analysis.temporal.silenceRatio));
    const dynamicRangeStats = summarizeDistribution(windowAnalyses.map((analysis) => analysis.temporal.dynamicRange));
    const crestFactorStats = summarizeDistribution(windowAnalyses.map((analysis) => analysis.temporal.crestFactor));
    const temporalContinuityStats = summarizeDistribution(windowAnalyses.map((analysis) => analysis.temporal.ambientContinuity));

    const subEnergy = aggregateBandRangeDistribution(bandStats, 31.5, 63);
    const bassEnergy = aggregateBandRangeDistribution(bandStats, 80, 125);
    const lowMidEnergy = aggregateBandRangeDistribution(bandStats, 160, 315);
    const midEnergy = aggregateBandRangeDistribution(bandStats, 400, 1600);
    const presenceEnergy = aggregateBandRangeDistribution(bandStats, 2000, 3150);
    const highEnergy = aggregateBandRangeDistribution(bandStats, 4000, 10000);

    const subToMidRatio = toRatio(subEnergy, midEnergy);
    const bassToMidRatio = toRatio(bassEnergy, midEnergy);
    const lowMidToMidRatio = toRatio(lowMidEnergy, midEnergy);
    const presenceToMidRatio = toRatio(presenceEnergy, midEnergy);
    const highToMidRatio = toRatio(highEnergy, midEnergy);
    const bandCoverageRatio = computeBandCoverageRatio(bandStats);
    const ambientContinuity = toRatio(overallEnergyStats.p25, overallEnergyStats.p90);
    const lowMidWindowContinuity = toRatio(lowMidStats.p25, lowMidStats.p90);
    const windowEnergyCv = overallEnergyStats.cv;
    const lowMidWindowCv = lowMidStats.cv;
    const windowEnergySlope = computeNormalizedSlope(windowAnalyses.map((analysis) => analysis.temporal.overallRms));
    const lowMidEnergySlope = computeNormalizedSlope(windowAnalyses.map((analysis) => analysis.lowMidEnergy));
    const silenceRatio = silenceStats.median;
    const dynamicRange = dynamicRangeStats.median;
    const crestFactor = crestFactorStats.median;
    const peakAmbientContinuity = peakWindowAnalysis.temporal.ambientContinuity;
    const peakBandCoverageRatio = peakWindowAnalysis.bandCoverageRatio;

    const nearFieldBloomSuspicion = Number(
        subToMidRatio >= 0.22
        && lowMidToMidRatio <= 0.22
        && ambientContinuity >= 0.28
        && windowEnergyCv <= 0.7
        && silenceRatio >= 0.22
        && Math.abs(windowEnergySlope) <= 0.18
    );

    let score = 50;

    if (subToMidRatio >= 0.16) {
        score += 10;
    } else if (subToMidRatio >= 0.1) {
        score += 5;
    } else if (subToMidRatio <= 0.06) {
        score -= 12;
    }

    if (bassToMidRatio >= 0.22) {
        score += 8;
    } else if (bassToMidRatio <= 0.1) {
        score -= 6;
    }

    if (lowMidToMidRatio >= 0.32) {
        score += 12;
    } else if (lowMidToMidRatio >= 0.22) {
        score += 6;
    } else if (lowMidToMidRatio <= 0.14) {
        score -= 12;
    } else if (lowMidToMidRatio <= 0.18) {
        score -= 6;
    }

    if (presenceToMidRatio >= 0.18) {
        score += 3;
    } else if (presenceToMidRatio <= 0.08) {
        score -= 4;
    }

    if (highToMidRatio >= 0.1) {
        score += 4;
    } else if (highToMidRatio <= 0.04) {
        score -= 6;
    }

    if (bandCoverageRatio >= 0.45) {
        score += 6;
    } else if (bandCoverageRatio <= 0.22) {
        score -= 6;
    }

    if (ambientContinuity >= 0.42) {
        score += 10;
    } else if (ambientContinuity >= 0.28) {
        score += 8;
    } else if (ambientContinuity <= 0.2) {
        score -= 8;
    }

    if (lowMidWindowContinuity >= 0.34) {
        score += 6;
    } else if (lowMidWindowContinuity <= 0.16) {
        score -= 6;
    }

    if (windowEnergyCv <= 0.45) {
        score += 5;
    } else if (windowEnergyCv >= 0.95) {
        score -= 7;
    }

    if (lowMidWindowCv <= 0.5) {
        score += 3;
    } else if (lowMidWindowCv >= 1.05) {
        score -= 5;
    }

    if (windowEnergySlope <= -0.3) {
        score -= 8;
    } else if (Math.abs(windowEnergySlope) <= 0.12) {
        score += 3;
    }

    if (silenceRatio <= 0.18) {
        score += 4;
    } else if (silenceRatio >= 0.38) {
        score -= 6;
    }

    if (crestFactor <= 5) {
        score += 4;
    } else if (crestFactor >= 8.5) {
        score -= 4;
    }

    if (dynamicRange <= 6.5) {
        score += 4;
    } else if (dynamicRange >= 11) {
        score -= 4;
    }

    if (subToMidRatio >= 0.14 && lowMidToMidRatio >= 0.24 && ambientContinuity >= 0.28 && windowEnergyCv <= 0.6) {
        score += 8;
    }
    if (lowMidToMidRatio <= 0.14 && highToMidRatio <= 0.05 && bandCoverageRatio <= 0.25) {
        score -= 8;
    }
    if (windowEnergySlope <= -0.45 && lowMidToMidRatio <= 0.2) {
        score -= 6;
    }
    if (nearFieldBloomSuspicion) {
        score -= 16;
    }

    score = clamp(score, 0, 100);

    const weakSignal = overallEnergyStats.mean < 0.01 || overallEnergyStats.p90 < 0.015;
    const conflictingSignals = (
        (subToMidRatio >= 0.14 && lowMidToMidRatio <= 0.14 && ambientContinuity <= 0.22)
        || (subToMidRatio <= 0.06 && lowMidToMidRatio >= 0.26 && ambientContinuity >= 0.45)
    );
    const paDisqualifier = nearFieldBloomSuspicion || silenceRatio >= 0.38 || windowEnergySlope <= -0.45;

    let sourceClass = 'inconclusive';
    if (!weakSignal && !conflictingSignals) {
        if (score >= 74 && !paDisqualifier) {
            sourceClass = 'likely_pa_system';
        } else if (score >= 56) {
            sourceClass = 'likely_small_speaker';
        } else if (score <= 34) {
            sourceClass = 'likely_personal_device';
        }
    }

    let confidence = clamp(0.45 + (Math.abs(score - 50) / 50) * 0.4, 0.45, 0.92);
    if (sourceClass === 'inconclusive') {
        confidence = clamp(confidence - 0.15, 0.3, 0.68);
    }
    if (weakSignal) {
        confidence = clamp(confidence - 0.1, 0.25, 0.6);
    }
    if (conflictingSignals) {
        confidence = clamp(confidence - 0.12, 0.25, 0.6);
    }
    if (nearFieldBloomSuspicion) {
        confidence = clamp(confidence - 0.08, 0.25, 0.7);
    }
    if (windowEnergySlope <= -0.35) {
        confidence = clamp(confidence - 0.05, 0.25, 0.78);
    }

    const features = {
        subToMidRatio: Number(subToMidRatio.toFixed(3)),
        bassToMidRatio: Number(bassToMidRatio.toFixed(3)),
        lowMidToMidRatio: Number(lowMidToMidRatio.toFixed(3)),
        presenceToMidRatio: Number(presenceToMidRatio.toFixed(3)),
        highToMidRatio: Number(highToMidRatio.toFixed(3)),
        bandCoverageRatio: Number(bandCoverageRatio.toFixed(3)),
        ambientContinuity: Number(ambientContinuity.toFixed(3)),
        silenceRatio: Number(silenceRatio.toFixed(3)),
        dynamicRange: Number(dynamicRange.toFixed(3)),
        crestFactor: Number(crestFactor.toFixed(3)),
        overallRms: Number(overallEnergyStats.mean.toFixed(4)),
        peakOverallRms: Number(peakWindowAnalysis.temporal.overallRms.toFixed(4)),
        windowCount: windowAnalyses.length,
        windowEnergyContinuity: Number(ambientContinuity.toFixed(3)),
        windowEnergyCv: Number(windowEnergyCv.toFixed(3)),
        windowEnergySlope: Number(windowEnergySlope.toFixed(3)),
        lowMidWindowContinuity: Number(lowMidWindowContinuity.toFixed(3)),
        lowMidWindowCv: Number(lowMidWindowCv.toFixed(3)),
        lowMidEnergySlope: Number(lowMidEnergySlope.toFixed(3)),
        bandCoverageMedian: Number(bandCoverageStats.median.toFixed(3)),
        bandCoverageP90: Number(bandCoverageStats.p90.toFixed(3)),
        medianWindowAmbientContinuity: Number(temporalContinuityStats.median.toFixed(3)),
        peakAmbientContinuity: Number(peakAmbientContinuity.toFixed(3)),
        peakBandCoverageRatio: Number(peakBandCoverageRatio.toFixed(3)),
        nearFieldBloomSuspicion,
        analysisWindowStartSeconds: Number((startSample / decoded.sampleRate).toFixed(2)),
        analysisWindowDurationSeconds: Number((window.length / decoded.sampleRate).toFixed(2)),
    };

    return finalizeClassification({
        score,
        sourceClass,
        confidence,
        features,
        explanation: buildExplanationV2(features, score, sourceClass),
        modelVersion: SOURCE_CLASSIFIER_MODES.FFT_EXPERIMENTAL,
    });
};

// Estimates a room-reverb proxy by measuring how quickly energy decays after the
// loudest transient in the analysis window. In a real room, energy lingers
// for tens to hundreds of milliseconds after a transient; near-field or phone
// playback decays almost instantly. Returns a 0-1 score where higher = more reverb.
const estimateReverbProxy = (samples, sampleRate) => {
    const frameMs = 10;
    const frameLength = Math.max(1, Math.floor(sampleRate * (frameMs / 1000)));
    const frameCount = Math.floor(samples.length / frameLength);
    if (frameCount < 4) {
        return { reverbScore: 0, decayRateMs: null };
    }

    const frameEnergies = [];
    for (let f = 0; f < frameCount; f += 1) {
        const start = f * frameLength;
        frameEnergies.push(rms(samples.subarray(start, start + frameLength)));
    }

    // Find the loudest frame (transient peak)
    let peakFrame = 0;
    let peakEnergy = 0;
    for (let f = 0; f < frameEnergies.length; f += 1) {
        if (frameEnergies[f] > peakEnergy) {
            peakEnergy = frameEnergies[f];
            peakFrame = f;
        }
    }

    if (peakEnergy < EPSILON || peakFrame >= frameEnergies.length - 3) {
        return { reverbScore: 0, decayRateMs: null };
    }

    // Measure how many frames it takes to decay to 20% of the peak (roughly -14 dB)
    const decayThreshold = peakEnergy * 0.20;
    let decayFrames = 0;
    for (let f = peakFrame + 1; f < frameEnergies.length; f += 1) {
        if (frameEnergies[f] <= decayThreshold) {
            break;
        }
        decayFrames += 1;
    }

    const decayRateMs = decayFrames * frameMs;

    // Phone/laptop: decays in <30 ms. PA in a room: lingers 80-300+ ms.
    const reverbScore = clamp((decayRateMs - 30) / 270, 0, 1);

    return {
        reverbScore: Number(reverbScore.toFixed(3)),
        decayRateMs,
    };
};

export const analyzeAudioSource = (wavBuffer, options = {}) => {
    const mode = normalizeSourceClassifierMode(options.mode, DEFAULT_SOURCE_CLASSIFIER_MODE);
    const decoded = decodeMonoWav(wavBuffer);
    const { window, startSample } = extractWindow(decoded.samples, decoded.sampleRate);

    const analysis = mode === SOURCE_CLASSIFIER_MODES.FFT_EXPERIMENTAL
        ? analyzeAudioSourceV2(decoded, window, startSample)
        : analyzeAudioSourceV1(decoded, window, startSample);

    const reverb = estimateReverbProxy(window, decoded.sampleRate);

    // Fold reverb signals into the score: strong reverb supports PA/room playback,
    // near-zero reverb supports personal device.
    let adjustedScore = analysis.score;
    let adjustedConfidence = analysis.confidence;
    if (reverb.reverbScore >= 0.55) {
        adjustedScore = clamp(adjustedScore + 6, 0, 100);
        adjustedConfidence = clamp(adjustedConfidence + 0.04, 0, 0.95);
    } else if (reverb.reverbScore <= 0.15) {
        adjustedScore = clamp(adjustedScore - 8, 0, 100);
        adjustedConfidence = clamp(adjustedConfidence + 0.03, 0, 0.95);
    }

    // Re-derive source class from adjusted score if it shifts past a boundary
    let { sourceClass } = analysis;
    if (sourceClass !== 'inconclusive') {
        if (adjustedScore >= 72 && !analysis.signals?.nearFieldBloomSuspicion) {
            sourceClass = 'likely_pa_system';
        } else if (adjustedScore >= 56) {
            sourceClass = 'likely_small_speaker';
        } else if (adjustedScore <= 35) {
            sourceClass = 'likely_personal_device';
        }
    }

    return {
        ...analysis,
        score: Math.round(adjustedScore),
        confidence: Number(adjustedConfidence.toFixed(2)),
        sourceClass,
        signals: {
            ...analysis.signals,
            reverbScore: reverb.reverbScore,
            reverbDecayMs: reverb.decayRateMs,
        },
        classifierMode: mode,
    };
};
