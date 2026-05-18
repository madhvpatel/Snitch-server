import fetch from 'node-fetch';

const key = 'VQZKC2JRB0PE45KMO0CNM5LQ03ZEK13SSGZOVQP05VRICM4S';
const lat = 19.224158;
const lon = 72.965113;

async function testDemoKey() {
    console.log('Testing NEW Demo Key (VQZK...) with Version 2025-06-17...');
    const url = `https://places-api.foursquare.com/geotagging/candidates?ll=${lat},${lon}&limit=5&hacc=10`;

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${key}`,
                'Accept': 'application/json',
                'X-Places-Api-Version': '2025-06-17'
            }
        });

        const status = response.status;
        const data = await response.json();

        console.log(`Status: ${status}`);
        if (status === 200) {
            console.log('✅ Success! This key has credits.');
            console.log('Top Result:', data.results?.[0]?.name);
        } else {
            console.log('❌ Failed');
            console.log('Error:', JSON.stringify(data));
        }
    } catch (err) {
        console.log('💥 Error:', err.message);
    }
}

testDemoKey();
