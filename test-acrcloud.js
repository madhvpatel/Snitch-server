// Test ACRCloud audio fingerprint endpoint
import fetch from 'node-fetch';
import FormData from 'form-data';

const API_BASE = 'http://localhost:3001';

console.log('🧪 Testing ACRCloud Audio Fingerprint\n');

// Test ACRCloud endpoint with a dummy audio file
async function testACRCloud() {
    console.log('Test: ACRCloud Audio Recognition');

    try {
        // Create a minimal WebM audio file (just for testing the endpoint)
        const dummyAudio = Buffer.from([
            0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01,
            // This is just a WebM header, not real audio
        ]);

        const formData = new FormData();
        formData.append('audio', dummyAudio, 'test.webm');

        const response = await fetch(`${API_BASE}/api/identify`, {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders()
        });

        const data = await response.json();

        console.log('Response status:', response.status);
        console.log('Response data:', JSON.stringify(data, null, 2));

        if (response.ok) {
            console.log('✅ ACRCloud working! Found:', data.title);
            return true;
        } else {
            console.log('❌ ACRCloud failed with error:', data.error);
            console.log('   Details:', data.details || data.code);

            if (data.code === 3001 || (data.details && data.details.includes('3001'))) {
                console.log('\n⚠️  Issue: Invalid ACRCloud credentials');
                console.log('   Solution: Regenerate keys at https://console.acrcloud.com/');
            }
            return false;
        }
    } catch (error) {
        console.log('❌ Test failed:', error.message);
        return false;
    }
}

testACRCloud();
