import fetch from 'node-fetch';

const key = 'ZVUOQ4ES3K03AFTF2L22GSCDQZOEE2YDQ3M0OTW2TBKV0MWN';
const lat = 19.224158;
const lon = 72.965113;

async function testSearchBearer() {
    console.log('Testing /v3/places/search with Bearer ZVUO key...');
    const url = `https://api.foursquare.com/v3/places/search?ll=${lat},${lon}&limit=1`;

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${key}`,
                'Accept': 'application/json',
                'X-Places-Api-Version': '20231010'
            }
        });

        const status = response.status;
        const data = await response.json();

        console.log(`Status: ${status}`);
        if (status === 200) {
            console.log('✅ Success!');
            console.log('Venue:', data.results[0]?.name);
        } else {
            console.log('❌ Failed');
            console.log('Msg:', data.message);
        }
    } catch (err) {
        console.log('💥 Error:', err.message);
    }
}

testSearchBearer();
