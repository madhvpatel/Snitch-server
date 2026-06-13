// End-to-end verification for the v2 production-shaped capture path.
// Proves the new path is LOSSLESS (keeps every signal the legacy path drops)
// and that finalize verifies the device signature. Run against a server started
// with a throwaway SNITCH_DATA_DIR so it never touches the real store.
//
//   PORT=3017 SNITCH_DATA_DIR=/tmp/x node index.js &
//   BASE=http://localhost:3017 SNITCH_DATA_DIR=/tmp/x node scripts/verify-v2-capture.mjs

import fs from 'fs/promises';
import path from 'path';

const BASE = process.env.BASE || 'http://localhost:3017';
const DATA_DIR = process.env.SNITCH_DATA_DIR;

const canonicalize = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
};
const b64 = (buf) => Buffer.from(buf).toString('base64');
const j = async (res) => {
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`Non-JSON (${res.status}): ${text.slice(0, 200)}`); }
};
const authHeaders = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

async function main() {
    const subtle = globalThis.crypto.subtle;
    const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKeyB64 = b64(await subtle.exportKey('spki', keys.publicKey));

    const email = `v2test_${Date.now()}@example.com`;
    const signup = await j(await fetch(`${BASE}/api/mobile/auth/signup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'test-pass-123' }),
    }));
    const token = signup.token;
    if (!token) throw new Error('no token: ' + JSON.stringify(signup));

    const install = await j(await fetch(`${BASE}/api/mobile/capture/install`, {
        method: 'POST', headers: authHeaders(token),
        body: JSON.stringify({ device_model: 'ios', os_version: 'ios 17', app_version: '1.0.0', public_key: publicKeyB64 }),
    }));
    const installId = install.install_id, deviceKeyId = install.device_key_id;

    const session = await j(await fetch(`${BASE}/api/mobile/capture/session`, {
        method: 'POST', headers: authHeaders(token),
        body: JSON.stringify({ install_id: installId, location_lat: 19.076, location_lng: 72.8777 }),
    }));
    const sessionId = session.session_id, sessionNonce = session.session_nonce;
    if (!sessionNonce) throw new Error('no session_nonce');

    const mediaHash = 'a'.repeat(64);
    const startTime = '2026-06-12T10:00:00.000Z', endTime = '2026-06-12T10:00:18.500Z';
    const subBody = {
        session_id: sessionId, install_id: installId, device_key_id: deviceKeyId,
        local_start_time: startTime, local_end_time: endTime,
        start_lat: 19.0760, start_lng: 72.8777, start_accuracy: 8, start_altitude: 14.2, start_speed: 0.3, start_heading: 271,
        end_lat: 19.0761, end_lng: 72.8778, end_accuracy: 9, end_altitude: 14.0, end_speed: 0.1, end_heading: 268,
        media_hash: mediaHash, file_size: 1234, mime_type: 'video/mp4', file_name: 'cap.mp4',
        duration_seconds: 18.5, note: 'field note', business_name: 'Cafe X', gstin: '27AAACN0785F1ZP',
        selected_venue_name: 'Cafe X', selected_venue_address: '1 St', selected_venue_place_provider_id: 'place_123',
        selected_venue_provider: 'google_maps', selected_venue_city: 'Mumbai', selected_venue_latitude: 19.0760, selected_venue_longitude: 72.8777,
        device_context: { capturedAt: startTime, compassHeading: 271, compassAccuracy: 15, cellular: { carrier: 'Jio', generation: '5g', isConnected: true }, deviceName: 'Test iPhone', osName: 'ios', osVersion: '17', timezone: 'Asia/Kolkata', locale: 'en-IN' },
        radio_evidence: {
            collectionVersion: 'radio-evidence-v1',
            start: {
                phase: 'start', capturedAt: startTime,
                wifi: { status: 'captured', captureMode: 'nearby_wifi_scan', ssid: 'CafeX-WiFi', bssid: 'aa:bb:cc:dd:ee:ff', strength: -48, frequency: 2412, networks: [{ ssid: 'CafeX-WiFi', bssid: 'aa:bb:cc:dd:ee:ff', rssi: -48, frequency: 2412, capabilities: 'WPA2' }, { ssid: 'Neighbor', bssid: '11:22:33:44:55:66', rssi: -71, frequency: 5180, capabilities: 'WPA2' }] },
                bluetooth: { status: 'captured', captureMode: 'nearby_ble_scan', deviceCount: 1, devices: [{ id: 'dev1', name: null, localName: 'JBL Flip', displayName: 'JBL Flip', inferredType: 'BT Speaker', manufacturerId: 25, manufacturerName: 'Harman (JBL)', rssi: -55, serviceUUIDs: ['110b'], manufacturerDataPresent: true, txPowerLevel: -12 }] },
            },
            end: null,
            limitations: ['iOS Wi-Fi limited'],
        },
        audio_level_envelope: [12, 40, 55, 60, 48, 33, 70, 65],
        source_classifier_mode: 'source-v1',
    };
    const sub = await j(await fetch(`${BASE}/api/mobile/v2/capture/submissions`, {
        method: 'POST', headers: authHeaders(token), body: JSON.stringify(subBody),
    }));
    const submissionId = sub.submission_id;
    if (!submissionId) throw new Error('no submission_id: ' + JSON.stringify(sub));

    const fd = new FormData();
    fd.append('video', new Blob([Buffer.from('test-bytes')], { type: 'video/mp4' }), 'cap.mp4');
    const up = await j(await fetch(`${BASE}/api/mobile/v2/capture/submissions/${submissionId}/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
    }));
    if (up.status !== 'uploaded') throw new Error('upload failed: ' + JSON.stringify(up));

    const signed = {
        installId, deviceKeyId, sessionId, sessionNonce,
        mediaSha256: mediaHash, localStartTime: startTime, localEndTime: endTime,
        durationSeconds: '18.5', startLat: '19.076', startLng: '72.8777', endLat: '19.0761', endLng: '72.8778',
    };
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(canonicalize(signed)));
    const fin = await j(await fetch(`${BASE}/api/mobile/v2/capture/submissions/${submissionId}/finalize`, {
        method: 'POST', headers: authHeaders(token),
        body: JSON.stringify({ media_hash: mediaHash, signature: b64(sig), signed_payload: signed }),
    }));

    const db = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'platform-db.json'), 'utf8'));
    const prod = db.production || {};
    const s = (prod.submissions || []).find((x) => x.id === submissionId);
    const cs = (prod.capture_sessions || []).find((x) => x.id === sessionId);

    const checks = [];
    const assert = (name, cond) => checks.push({ name, ok: !!cond });

    assert('finalize → has_valid_signature true', fin.has_valid_signature === true);
    assert('finalize → status stored', fin.status === 'stored');
    assert('submission row exists', !!s);
    assert('LOSSY-FIX wifi.networks[] preserved (≥2)', s && s.radio_context?.start?.wifi?.networks?.length >= 2);
    assert('LOSSY-FIX BLE inferredType preserved', s && s.radio_context?.start?.bluetooth?.devices?.[0]?.inferredType === 'BT Speaker');
    assert('LOSSY-FIX BLE manufacturerName preserved', s && s.radio_context?.start?.bluetooth?.devices?.[0]?.manufacturerName === 'Harman (JBL)');
    assert('LOSSY-FIX geo altitude present', s && s.geolocation_start_raw?.altitude === 14.2);
    assert('LOSSY-FIX geo speed present', s && typeof s.geolocation_start_raw?.speed === 'number');
    assert('LOSSY-FIX geo heading present', s && s.geolocation_start_raw?.heading === 271);
    assert('LOSSY-FIX device_snapshot compass on session', cs && cs.device_snapshot?.compassHeading === 271);
    assert('LOSSY-FIX device_snapshot cellular carrier', cs && cs.device_snapshot?.cellular?.carrier === 'Jio');
    assert('LOSSY-FIX audio_level_envelope present', s && Array.isArray(s.audio_level_envelope) && s.audio_level_envelope.length === 8);
    assert('row has_valid_signature true', s && s.has_valid_signature === true);
    assert('row status stored', s && s.status === 'stored');
    assert('mobile_users mirrored', (prod.mobile_users || []).length >= 1);
    assert('device_installs mirrored w/ public_key', (prod.device_installs || []).some((d) => d.install_id === installId && d.public_key));
    assert('venue upserted by place id', (prod.venues || []).some((v) => v.place_provider_id === 'place_123'));
    assert('capture_context gstin kept', s && s.capture_context?.gstin === '27AAACN0785F1ZP');
    const camelTop = s ? Object.keys(s).filter((k) => /[A-Z]/.test(k)) : ['<no row>'];
    assert('submissions row columns snake_case only (PG-ready)', s && camelTop.length === 0);

    let allOk = true;
    for (const c of checks) { console.log(`${c.ok ? '✓' : '✗ FAIL'} ${c.name}`); if (!c.ok) allOk = false; }
    if (!allOk && camelTop.length) console.log('\nnon-snake top-level keys:', camelTop.join(', '));
    console.log(allOk ? '\n✅ V2 CAPTURE LOSSLESS — ALL CHECKS PASSED' : '\n❌ SOME CHECKS FAILED');
    process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e); process.exit(2); });
