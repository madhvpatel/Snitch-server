import fetch from 'node-fetch';

const key = 'ZVUOQ4ES3K03AFTF2L22GSCDQZOEE2YDQ3M0OTW2TBKV0MWN';
const lat = 19.224158;
const lon = 72.965113;

async function testBearer() {
    console.log('Testing Bearer token...');
    const url = `https://api.foursquare.com/v3/places/nearby?ll=${lat},${lon}&limit=1`;

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
            console.log('✅ Success with Bearer!');
        } else {
            console.log('❌ Failed');
            console.log('Msg:', data.message);
        }
    } catch (err) {
        console.log('💥 Error:', err.message);
    }
}

testBearer();
