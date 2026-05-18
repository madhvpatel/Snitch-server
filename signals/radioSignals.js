import {
    parseMaybeJson,
    pickBooleanLike,
    pickNumberLike,
    pickStringLike,
} from './common.js';

export const normalizeRadioEntry = (entry, fallbackStatus = 'unavailable') => {
    if (!entry || typeof entry !== 'object') {
        return {
            status: fallbackStatus,
            captureMode: null,
            supportLevel: null,
            supportsNearbyScan: false,
            capturedAt: null,
            platform: null,
            executionEnvironment: null,
            observedTransportType: null,
            isConnected: null,
            isInternetReachable: null,
            isConnectionExpensive: null,
            ssid: null,
            bssid: null,
            strength: null,
            frequency: null,
            deviceCount: null,
            devices: [],
            note: null,
        };
    }

    const devices = Array.isArray(entry.devices)
        ? entry.devices
            .filter((item) => item && typeof item === 'object')
            .map((device) => ({
                id: pickStringLike(device.id),
                name: pickStringLike(device.name),
                localName: pickStringLike(device.localName),
                rssi: pickNumberLike(device.rssi),
                serviceUUIDs: Array.isArray(device.serviceUUIDs)
                    ? device.serviceUUIDs.map((uuid) => pickStringLike(uuid)).filter(Boolean)
                    : [],
                manufacturerDataPresent: device.manufacturerDataPresent === true,
                txPowerLevel: pickNumberLike(device.txPowerLevel),
            }))
            .filter((device) => device.id)
        : [];

    return {
        status: pickStringLike(entry.status) || fallbackStatus,
        captureMode: pickStringLike(entry.captureMode),
        supportLevel: pickStringLike(entry.supportLevel),
        supportsNearbyScan: entry.supportsNearbyScan === true,
        capturedAt: pickStringLike(entry.capturedAt),
        platform: pickStringLike(entry.platform),
        executionEnvironment: pickStringLike(entry.executionEnvironment),
        observedTransportType: pickStringLike(entry.observedTransportType),
        isConnected: pickBooleanLike(entry.isConnected),
        isInternetReachable: pickBooleanLike(entry.isInternetReachable),
        isConnectionExpensive: pickBooleanLike(entry.isConnectionExpensive),
        ssid: pickStringLike(entry.ssid),
        bssid: pickStringLike(entry.bssid),
        strength: pickNumberLike(entry.strength),
        frequency: pickNumberLike(entry.frequency),
        deviceCount: pickNumberLike(entry.deviceCount) ?? devices.length,
        devices,
        note: pickStringLike(entry.note),
    };
};

export const normalizeRadioEvidence = (value) => {
    const raw = parseMaybeJson(value);
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const limitations = Array.isArray(raw.limitations)
        ? raw.limitations.map((item) => pickStringLike(item)).filter(Boolean)
        : [];

    const normalizeSnapshot = (snapshot) => {
        if (!snapshot || typeof snapshot !== 'object') {
            return null;
        }

        return {
            phase: pickStringLike(snapshot.phase) || null,
            capturedAt: pickStringLike(snapshot.capturedAt) || null,
            wifi: normalizeRadioEntry(snapshot.wifi, 'unavailable'),
            bluetooth: normalizeRadioEntry(snapshot.bluetooth, 'unsupported'),
        };
    };

    const start = normalizeSnapshot(raw.start);
    const end = normalizeSnapshot(raw.end);

    if (!start && !end && limitations.length === 0) {
        return null;
    }

    return {
        collectionVersion: pickStringLike(raw.collectionVersion) || 'radio-evidence-v1',
        start,
        end,
        limitations,
    };
};

export const getLatestRadioEntry = (radioEvidence, key) => radioEvidence?.end?.[key] || radioEvidence?.start?.[key] || null;

export const summarizeRadioEntry = (entry) => {
    if (!entry) {
        return 'Not captured';
    }

    if (entry.captureMode === 'nearby_ble_scan' && entry.deviceCount != null) {
        if (entry.deviceCount > 0) {
            return `${entry.deviceCount} BLE device${entry.deviceCount === 1 ? '' : 's'} nearby`;
        }

        if (entry.status === 'captured') {
            return 'No BLE devices discovered';
        }
    }

    if (entry.status === 'captured' && entry.ssid) {
        return `${entry.ssid}${entry.frequency ? ` • ${entry.frequency} MHz` : ''}`;
    }

    if (entry.status === 'captured') {
        return 'Connected context captured';
    }

    if (entry.status === 'not_connected') {
        return 'Not connected during capture';
    }

    return entry.note || entry.status || 'Unavailable';
};
