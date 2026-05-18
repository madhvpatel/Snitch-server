const EPSILON = 1e-6;
const DEFAULT_WINDOW_SECONDS = 0.8;
const DEFAULT_HOP_SECONDS = 0.12;
const DEFAULT_MIN_SPACING_SECONDS = 2.4;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

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

const readAscii = (buffer, start, end) => buffer.toString('ascii', start, end);

export const decodeMonoWav = (wavBuffer) => {
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
        durationSeconds: frameCount / fmt.sampleRate,
        samples,
    };
};

export const encodeMonoWav = ({ samples, sampleRate }) => {
    const normalizedSamples = samples instanceof Float32Array
        ? samples
        : Float32Array.from(samples || []);
    const pcmBytes = normalizedSamples.length * 2;
    const buffer = Buffer.alloc(44 + pcmBytes);

    buffer.write('RIFF', 0, 4, 'ascii');
    buffer.writeUInt32LE(36 + pcmBytes, 4);
    buffer.write('WAVE', 8, 4, 'ascii');
    buffer.write('fmt ', 12, 4, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 4, 'ascii');
    buffer.writeUInt32LE(pcmBytes, 40);

    for (let index = 0; index < normalizedSamples.length; index += 1) {
        const clamped = clamp(normalizedSamples[index], -1, 1);
        const pcmValue = clamped < 0
            ? Math.round(clamped * 32768)
            : Math.round(clamped * 32767);
        buffer.writeInt16LE(pcmValue, 44 + (index * 2));
    }

    return buffer;
};

export const selectPeakWindows = (wavBuffer, options = {}) => {
    const decoded = decodeMonoWav(wavBuffer);
    const maxWindows = Math.max(1, Number(options.maxWindows || 3));
    const windowSeconds = Math.max(0.35, Number(options.windowSeconds || DEFAULT_WINDOW_SECONDS));
    const hopSeconds = Math.max(0.05, Number(options.hopSeconds || DEFAULT_HOP_SECONDS));
    const minSpacingSeconds = Math.max(windowSeconds, Number(options.minSpacingSeconds || DEFAULT_MIN_SPACING_SECONDS));
    const windowLength = Math.max(1, Math.floor(decoded.sampleRate * windowSeconds));
    const hopLength = Math.max(1, Math.floor(decoded.sampleRate * hopSeconds));
    const windows = [];

    for (let start = 0; start + windowLength <= decoded.samples.length; start += hopLength) {
        const end = start + windowLength;
        const energy = rms(decoded.samples.subarray(start, end));
        const centerSeconds = (start + (windowLength / 2)) / decoded.sampleRate;

        windows.push({
            startSample: start,
            endSample: end,
            startSeconds: Number((start / decoded.sampleRate).toFixed(2)),
            endSeconds: Number((end / decoded.sampleRate).toFixed(2)),
            timestampSeconds: Number(centerSeconds.toFixed(2)),
            rms: energy,
        });
    }

    if (!windows.length) {
        const midpoint = Number((decoded.durationSeconds / 2).toFixed(2));
        return [{
            rank: 1,
            startSeconds: Math.max(0, Number((midpoint - windowSeconds / 2).toFixed(2))),
            endSeconds: Number((midpoint + windowSeconds / 2).toFixed(2)),
            timestampSeconds: midpoint,
            rms: 0,
            relativeIntensity: 0,
        }];
    }

    const baseline = percentile(windows.map((entry) => entry.rms), 0.5);
    const selected = [];

    for (const candidate of windows.sort((left, right) => right.rms - left.rms)) {
        const tooClose = selected.some((entry) => Math.abs(entry.timestampSeconds - candidate.timestampSeconds) < minSpacingSeconds);
        if (tooClose) {
            continue;
        }

        selected.push(candidate);
        if (selected.length >= maxWindows) {
            break;
        }
    }

    if (!selected.length) {
        selected.push(windows[Math.floor(windows.length / 2)]);
    }

    return selected
        .sort((left, right) => left.timestampSeconds - right.timestampSeconds)
        .map((entry, index) => ({
            rank: index + 1,
            startSeconds: entry.startSeconds,
            endSeconds: entry.endSeconds,
            timestampSeconds: entry.timestampSeconds,
            rms: Number(entry.rms.toFixed(4)),
            relativeIntensity: Number((entry.rms / Math.max(baseline, EPSILON)).toFixed(2)),
            clipDurationSeconds: Number(decoded.durationSeconds.toFixed(2)),
        }));
};

export const summarizePeakWindows = (peakWindows = []) => peakWindows.map((window) => (
    `${window.timestampSeconds.toFixed(2)}s (x${window.relativeIntensity.toFixed(2)} baseline)`
));
