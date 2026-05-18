import fetch from 'node-fetch';

const keys = [
    'fsq3gEIK00qrq7K1AH05VyCHLIUhTqmFqEl2JevDs6YKQ9s=', // Old Key
    'ZVUOQ4ES3K03AFTF2L22GSCDQZOEE2YDQ3M0OTW2TBKV0MWN'  // New Key
];

const lat = 19.224158;
const lon = 72.965113;
const version = '20231010';

async function testKey(key, name) {
    console.log(`Testing ${name}: ${key.substring(0, 10)}...`);
    const url = `https://api.foursquare.com/v3/places/nearby?ll=${lat},${lon}&limit=1`;

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': key,
                'Accept': 'application/json',
                'X-Places-Api-Version': version
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
            console.log('Error:', JSON.stringify(data));
        }
    } catch (err) {
        console.log('💥 Error:', err.message);
    }
    console.log('-------------------');
}

async function runTests() {
    await testKey(keys[0], 'Original Key (fsq3...)');
    await testKey(keys[1], 'New Key (ZVUO...)');
}

runTests();
