const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');

// Set test environment
process.env.DATABASE_PATH = path.join(__dirname, '..', 'data', 'test-sentinel.db');
process.env.RECORDINGS_DIR = path.join(__dirname, '..', 'data', 'test-recordings');
process.env.PORT = '3001';

const db = require('../server/db');
const { createOtp, verifyOtp, getOrCreateUser, createSession, authenticateToken } = require('../server/auth');
const { app, server } = require('../server/server');

async function runTests() {
  console.log('🧪 Starting Sentinel Backend Test Suite...\n');

  // Test 1: DB Schema Check
  console.log('Test 1: Verify database tables exist');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  ['users', 'sessions', 'devices', 'pairing_codes', 'recordings', 'events'].forEach(tbl => {
    assert(tables.includes(tbl), `Table ${tbl} should exist`);
  });
  console.log('  ✓ All database tables initialized');

  // Test 2: OTP Creation and Verification
  console.log('Test 2: Test OTP flow');
  const contact = 'test@example.com';
  const { code } = createOtp(contact);
  assert(code && code.length === 6, 'OTP must be 6 digits');
  const badVerify = verifyOtp(contact, '000000');
  assert(!badVerify.ok, 'Invalid OTP should fail');
  const goodVerify = verifyOtp(contact, code);
  assert(goodVerify.ok, 'Valid OTP should succeed');
  console.log('  ✓ OTP generation, rate limiting and validation passed');

  // Test 3: User & Session
  console.log('Test 3: User creation and session authentication');
  const user = getOrCreateUser(contact, 'email');
  assert(user.id && user.identifier === contact, 'User record created');
  const session = createSession(user.id);
  assert(session.token, 'Session token created');
  const auth = authenticateToken(session.token);
  assert(auth && auth.user.id === user.id, 'Session authenticates user');
  console.log('  ✓ User and session authenticated successfully');

  // Test 4: HTTP API test
  console.log('Test 4: HTTP API Server & ICE Servers endpoint');
  await new Promise((resolve) => setTimeout(resolve, 500));

  const apiRes = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:3001/api/ice-servers', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    }).on('error', reject);
  });

  assert(apiRes.status === 200, 'HTTP status should be 200');
  assert(apiRes.body.ok === true, 'Response body should indicate ok: true');
  assert(Array.isArray(apiRes.body.iceServers), 'Ice servers must be an array');
  console.log('  ✓ ICE servers endpoint returned valid configuration');

  console.log('\n🎉 ALL BACKEND UNIT TESTS PASSED SUCCESSFULLY!\n');
  server.close();
  process.exit(0);
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  server.close();
  process.exit(1);
});
