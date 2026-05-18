import fetch from 'node-fetch';

const key = 'VQZKC2JRB0PE45KMO0CNM5LQ03ZEK13SSGZOVQP05VRICM4S';
const lat = 19.224158;
const lon = 72.965113;

async function testOpenNow() {
    console.log('Testing open_now filtering...');

    const headers = {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json',
        'X-Places-Api-Version': '2025-06-17'
    };

    // 1. Standard Search
    const searchUrl = `https://places-api.foursquare.com/places/search?ll=${lat},${lon}&limit=10&radius=500&sort=DISTANCE`;
    console.log('\n--- All Venues ---');
    try {
        const res = await fetch(searchUrl, { headers });
        const data = await res.json();
        console.log('Results:', (data.results || []).map(v => v.name).join(', '));
    } catch (e) { console.log('Search failed:', e.message); }

    // 2. Open Now Only
    const openUrl = `https://places-api.foursquare.com/places/search?ll=${lat},${lon}&limit=10&radius=500&sort=DISTANCE&open_now=true`;
    console.log('\n--- Open Now Only ---');
    try {
        const res = await fetch(openUrl, { headers });
        const data = await res.json();
        console.log('Results:', (data.results || []).map(v => v.name).join(', '));
    } catch (e) { console.log('Open search failed:', e.message); }
}

testOpenNow();
