import fetch from 'node-fetch';

const key = 'VQZKC2JRB0PE45KMO0CNM5LQ03ZEK13SSGZOVQP05VRICM4S';
const lat = 19.224158;
const lon = 72.965113;

async function testComparison() {
    console.log('Comparing Geotagging vs Search freshness...');

    const headers = {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json',
        'X-Places-Api-Version': '2025-06-17'
    };

    // 1. Geotagging Candidates
    const geoUrl = `https://places-api.foursquare.com/geotagging/candidates?ll=${lat},${lon}&limit=10&radius=500`;
    console.log('\n--- Geotagging Candidates ---');
    try {
        const res = await fetch(geoUrl, { headers });
        const data = await res.json();
        console.log('Results:', (data.candidates || []).map(v => v.name).join(', '));
    } catch (e) { console.log('Geo failed:', e.message); }

    // 2. Places Search (on new host)
    const searchUrl = `https://places-api.foursquare.com/places/search?ll=${lat},${lon}&limit=10&radius=500&sort=DISTANCE`;
    console.log('\n--- Places Search (New Host) ---');
    try {
        const res = await fetch(searchUrl, { headers });
        const data = await res.json();
        console.log('Results:', (data.results || []).map(v => v.name).join(', '));
    } catch (e) { console.log('Search failed:', e.message); }
}

testComparison();
