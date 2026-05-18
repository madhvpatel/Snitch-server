import fetch from 'node-fetch';

const key = 'fsq3gEIK00qrq7K1AH05VyCHLIUhTqmFqEl2JevDs6YKQ9s=';
const lat = 19.224158;
const lon = 72.965113;

async function testGenericSearch() {
    console.log('Testing generic search...');
    // No version header, no nearby path
    const url = `https://api.foursquare.com/v3/places/search?ll=${lat},${lon}&limit=1`;

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': key,
                'Accept': 'application/json'
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

testGenericSearch();
