import fetch from 'node-fetch';

const key = 'VQZKC2JRB0PE45KMO0CNM5LQ03ZEK13SSGZOVQP05VRICM4S';
const lat = 19.224158;
const lon = 72.965113;

async function testPlaceDetails() {
    console.log('Fetching extended place details for freshness analysis...');

    const headers = {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json',
        'X-Places-Api-Version': '2025-06-17'
    };

    // Requesting closed_bucket and rating/verified status
    const url = `https://places-api.foursquare.com/places/search?ll=${lat},${lon}&limit=15&radius=1000&sort=DISTANCE&fields=fsq_id,name,location,categories,distance,closed_bucket,verified,rating,stats`;

    try {
        const res = await fetch(url, { headers });
        const data = await res.json();

        console.log('\n--- Venue Status Audit ---');
        (data.results || []).forEach(v => {
            console.log(`Name: ${v.name}`);
            console.log(`- ID: ${v.fsq_id}`);
            console.log(`- Status: ${v.closed_bucket || 'Unknown'}`);
            console.log(`- Verified: ${v.verified || 'false'}`);
            console.log(`- Rating: ${v.rating || 'N/A'}`);
            console.log(`- Check-ins: ${v.stats?.total_checkins || 0}`);
            console.log('-------------------');
        });
    } catch (e) {
        console.log('Audit failed:', e.message);
    }
}

testPlaceDetails();
