require('dotenv').config();
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const routes = require('./routes');
const { setupSignaling } = require('./signaling');

const app = express();
const server = http.createServer(app);

// Configure CORS and JSON parsing
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']
}));

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Mount API routes
app.use('/api', routes);

// Serve static frontend assets
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Fallback route for SPA navigation
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Setup Socket.IO for WebRTC Signaling & Realtime Events
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 30000,
  pingInterval: 10000
});

setupSignaling(io);

// Discover local network IPv4 addresses for easy mobile testing
function getLocalNetworkAddresses() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`\n========================================================`);
  console.log(`🛡️  SENTINEL SECURITY WEBCAM — SERVER STARTED`);
  console.log(`========================================================`);
  console.log(`📡 Local Viewer:        http://localhost:${PORT}`);
  const lanIps = getLocalNetworkAddresses();
  lanIps.forEach(ip => {
    console.log(`📱 Connect Mobile/Cam:  http://${ip}:${PORT}`);
  });
  console.log(`⚙️  Environment:         ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 Database:            ${process.env.DATABASE_PATH || './data/sentinel.db'}`);
  console.log(`🎥 Storage:             ${process.env.RECORDINGS_DIR || './data/recordings'}`);
  console.log(`========================================================\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down Sentinel server...');
  server.close(() => {
    console.log('Server stopped.');
    process.exit(0);
  });
});

module.exports = { app, server };
