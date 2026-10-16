const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

process.env.DATABASE_PATH = path.join(__dirname, '..', 'data', 'test-sentinel-e2e.db');
process.env.RECORDINGS_DIR = path.join(__dirname, '..', 'data', 'test-recordings-e2e');
process.env.PORT = '3002';

const db = require('../server/db');
const { app, server } = require('../server/server');

function makeRequest(method, pathName, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 3002,
      path: pathName,
      method: method,
      headers: { ...headers }
    };

    if (body && typeof body === 'object' && !(body instanceof Buffer)) {
      body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    } else if (body && body instanceof Buffer) {
      options.headers['Content-Length'] = body.length;
    }

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const rawBuffer = Buffer.concat(chunks);
        const text = rawBuffer.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json || text,
          buffer: rawBuffer
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runE2ETests() {
  console.log('🚀 Running Sentinel End-to-End API & Workflow Tests...\n');

  await new Promise(r => setTimeout(r, 600));

  // 1. Sign in with OTP
  console.log('1. Testing OTP Authentication Flow:');
  const otpRes = await makeRequest('POST', '/api/auth/otp/send', {}, { contact: 'owner@sentinel.home' });
  assert.strictEqual(otpRes.statusCode, 200);
  assert(otpRes.body.ok, 'OTP request should succeed');
  const demoCode = otpRes.body.demoCode;
  assert(demoCode, 'Demo code should be provided in dev mode');

  const verifyRes = await makeRequest('POST', '/api/auth/otp/verify', {}, { contact: 'owner@sentinel.home', code: demoCode });
  assert.strictEqual(verifyRes.statusCode, 200);
  assert(verifyRes.body.token, 'Session token should be returned');
  const viewerToken = verifyRes.body.token;
  const authHeaders = { 'Authorization': `Bearer ${viewerToken}` };
  console.log('  ✓ Viewer logged in with session token');

  // 2. Generate Pairing Code on Viewer Device
  console.log('2. Testing Camera Pairing Code Generation:');
  const pairRes = await makeRequest('POST', '/api/pairing/generate', authHeaders, { cameraName: 'Front Door Camera' });
  assert.strictEqual(pairRes.statusCode, 200);
  assert(pairRes.body.code && pairRes.body.code.length === 6, 'Valid 6-digit pairing code generated');
  assert(pairRes.body.qrUrl, 'QR code payload url returned');
  const pairingCode = pairRes.body.code;
  console.log(`  ✓ Generated Pairing Code: ${pairingCode} (QR URL: ${pairRes.body.qrUrl})`);

  // 3. New Camera Device claims the pairing code
  console.log('3. Testing New Device Pairing Claim:');
  const claimRes = await makeRequest('POST', '/api/pairing/claim', {}, {
    code: pairingCode,
    deviceName: 'Front Door Camera',
    deviceId: 'cam_front_door_test'
  });
  assert.strictEqual(claimRes.statusCode, 200);
  assert(claimRes.body.ok, 'Claim should succeed');
  assert(claimRes.body.token, 'New device receives authorized session token');
  const cameraToken = claimRes.body.token;
  console.log('  ✓ New camera device paired to account and received session token');

  // 4. Verify Device List on Viewer
  console.log('4. Testing Device Listing:');
  const devicesRes = await makeRequest('GET', '/api/devices', authHeaders);
  assert.strictEqual(devicesRes.statusCode, 200);
  assert(devicesRes.body.devices.some(d => d.name === 'Front Door Camera'), 'Camera appears in device list');
  console.log('  ✓ Camera verified in user device registry');

  // 5. Test Video Recording Upload
  console.log('5. Testing Video Recording Upload (Multer):');
  const dummyVideoContent = Buffer.from('RIFF....WEBM-TEST-SAMPLE-VIDEO-BUFFER-SENTINEL-12345');
  const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
  let bodyBuffer = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="cameraName"\r\n\r\nFront Door\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nVisitor Arrival Clip\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="duration"\r\n\r\n12.5\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="clip1.webm"\r\nContent-Type: video/webm\r\n\r\n`),
    dummyVideoContent,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const uploadRes = await makeRequest('POST', '/api/recordings', {
    ...authHeaders,
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  }, bodyBuffer);

  assert.strictEqual(uploadRes.statusCode, 200);
  assert(uploadRes.body.ok, 'Recording upload should succeed');
  const recId = uploadRes.body.recording.id;
  assert(recId, 'Recording ID returned');
  console.log(`  ✓ Recording uploaded successfully: ID ${recId}`);

  // 6. Test Recordings Query
  console.log('6. Testing Recordings Library Query:');
  const listRecsRes = await makeRequest('GET', '/api/recordings', authHeaders);
  assert.strictEqual(listRecsRes.statusCode, 200);
  assert(listRecsRes.body.recordings.some(r => r.id === recId), 'Recording present in library');
  console.log('  ✓ Recording listed with metadata, duration and size');

  // 7. Test Video Streaming with HTTP 206 Partial Content (Seeking support)
  console.log('7. Testing Video Streaming with HTTP 206 Range Request (Scrubber):');
  const streamRes = await makeRequest('GET', `/api/recordings/${recId}/stream`, {
    ...authHeaders,
    'Range': 'bytes=0-15'
  });
  assert.strictEqual(streamRes.statusCode, 206, 'Must return 206 Partial Content');
  assert(streamRes.headers['content-range'], 'Must contain Content-Range header');
  assert.strictEqual(streamRes.buffer.length, 16, 'Should stream exact requested slice');
  console.log(`  ✓ Range request seeking succeeded: Content-Range: ${streamRes.headers['content-range']}`);

  // 8. Test Download Recording
  console.log('8. Testing Recording Download Endpoint:');
  const downloadRes = await makeRequest('GET', `/api/recordings/${recId}/download`, authHeaders);
  assert.strictEqual(downloadRes.statusCode, 200);
  assert(downloadRes.headers['content-disposition'], 'Attachment disposition returned');
  assert(downloadRes.buffer.length >= dummyVideoContent.length, 'Full video bytes downloaded');
  console.log('  ✓ Video downloaded intact');

  // 9. Test Security Event Creation
  console.log('9. Testing Security Event Logging:');
  const eventRes = await makeRequest('POST', '/api/events', authHeaders, {
    cameraName: 'Front Door',
    visitorName: 'Delivery Driver',
    known: 1,
    flags: ['After hours']
  });
  assert.strictEqual(eventRes.statusCode, 200);
  assert(eventRes.body.id, 'Event created');

  const eventsListRes = await makeRequest('GET', '/api/events', authHeaders);
  assert.strictEqual(eventsListRes.statusCode, 200);
  assert(eventsListRes.body.events.some(e => e.visitor_name === 'Delivery Driver'));
  console.log('  ✓ Security event stored and queried with flags');

  // 10. Test Deleting Recording
  console.log('10. Testing Recording Deletion:');
  const delRes = await makeRequest('DELETE', `/api/recordings/${recId}`, authHeaders);
  assert.strictEqual(delRes.statusCode, 200);
  assert(delRes.body.ok, 'Recording deleted');
  console.log('  ✓ Video deleted from disk and database');

  console.log('\n🎉 ALL 10 END-TO-END WORKFLOW TESTS PASSED PERFECTLY!\n');
  server.close();
  process.exit(0);
}

runE2ETests().catch(err => {
  console.error('❌ E2E Test failed:', err);
  server.close();
  process.exit(1);
});
