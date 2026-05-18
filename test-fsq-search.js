import fetch from 'node-fetch';

const key = 'fsq3gEIK00qrq7K1AH05VyCHLIUhTqmFqEl2JevDs6YKQ9s=';
const lat = 19.224158;
const lon = 72.965113;
const version = '20231010';

async function testSearch() {
    console.log('Testing /v3/places/search with fsq3 key...');
    const url = `https://api.foursquare.com/v3/places/search?ll=${lat},${lon}&limit=1`;

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
}

testSearch();
