import fetch from 'node-fetch';

const key = 'VQZKC2JRB0PE45KMO0CNM5LQ03ZEK13SSGZOVQP05VRICM4S';
const lat = 19.224158;
const lon = 72.965113;

async function testPlaceDetails() {
    console.log('Fetching basic place details to identify stale data...');

    const headers = {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json',
        'X-Places-Api-Version': '2025-06-17'
    };

    // Simplify fields to avoid potential API field access issues
    const url = `https://places-api.foursquare.com/places/search?ll=${lat},${lon}&limit=20&radius=1000&sort=DISTANCE&fields=name,closed_bucket,verified`;

    try {
        const res = await fetch(url, { headers });
        const data = await res.json();

        console.log('\n--- Venue Status Audit (Simplified) ---');
        const results = data.results || [];
        if (results.length === 0) {
            console.log('No results found. Full response:', JSON.stringify(data, null, 2));
            return;
        }

        results.forEach(v => {
            console.log(`Name: ${v.name}`);
            console.log(`- Status: ${v.closed_bucket || 'Unknown'}`);
            console.log(`- Verified: ${v.verified || 'false'}`);
            console.log('-------------------');
        });
    } catch (e) {
        console.log('Audit failed:', e.message);
    }
}

testPlaceDetails();
