import fetch from 'node-fetch';

const keys = [
    'fsq3gEIK00qrq7K1AH05VyCHLIUhTqmFqEl2JevDs6YKQ9s=', // fsq3
    'ZVUOQ4ES3K03AFTF2L22GSCDQZOEE2YDQ3M0OTW2TBKV0MWN'  // ZVUO
];

const lat = 19.224158;
const lon = 72.965113;
const versions = ['1970-01-01', '20220101', '20231010'];

async function testCombination(key, version) {
    console.log(`Key: ${key.substring(0, 5)}... | Version: ${version}`);
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

        console.log(`Status: ${status} | Msg: ${data.message || 'Check-in data returned'}`);
        if (status === 200) console.log('✅ SUCCESS!');
    } catch (err) {
        console.log('💥 Error:', err.message);
    }
}

async function runTests() {
    for (const key of keys) {
        for (const version of versions) {
            await testCombination(key, version);
        }
    }
}

runTests();
