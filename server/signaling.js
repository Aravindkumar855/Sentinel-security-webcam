const db = require('./db');
const { authenticateToken } = require('./auth');

// In-memory mapping of active sockets and devices
// deviceId -> { socketId, userId, name, deviceType, isOnline, lastSeen }
const activeDevices = new Map();
// socketId -> deviceId
const socketToDevice = new Map();

// Database statements for devices
const upsertDevice = db.prepare(`
  INSERT INTO devices (id, user_id, name, device_type, is_online, last_seen, created_at)
  VALUES (?, ?, ?, ?, 1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET 
    name = excluded.name, 
    device_type = excluded.device_type, 
    is_online = 1, 
    last_seen = excluded.last_seen
`);

const setDeviceOffline = db.prepare(`
  UPDATE devices SET is_online = 0, last_seen = ? WHERE id = ?
`);

const listUserDevices = db.prepare(`
  SELECT id, user_id, name, device_type, is_online, last_seen, created_at 
  FROM devices WHERE user_id = ? ORDER BY is_online DESC, last_seen DESC
`);

function setupSignaling(io) {
  // Socket.IO Authentication Middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      return next(new Error('Authentication token required'));
    }

    const auth = authenticateToken(token);
    if (!auth) {
      return next(new Error('Invalid or expired authentication token'));
    }

    socket.user = auth.user;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    const userRoom = `user:${userId}`;
    socket.join(userRoom);

    // Register a device as camera or viewer
    socket.on('device:register', (data) => {
      const { deviceId, name, deviceType } = data || {};
      if (!deviceId || !name || !deviceType) {
        socket.emit('error', { message: 'Missing device registration parameters' });
        return;
      }

      const now = Date.now();
      socket.deviceId = deviceId;
      socketToDevice.set(socket.id, deviceId);

      activeDevices.set(deviceId, {
        socketId: socket.id,
        userId,
        name,
        deviceType, // 'camera' or 'viewer'
        isOnline: true,
        lastSeen: now
      });

      // Persist to DB
      upsertDevice.run(deviceId, userId, name, deviceType, now, now);

      // Notify this socket and all viewers belonging to this user
      const devices = listUserDevices.all(userId);
      io.to(userRoom).emit('devices:updated', { devices });
      socket.emit('device:registered', { deviceId, status: 'ok' });
    });

    // Request current device list
    socket.on('device:list', () => {
      const devices = listUserDevices.all(userId);
      socket.emit('devices:updated', { devices });
    });

    // WebRTC Signaling: Offer (viewer -> camera or camera -> viewer)
    socket.on('webrtc:offer', (payload) => {
      const { targetDeviceId, offer, sdp } = payload || {};
      const target = activeDevices.get(targetDeviceId);
      if (!target || target.userId !== userId) {
        socket.emit('webrtc:error', { targetDeviceId, message: 'Camera device is offline or unavailable' });
        return;
      }

      io.to(target.socketId).emit('webrtc:offer', {
        fromDeviceId: socket.deviceId,
        offer,
        sdp
      });
    });

    // WebRTC Signaling: Answer (camera -> viewer)
    socket.on('webrtc:answer', (payload) => {
      const { targetDeviceId, answer, sdp } = payload || {};
      const target = activeDevices.get(targetDeviceId);
      if (!target || target.userId !== userId) {
        socket.emit('webrtc:error', { targetDeviceId, message: 'Viewer device is offline or unavailable' });
        return;
      }

      io.to(target.socketId).emit('webrtc:answer', {
        fromDeviceId: socket.deviceId,
        answer,
        sdp
      });
    });

    // WebRTC Signaling: ICE Candidate Exchange
    socket.on('webrtc:ice-candidate', (payload) => {
      const { targetDeviceId, candidate } = payload || {};
      const target = activeDevices.get(targetDeviceId);
      if (!target || target.userId !== userId) {
        return;
      }

      io.to(target.socketId).emit('webrtc:ice-candidate', {
        fromDeviceId: socket.deviceId,
        candidate
      });
    });

    // WebRTC Signaling: Session Hangup / Close
    socket.on('webrtc:hangup', (payload) => {
      const { targetDeviceId } = payload || {};
      const target = activeDevices.get(targetDeviceId);
      if (target && target.userId === userId) {
        io.to(target.socketId).emit('webrtc:hangup', {
          fromDeviceId: socket.deviceId
        });
      }
    });

    // Real-time Motion Alert broadcasted across all devices of the user
    socket.on('alert:motion', (eventData) => {
      // Forward to all viewers in this user's room
      socket.to(userRoom).emit('alert:motion', {
        ...eventData,
        fromDeviceId: socket.deviceId
      });
    });

    // Heartbeat
    socket.on('device:heartbeat', () => {
      if (socket.deviceId && activeDevices.has(socket.deviceId)) {
        const dev = activeDevices.get(socket.deviceId);
        dev.lastSeen = Date.now();
      }
    });

    // Disconnect cleanup
    socket.on('disconnect', () => {
      const deviceId = socketToDevice.get(socket.id);
      if (deviceId) {
        socketToDevice.delete(socket.id);
        const dev = activeDevices.get(deviceId);
        if (dev && dev.socketId === socket.id) {
          activeDevices.delete(deviceId);
          const now = Date.now();
          setDeviceOffline.run(now, deviceId);

          // Broadcast updated device list to user's remaining sockets
          const devices = listUserDevices.all(userId);
          io.to(userRoom).emit('devices:updated', { devices });

          // Notify any connected peer that this device disconnected
          socket.to(userRoom).emit('device:offline', { deviceId });
        }
      }
    });
  });
}

module.exports = { setupSignaling };
