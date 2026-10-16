const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const db = require('./db');
const {
  createOtp,
  verifyOtp,
  getOrCreateUser,
  createSession,
  authMiddleware,
  revokeSession,
  generateSecureCode
} = require('./auth');

const router = express.Router();

const recordingsDir = process.env.RECORDINGS_DIR || path.join(__dirname, '..', 'data', 'recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

// Multer storage for recorded video files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, recordingsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, unique);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 } // 250MB per clip
});

// Prepared statements for devices
const listDevices = db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY is_online DESC, last_seen DESC');
const getDevice = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?');
const renameDevice = db.prepare('UPDATE devices SET name = ? WHERE id = ? AND user_id = ?');
const deleteDevice = db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?');

// Prepared statements for pairing
const insertPairingCode = db.prepare('INSERT INTO pairing_codes (code, user_id, camera_name, expires_at, used) VALUES (?, ?, ?, ?, 0)');
const findPairingCode = db.prepare('SELECT * FROM pairing_codes WHERE code = ? AND used = 0 AND expires_at > ?');
const markPairingCodeUsed = db.prepare('UPDATE pairing_codes SET used = 1 WHERE code = ?');

// Prepared statements for recordings
const listRecordings = db.prepare('SELECT * FROM recordings WHERE user_id = ? ORDER BY created_at DESC');
const getRecording = db.prepare('SELECT * FROM recordings WHERE id = ? AND user_id = ?');
const insertRecording = db.prepare(`
  INSERT INTO recordings (id, user_id, camera_id, camera_name, title, filename, file_size, duration, mime_type, thumbnail_data, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const deleteRecordingDb = db.prepare('DELETE FROM recordings WHERE id = ? AND user_id = ?');

// Prepared statements for events
const listEvents = db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY timestamp DESC LIMIT 100');
const insertEvent = db.prepare(`
  INSERT INTO events (id, user_id, camera_id, camera_name, timestamp, visitor_name, known, flags, snapshot_url, recording_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateEventKnown = db.prepare('UPDATE events SET known = ?, visitor_name = ? WHERE id = ? AND user_id = ?');

/* ========================================================
   AUTHENTICATION ROUTES
======================================================== */
router.post('/auth/otp/send', (req, res) => {
  const { contact } = req.body || {};
  if (!contact || typeof contact !== 'string') {
    return res.status(400).json({ ok: false, error: 'Contact identifier (email or phone) is required' });
  }

  const cleanContact = contact.trim().toLowerCase();
  const { code, expiresAt } = createOtp(cleanContact);

  // In development / demo mode, return the code in response for testing convenience.
  // In a production setup with Twilio / SendGrid, send via SMS / email.
  const isDev = process.env.NODE_ENV !== 'production';
  return res.json({
    ok: true,
    message: isDev
      ? `Demo mode: verification code generated (${code})`
      : 'Verification code sent to your contact address',
    demoCode: isDev ? code : undefined,
    expiresAt
  });
});

router.post('/auth/otp/verify', (req, res) => {
  const { contact, code } = req.body || {};
  if (!contact || !code) {
    return res.status(400).json({ ok: false, error: 'Contact and verification code are required' });
  }

  const cleanContact = contact.trim().toLowerCase();
  const verification = verifyOtp(cleanContact, String(code));
  if (!verification.ok) {
    return res.status(400).json({ ok: false, error: verification.message });
  }

  const kind = cleanContact.includes('@') ? 'email' : 'phone';
  const user = getOrCreateUser(cleanContact, kind);
  const session = createSession(user.id);

  return res.json({
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      identifier: user.identifier,
      kind: user.kind
    }
  });
});

router.get('/auth/me', authMiddleware, (req, res) => {
  const devices = listDevices.all(req.user.id);
  res.json({
    ok: true,
    user: {
      id: req.user.id,
      identifier: req.user.identifier,
      kind: req.user.kind
    },
    devices
  });
});

router.post('/auth/logout', authMiddleware, (req, res) => {
  revokeSession(req.session.token);
  res.json({ ok: true, message: 'Logged out successfully' });
});

/* ========================================================
   DEVICE PAIRING ROUTES
======================================================== */
// Generate a 6-digit secure pairing code to pair a new camera
router.post('/pairing/generate', authMiddleware, (req, res) => {
  const { cameraName = 'New Camera' } = req.body || {};
  const code = generateSecureCode();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  insertPairingCode.run(code, req.user.id, cameraName.trim(), expiresAt);

  // Return code and a direct pairing URL payload for QR code generation
  const host = req.get('host');
  const protocol = req.protocol;
  const qrUrl = `${protocol}://${host}/#pair=${code}`;

  res.json({
    ok: true,
    code,
    cameraName,
    expiresAt,
    qrUrl
  });
});

// A new camera device claims an unexpired pairing code to attach to an account
router.post('/pairing/claim', (req, res) => {
  const { code, deviceName = 'Front Door', deviceId } = req.body || {};
  if (!code) {
    return res.status(400).json({ ok: false, error: 'Pairing code is required' });
  }

  const pairing = findPairingCode.get(String(code).trim(), Date.now());
  if (!pairing) {
    return res.status(400).json({ ok: false, error: 'Invalid or expired pairing code. Please generate a new code on your viewer device.' });
  }

  markPairingCodeUsed.run(pairing.code);

  // Generate session token for the new paired camera device
  const session = createSession(pairing.user_id);
  const user = db.prepare('SELECT id, identifier, kind FROM users WHERE id = ?').get(pairing.user_id);

  // Auto-register device
  const targetId = deviceId || 'cam_' + crypto.randomBytes(6).toString('hex');
  const now = Date.now();
  db.prepare(`
    INSERT INTO devices (id, user_id, name, device_type, is_online, last_seen, created_at)
    VALUES (?, ?, ?, 'camera', 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_online = 1, last_seen = excluded.last_seen
  `).run(targetId, pairing.user_id, (deviceName || pairing.camera_name || 'Paired Camera').trim(), now, now);

  res.json({
    ok: true,
    token: session.token,
    deviceId: targetId,
    deviceName: deviceName || pairing.camera_name,
    user
  });
});

/* ========================================================
   DEVICE MANAGEMENT ROUTES
======================================================== */
router.get('/devices', authMiddleware, (req, res) => {
  const devices = listDevices.all(req.user.id);
  res.json({ ok: true, devices });
});

router.patch('/devices/:id', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ ok: false, error: 'Device name is required' });
  }

  const result = renameDevice.run(name.trim(), req.params.id, req.user.id);
  if (result.changes === 0) {
    return res.status(404).json({ ok: false, error: 'Device not found' });
  }

  res.json({ ok: true, message: 'Device renamed successfully' });
});

