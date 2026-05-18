import fetch from 'node-fetch';

const key = 'ZVUOQ4ES3K03AFTF2L22GSCDQZOEE2YDQ3M0OTW2TBKV0MWN';
const lat = 19.224158;
const lon = 72.965113;

async function testSearchMigration() {
    console.log('Testing /places/search on new host with Service Key...');
    const url = `https://places-api.foursquare.com/places/search?ll=${lat},${lon}&limit=5`;

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${key}`,
                'Accept': 'application/json',
                'X-Places-Api-Version': '1970-01-01'
            }
        });

        const status = response.status;
        const data = await response.json();

        console.log(`Status: ${status}`);
        if (status === 200) {
            console.log('✅ Success!');
            console.log('Top Result:', data.results?.[0]?.name);
        } else {
            console.log('❌ Failed');
            console.log('Error:', JSON.stringify(data));
        }
    } catch (err) {
        console.log('💥 Error:', err.message);
    }
}

testSearchMigration();
