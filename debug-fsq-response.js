import fetch from 'node-fetch';

const key = 'VQZKC2JRB0PE45KMO0CNM5LQ03ZEK13SSGZOVQP05VRICM4S';
const lat = 19.224158;
const lon = 72.965113;

async function debugResponse() {
    const url = `https://places-api.foursquare.com/geotagging/candidates?ll=${lat},${lon}&limit=1&hacc=10`;
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${key}`,
            'Accept': 'application/json',
            'X-Places-Api-Version': '2025-06-17'
        }
    });
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2));
}

debugResponse();