router.delete('/devices/:id', authMiddleware, (req, res) => {
  const result = deleteDevice.run(req.params.id, req.user.id);
  if (result.changes === 0) {
    return res.status(404).json({ ok: false, error: 'Device not found' });
  }

  res.json({ ok: true, message: 'Device removed successfully' });
});

/* ========================================================
   RECORDING ROUTES
======================================================== */
router.get('/recordings', authMiddleware, (req, res) => {
  const recordings = listRecordings.all(req.user.id);
  res.json({ ok: true, recordings });
});

router.post('/recordings', authMiddleware, upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No video file provided' });
  }

  const {
    cameraId = null,
    cameraName = 'Security Camera',
    title = 'Recorded Clip',
    duration = 0,
    thumbnailData = '',
    motionEventId = null
  } = req.body;

  const id = 'rec_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const mimeType = req.file.mimetype || 'video/webm';

  insertRecording.run(
    id,
    req.user.id,
    cameraId,
    cameraName,
    title,
    req.file.filename,
    req.file.size,
    parseFloat(duration) || 0,
    mimeType,
    thumbnailData || null,
    now
  );

  res.json({
    ok: true,
    recording: {
      id,
      cameraName,
      title,
      fileSize: req.file.size,
      duration: parseFloat(duration) || 0,
      mimeType,
      createdAt: now
    }
  });
});

