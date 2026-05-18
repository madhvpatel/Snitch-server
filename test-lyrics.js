// Test script for lyrics recognition backend
import fetch from 'node-fetch';

const API_BASE = 'http://localhost:3001';

console.log('🧪 Testing Lyrics Recognition System\n');

// Test 1: Backend Health Check
async function testHealthCheck() {
    console.log('Test 1: Health Check');
    try {
        const response = await fetch(`${API_BASE}/health`);
        const data = await response.json();
        console.log('✅ Health check passed:', data.message);
        return true;
    } catch (error) {
        console.error('❌ Health check failed:', error.message);
        return false;
    }
}

// Test 2: Lyrics Endpoint - Ed Sheeran
async function testEdSheeran() {
    console.log('\nTest 2: Search for "Shape of You"');
    try {
        const response = await fetch(`${API_BASE}/api/identify-lyrics`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lyrics: 'the shape of you mesmerizes me' })
        });

        const data = await response.json();

        if (response.ok && data.title === 'Shape of You') {
            console.log('✅ Found:', data.title, 'by', data.artist);
            console.log('   Label:', data.label);
            console.log('   PRO:', data.pro);
            return true;
        } else {
            console.error('❌ Expected "Shape of You", got:', data);
            return false;
        }
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        return false;
    }
}

// Test 3: Lyrics Endpoint - The Weeknd
async function testTheWeeknd() {
    console.log('\nTest 3: Search for "Blinding Lights"');
    try {
        const response = await fetch(`${API_BASE}/api/identify-lyrics`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lyrics: 'I said blinding lights in vegas' })
        });

        const data = await response.json();

        if (response.ok && data.title === 'Blinding Lights') {
            console.log('✅ Found:', data.title, 'by', data.artist);
            return true;
        } else {
            console.error('❌ Expected "Blinding Lights", got:', data);
            return false;
        }
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        return false;
    }
}

// Test 4: Rick Astley
async function testRickAstley() {
    console.log('\nTest 4: Search for "Never Gonna Give You Up"');
    try {
        const response = await fetch(`${API_BASE}/api/identify-lyrics`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lyrics: 'never gonna give you up' })
        });

        const data = await response.json();

        if (response.ok && data.title === 'Never Gonna Give You Up') {
            console.log('✅ Found:', data.title, 'by', data.artist);
            return true;
        } else {
            console.error('❌ Expected "Never Gonna Give You Up", got:', data);
            return false;
        }
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        return false;
    }
}

// Test 5: Empty lyrics (should fail)
async function testEmptyLyrics() {
    console.log('\nTest 5: Empty lyrics (should fail gracefully)');
    try {
        const response = await fetch(`${API_BASE}/api/identify-lyrics`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lyrics: '' })
        });

        const data = await response.json();

        if (!response.ok && data.error) {
            console.log('✅ Correctly rejected empty lyrics:', data.error);
            return true;
        } else {
            console.error('❌ Should have rejected empty lyrics');
            return false;
        }
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        return false;
    }
}

// Test 6: Unknown lyrics (should fail)
async function testUnknownLyrics() {
    console.log('\nTest 6: Unknown lyrics (should return 404)');
    try {
        const response = await fetch(`${API_BASE}/api/identify-lyrics`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lyrics: 'xyz abc random words that match nothing' })
        });

        const data = await response.json();

        if (!response.ok && data.error) {
            console.log('✅ Correctly returned no match:', data.error);
            return true;
        } else {
            console.error('❌ Should have returned no match');
            return false;
        }
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        return false;
    }
}

// Run all tests
async function runAllTests() {
    const results = [];

    results.push(await testHealthCheck());
    results.push(await testEdSheeran());
    results.push(await testTheWeeknd());
    results.push(await testRickAstley());
    results.push(await testEmptyLyrics());
    results.push(await testUnknownLyrics());

    const passed = results.filter(r => r).length;
    const total = results.length;

    console.log('\n' + '='.repeat(50));
    console.log(`📊 Test Results: ${passed}/${total} passed`);

    if (passed === total) {
        console.log('🎉 All tests passed!');
    } else {
        console.log('⚠️  Some tests failed');
        process.exit(1);
    }
}

runAllTests();
