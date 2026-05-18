import crypto from 'crypto';
import fetch from 'node-fetch';
import FormData from 'form-data';
import dotenv from 'dotenv';

dotenv.config();

const config = {
    host: process.env.ACRCLOUD_HOST,
    access_key: process.env.ACRCLOUD_ACCESS_KEY,
    access_secret: process.env.ACRCLOUD_ACCESS_SECRET
};

console.log('Testing ACRCloud API Authentication...\n');
console.log('Host:', config.host);
console.log('Access Key:', config.access_key);
console.log('Access Secret:', config.access_secret ? '(present)' : '(missing)');
console.log();

// Create a test request with minimal data
const timestamp = Math.floor(new Date().getTime() / 1000);
const stringToSign = `POST\n/v1/identify\n${config.access_key}\naudio\n1\n${timestamp}`;

console.log('String to sign:');
console.log(stringToSign);
console.log();

const signature = crypto.createHmac('sha1', config.access_secret)
    .update(Buffer.from(stringToSign, 'utf-8'))
    .digest()
    .toString('base64');

console.log('Generated signature:', signature);
console.log();

// Create minimal form data
const formData = new FormData();
formData.append('access_key', config.access_key);
formData.append('data_type', 'audio');
formData.append('signature_version', '1');
formData.append('signature', signature);
formData.append('timestamp', timestamp.toString());

const url = `https://${config.host}/v1/identify`;

console.log('Sending test request to:', url);
console.log();

fetch(url, {
    method: 'POST',
    body: formData,
    headers: formData.getHeaders()
})
    .then(res => res.json())
    .then(data => {
        console.log('Response:');
        console.log(JSON.stringify(data, null, 2));

        if (data.status.code === 3001) {
            console.log('\n❌ AUTHENTICATION FAILED');
            console.log('Your Access Key or Secret is invalid for this Host.');
            console.log('1. Visit https://console.acrcloud.com/');
            console.log('2. Ensure your project is "Audio & Video Recognition".');
            console.log('3. Verify the Host matches: ' + config.host);
        } else if (data.status.code === 0 || data.status.code === 2006) {
            console.log('\n✅ AUTHENTICATION SUCCESSFUL!');
            console.log('The keys are valid. (2006 just means no audio was sent)');
        }
    })
    .catch(error => {
        console.error('Error:', error.message);
    });
