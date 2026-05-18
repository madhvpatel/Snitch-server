import fetch from 'node-fetch';

const key = 'ZVUOQ4ES3K03AFTF2L22GSCDQZOEE2YDQ3M0OTW2TBKV0MWN';
const lat = 19.224158;
const lon = 72.965113;

async function testNewMigration() {
    console.log('Testing NEW Foursquare Migration (Service Keys)...');
    // New Host, New Path
    const url = `https://places-api.foursquare.com/geotagging/candidates?ll=${lat},${lon}&limit=5&hacc=10`;

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${key}`,
                'Accept': 'application/json'
            }
        });

        const status = response.status;
        const data = await response.json();

        console.log(`Status: ${status}`);
        if (status === 200) {
            console.log('✅ Success!');
            console.log('Sample Result:', JSON.stringify(data.results?.[0]?.name || data.results?.[0], null, 2));
        } else {
            console.log('❌ Failed');
            console.log('Error:', JSON.stringify(data));
        }
    } catch (err) {
        console.log('💥 Error:', err.message);
    }
}

testNewMigration();