// Stream video with HTTP 206 Partial Content (Supports fast seeking!)
router.get('/recordings/:id/stream', (req, res) => {
  // Support both header and query token for media element source tags
  const token = (req.headers.authorization && req.headers.authorization.startsWith('Bearer '))
    ? req.headers.authorization.substring(7)
    : req.query.token;

  const { authenticateToken } = require('./auth');
  const auth = authenticateToken(token);
  if (!auth) {
    return res.status(401).send('Unauthorized');
  }

  const rec = getRecording.get(req.params.id, auth.user.id);
  if (!rec) {
    return res.status(404).send('Recording not found');
  }

  const filePath = path.join(recordingsDir, rec.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Video file not found on disk');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': rec.mime_type
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': rec.mime_type,
      'Accept-Ranges': 'bytes'
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// Download recording
router.get('/recordings/:id/download', (req, res) => {
  const token = (req.headers.authorization && req.headers.authorization.startsWith('Bearer '))
    ? req.headers.authorization.substring(7)
    : req.query.token;

  const { authenticateToken } = require('./auth');
  const auth = authenticateToken(token);
  if (!auth) {
    return res.status(401).send('Unauthorized');
  }

  const rec = getRecording.get(req.params.id, auth.user.id);
  if (!rec) {
    return res.status(404).send('Recording not found');
  }

  const filePath = path.join(recordingsDir, rec.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const safeDownloadName = `Sentinel_${rec.camera_name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${new Date(rec.created_at).toISOString().slice(0, 19).replace(/:/g, '-')}${path.extname(rec.filename)}`;
  res.download(filePath, safeDownloadName);
});

// Delete recording
router.delete('/recordings/:id', authMiddleware, (req, res) => {
  const rec = getRecording.get(req.params.id, req.user.id);
  if (!rec) {
    return res.status(404).json({ ok: false, error: 'Recording not found' });
  }

  const filePath = path.join(recordingsDir, rec.filename);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.error('Error removing file:', e);
    }
  }

  deleteRecordingDb.run(req.params.id, req.user.id);
  res.json({ ok: true, message: 'Recording deleted successfully' });
});

/* ========================================================
   SECURITY EVENTS ROUTES
======================================================== */
router.get('/events', authMiddleware, (req, res) => {
  const events = listEvents.all(req.user.id).map(e => ({
    ...e,
    flags: JSON.parse(e.flags || '[]')
  }));
  res.json({ ok: true, events });
});

router.post('/events', authMiddleware, (req, res) => {
  const {
    cameraId = null,
    cameraName = 'Security Camera',
    timestamp = Date.now(),
    visitorName = 'Unknown visitor',
    known = 0,
    flags = [],
    snapshotUrl = null,
    recordingId = null
  } = req.body || {};

  const id = 'ev_' + crypto.randomBytes(8).toString('hex');
  insertEvent.run(
    id,
    req.user.id,
    cameraId,
    cameraName,
    timestamp,
    visitorName,
    known ? 1 : 0,
    JSON.stringify(flags),
    snapshotUrl,
    recordingId
  );

  res.json({ ok: true, id });
});

router.patch('/events/:id', authMiddleware, (req, res) => {
  const { known = 1, visitorName = 'Known visitor' } = req.body || {};
  const result = updateEventKnown.run(known ? 1 : 0, visitorName, req.params.id, req.user.id);
  if (result.changes === 0) {
    return res.status(404).json({ ok: false, error: 'Event not found' });
  }

  res.json({ ok: true, message: 'Event updated' });
});

/* ========================================================
   ICE CONFIGURATION ROUTE
======================================================== */
router.get('/ice-servers', (req, res) => {
  const rawStun = process.env.STUN_SERVERS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';
  const iceServers = rawStun.split(',').map(s => ({ urls: s.trim() }));

  if (process.env.TURN_SERVER) {
    const turn = {
      urls: process.env.TURN_SERVER
    };
    if (process.env.TURN_USERNAME) turn.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) turn.credential = process.env.TURN_CREDENTIAL;
    iceServers.push(turn);
  }

  res.json({ ok: true, iceServers });
});

/* ========================================================
   LEGACY ALERT TEST ROUTE (Compatible with existing UI)
======================================================== */
router.post('/alert', (req, res) => {
  const { channel, to, message } = req.body || {};
  console.log(`[Alert Test] Channel: ${channel}, To: ${to}, Message: ${message}`);
  res.json({ ok: true, message: `Alert queued for ${to} via ${channel}` });
});

module.exports = router;
