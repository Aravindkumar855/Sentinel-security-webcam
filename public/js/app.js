/**
 * Sentinel Security Webcam — Core Application Engine
 */
(function(global) {
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  // Application Global State
  const AppState = {
    user: null,
    token: null,
    deviceId: null,
    role: 'viewer', // 'viewer' or 'camera'
    mode: 'home', // 'home' or 'away'
    status: 'off',
    sound: true,
    push: false,
    silent: false,
    sens: 60,
    people: true,
    cool: 20,
    autorec: true,
    log: [],
    devices: [],
    currentCamId: null,
    activeStream: null,
    isBroadcasting: false,
    socket: null,
    webrtc: null,
    recorder: null,
    motionBox: null,
    motionBoxT: 0,
    hits: 0,
    lastTrig: 0,
    detUntil: 0
  };

  // Toast Notification
  function showToast(msg, duration = 3000) {
    const container = $('#toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // Helpers
  const dayLabel = t => {
    const a = new Date(t), b = new Date(), D = 864e5;
    const d = Math.round((new Date(b.toDateString()) - new Date(a.toDateString())) / D);
    return d === 0 ? 'Today' : d === 1 ? 'Yesterday' : a.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  };
  const tm = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const formatSec = s => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };

  // Web Audio Chime
  function playChime() {
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)();
      [[784, 0], [1046, .22], [784, .5], [1046, .72]].forEach(([f, d]) => {
        const o = a.createOscillator(), g = a.createGain();
        o.frequency.value = f;
        o.type = 'sine';
        o.connect(g);
        g.connect(a.destination);
        g.gain.setValueAtTime(0, a.currentTime + d);
        g.gain.linearRampToValueAtTime(.25, a.currentTime + d + .02);
        g.gain.exponentialRampToValueAtTime(.001, a.currentTime + d + .4);
        o.start(a.currentTime + d);
        o.stop(a.currentTime + d + .45);
      });
    } catch (e) {
      console.warn('AudioContext failed:', e);
    }
  }

  // Generate or retrieve persistent device ID
  function getDeviceId() {
    let id = localStorage.getItem('sentinel_device_id');
    if (!id) {
      id = 'dev_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
      localStorage.setItem('sentinel_device_id', id);
    }
    return id;
  }

  AppState.deviceId = getDeviceId();

  /* ========================================================
     AUTHENTICATION & SESSION
  ======================================================== */
  async function initAuth() {
    const token = localStorage.getItem('sentinel_token');
    const userStr = localStorage.getItem('sentinel_user');

    if (token && userStr) {
      try {
        AppState.token = token;
        AppState.user = JSON.parse(userStr);
        // Verify token with backend
        const res = await fetch('/api/auth/me', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          if (data.ok) {
            AppState.user = data.user;
            AppState.devices = data.devices || [];
            enterApp();
            return;
          }
        }
      } catch (e) {
        console.warn('Backend verification failed, using cached session:', e);
        if (AppState.user) {
          enterApp();
          return;
        }
      }
    }

    // Check URL fragment for #pair=123456 shortcut
    if (window.location.hash.startsWith('#pair=')) {
      const code = window.location.hash.replace('#pair=', '').trim();
      if (code) {
        $('#login').classList.remove('hidden');
        $('#lg1').classList.add('hidden');
        $('#lg-pair-form').classList.remove('hidden');
        $('#lg-pair-code').value = code;
      }
    }
  }

  function enterApp() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#whoami').textContent = AppState.user.identifier || 'User';
    $('#s-email').value = AppState.user.kind === 'email' ? AppState.user.identifier : '';
    $('#s-phone').value = AppState.user.kind === 'phone' ? AppState.user.identifier : '';

    // Initialize WebRTC and Socket
    initSocket();
    initRecorder();
    loadRecordings();
    loadEvents();
    updateDashboard();

    // Default to Live viewer or Dashboard
    switchView('dash');
  }

  function signOut() {
    if (AppState.token) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${AppState.token}` }
      }).catch(() => {});
    }
    localStorage.removeItem('sentinel_token');
    localStorage.removeItem('sentinel_user');
    location.reload();
  }

  /* ========================================================
     SOCKET.IO & REALTIME SIGNALING
  ======================================================== */
  function initSocket() {
    if (typeof io === 'undefined') {
      console.warn('Socket.IO client library not loaded. Working in local offline mode.');
      return;
    }

    if (AppState.socket) {
      AppState.socket.disconnect();
    }

    AppState.socket = io({
      auth: { token: AppState.token },
      reconnectionAttempts: 10,
      timeout: 10000
    });

    // WebRTC Manager
    AppState.webrtc = new SentinelWebRTC.WebRTCManager(AppState.socket, {
      role: AppState.role,
      onRemoteStream: (stream) => {
        const vid = $('#vid');
        vid.srcObject = stream;
        vid.play().catch(e => console.warn('Autoplay prevented:', e));
        AppState.activeStream = stream;
        $('#idle').classList.add('hidden');
        $('#offline-screen').classList.add('hidden');
        setBadge('ok', 'Live Remote Feed');
        showToast('Connected to remote camera feed');
      },
      onConnectionState: (state) => {
        if (state === 'connecting') {
          setBadge('connecting', 'Connecting...');
        } else if (state === 'connected') {
          setBadge('ok', 'Live Remote Feed');
          $('#offline-screen').classList.add('hidden');
        } else if (state === 'disconnected' || state === 'failed') {
          setBadge('off', 'Camera Disconnected');
          $('#offline-screen').classList.remove('hidden');
        }
      },
      onCameraOffline: (camId) => {
        setBadge('off', 'Camera Offline');
        $('#offline-screen').classList.remove('hidden');
        showToast('Camera went offline');
      },
      onViewerCountChange: (count) => {
        $('#b-viewer-count').textContent = count;
      }
    });

    SentinelWebRTC.fetchIceServers();

    // Socket Connection events
    AppState.socket.on('connect', () => {
      $('#status-dot').style.background = 'var(--accent)';
      $('#status-text').textContent = 'Connected';
      $('#server-status').classList.add('online');

      // Register device as current role
      const devName = $('#b-name-input').value.trim() || 'Sentinel Camera';
      AppState.socket.emit('device:register', {
        deviceId: AppState.deviceId,
        name: devName,
        deviceType: AppState.role
      });
    });

    AppState.socket.on('disconnect', () => {
      $('#status-dot').style.background = 'var(--danger)';
      $('#status-text').textContent = 'Disconnected';
      $('#server-status').classList.remove('online');
    });

    // Remote devices updated
    AppState.socket.on('devices:updated', (data) => {
      if (data && Array.isArray(data.devices)) {
        AppState.devices = data.devices;
        renderDevicesList();
        updateCameraSelectDropdown();
        updateDashboard();
      }
    });

    // Realtime motion alert from another camera
    AppState.socket.on('alert:motion', (eventData) => {
      showRemoteMotionAlert(eventData);
    });
  }

  function setBadge(status, text) {
    const badge = $('#badge');
    badge.dataset.s = status;
    $('#btxt').textContent = text;
  }

  /* ========================================================
     NAVIGATION & VIEWS
  ======================================================== */
  function switchView(viewName) {
    $$('[data-view]').forEach(section => {
      section.classList.toggle('hidden', section.dataset.view !== viewName);
    });

    $$('.nav button').forEach(btn => {
      btn.setAttribute('aria-current', btn.dataset.v === viewName);
    });

    const activeBtn = $(`.nav button[data-v="${viewName}"]`);
    if (activeBtn) {
      $('#where').textContent = activeBtn.childNodes[0].textContent.trim();
    }

    menu(false);

    if (viewName === 'live') {
      fitCanvas();
    } else if (viewName === 'broadcast') {
      fitBroadcastCanvas();
    } else if (viewName === 'recordings') {
      loadRecordings();
    } else if (viewName === 'devices') {
      renderDevicesList();
    } else if (viewName === 'dash') {
      updateDashboard();
    }
  }

  function menu(isOpen) {
    $('#drawer').classList.toggle('open', isOpen);
    $('#scrim').classList.toggle('open', isOpen);
    $('#burger').setAttribute('aria-expanded', isOpen);
  }

  $('#burger').onclick = () => menu(true);
  $('#close').onclick = () => menu(false);
  $('#scrim').onclick = () => menu(false);
  addEventListener('keydown', e => { if (e.key === 'Escape') menu(false); });

  $$('.nav button').forEach(btn => {
    btn.onclick = () => switchView(btn.dataset.v);
  });

  // Home / Away Mode Toggle
  function setMode(m) {
    AppState.mode = m;
    $('#m-home').setAttribute('aria-pressed', m === 'home');
    $('#m-away').setAttribute('aria-pressed', m === 'away');
    $('#dash-mode-text').textContent = m === 'home' ? 'At Home' : 'Away, Armed';
    showToast(`System set to ${m === 'home' ? 'At Home' : 'Away, Armed'}`);
  }
  $('#m-home').onclick = () => setMode('home');
  $('#m-away').onclick = () => setMode('away');

  // Sign out button
  $('#out').onclick = signOut;

  /* ========================================================
     DASHBOARD OVERVIEW
  ======================================================== */
  function updateDashboard() {
    const cams = AppState.devices.filter(d => d.device_type === 'camera');
    const onlineCams = cams.filter(d => d.is_online);

    $('#dash-online-cams').textContent = onlineCams.length;
    $('#dash-total-cams').textContent = `${cams.length} registered ${cams.length === 1 ? 'device' : 'devices'}`;
    $('#n-cams').textContent = cams.length;

    // Today's events
    const todayCount = AppState.log.filter(e => {
      const d = Math.round((new Date() - new Date(e.t)) / 864e5);
      return d === 0;
    }).length;
    $('#dash-events-today').textContent = todayCount;

    // Recordings count
    SentinelDB.getAllRecordings().then(recs => {
      $('#dash-recs-count').textContent = recs.length;
      $('#n-recs').textContent = recs.length;
    });
  }

  $('#dash-btn-live').onclick = () => switchView('live');
  $('#dash-btn-broadcast').onclick = () => switchView('broadcast');
  $('#dash-btn-pair').onclick = () => openPairingModal();
  $('#dash-btn-recordings').onclick = () => switchView('recordings');

  /* ========================================================
     CAMERA BROADCASTER MODE (Run THIS device as camera)
  ======================================================== */
  const bVid = $('#b-vid'), bOv = $('#b-ov'), bOctx = bOv.getContext('2d');
  let bStream = null;

  async function populateCameraDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      const select = $('#b-camera-select');
      select.innerHTML = '';

      videoInputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${index + 1} (${device.deviceId.slice(0, 5)})`;
        select.appendChild(option);
      });
    } catch (e) {
      console.warn('Could not enumerate cameras:', e);
    }
  }

  async function startBroadcasting() {
    try {
      const deviceId = $('#b-camera-select').value;
      const audioConsent = $('#b-audio-consent').checked;
      const camName = $('#b-name-input').value.trim() || 'Camera Device';

      const constraints = {
        video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
        audio: audioConsent
      };

      bStream = await navigator.mediaDevices.getUserMedia(constraints);
      bVid.srcObject = bStream;
      await bVid.play();

      AppState.isBroadcasting = true;
      AppState.role = 'camera';
      if (AppState.webrtc) {
        AppState.webrtc.options.role = 'camera';
        AppState.webrtc.setLocalStream(bStream);
      }

      // Register with backend Socket.IO
      if (AppState.socket && AppState.socket.connected) {
        AppState.socket.emit('device:register', {
          deviceId: AppState.deviceId,
          name: camName,
          deviceType: 'camera'
        });
      }

      $('#b-idle').classList.add('hidden');
      $('#b-badge').dataset.s = 'ok';
      $('#b-btxt').textContent = 'Broadcasting Live';
      $('#b-camname-display').textContent = camName;
      fitBroadcastCanvas();
      showToast(`Broadcasting live as "${camName}"`);
    } catch (err) {
      console.error('Camera broadcast start error:', err);
      alert('Unable to access camera: ' + err.message + '. Please ensure camera permissions are granted.');
    }
  }

  function stopBroadcasting() {
    if (bStream) {
      bStream.getTracks().forEach(t => t.stop());
      bStream = null;
    }
    bVid.srcObject = null;
    AppState.isBroadcasting = false;

    if (AppState.webrtc) {
      AppState.webrtc.closeAllViewerConnections();
    }

    $('#b-idle').classList.remove('hidden');
    $('#b-badge').dataset.s = 'off';
    $('#b-btxt').textContent = 'Broadcaster Stopped';
    showToast('Broadcasting stopped');
  }

  $('#b-start-btn').onclick = startBroadcasting;
  $('#b-stop-btn').onclick = stopBroadcasting;
  $('#b-name-input').onchange = (e) => {
    $('#b-camname-display').textContent = e.target.value.trim() || 'Camera Device';
    if (AppState.socket && AppState.socket.connected) {
      AppState.socket.emit('device:register', {
        deviceId: AppState.deviceId,
        name: e.target.value.trim() || 'Camera Device',
        deviceType: 'camera'
      });
    }
  };
  $('#b-open-viewer-shortcut').onclick = () => switchView('live');

  function fitBroadcastCanvas() {
    const r = bOv.getBoundingClientRect();
    bOv.width = r.width * devicePixelRatio;
    bOv.height = r.height * devicePixelRatio;
  }
  addEventListener('resize', fitBroadcastCanvas);

  /* ========================================================
     LIVE VIEWER (Monitor Remote or Local Cameras)
  ======================================================== */
  const vid = $('#vid'), ov = $('#ov'), octx = ov.getContext('2d');
  const W = 64, H = 36, sm = document.createElement('canvas');
  sm.width = W; sm.height = H;
  const sctx = sm.getContext('2d', { willReadFrequently: true });
  let prev = null;

  function updateCameraSelectDropdown() {
    const select = $('#viewer-cam-select');
    const prevVal = select.value;
    select.innerHTML = '';

    const localOpt = document.createElement('option');
    localOpt.value = 'local';
    localOpt.textContent = '💻 This Device (Local Webcam)';
    select.appendChild(localOpt);

    const remoteCams = AppState.devices.filter(d => d.device_type === 'camera' && d.id !== AppState.deviceId);
    remoteCams.forEach(cam => {
      const opt = document.createElement('option');
      opt.value = cam.id;
      opt.textContent = `${cam.is_online ? '🟢' : '⚪'} ${cam.name} (${cam.is_online ? 'Online' : 'Offline'})`;
      select.appendChild(opt);
    });

    if (prevVal && [...select.options].some(o => o.value === prevVal)) {
      select.value = prevVal;
    }
  }

  async function connectSelectedFeed() {
    const selected = $('#viewer-cam-select').value;
    AppState.currentCamId = selected;

    if (selected === 'local') {
      await startLocalCam();
    } else {
      // Connect to remote WebRTC camera
      const targetCam = AppState.devices.find(d => d.id === selected);
      $('#camname').textContent = targetCam ? targetCam.name : 'Remote Camera';

      if (!targetCam || !targetCam.is_online) {
        $('#offline-screen').classList.remove('hidden');
        $('#offline-desc').textContent = `${targetCam ? targetCam.name : 'Camera'} is currently offline. Last seen: ${targetCam ? new Date(targetCam.last_seen).toLocaleTimeString() : 'Unknown'}`;
        setBadge('off', 'Camera Offline');
        return;
      }

      $('#offline-screen').classList.add('hidden');
      $('#idle').classList.add('hidden');
      if (AppState.webrtc) {
        AppState.role = 'viewer';
        AppState.webrtc.options.role = 'viewer';
        AppState.webrtc.connectToCamera(selected);
      }
    }
  }

  async function startLocalCam() {
    try {
      if (AppState.activeStream) {
        AppState.activeStream.getTracks().forEach(t => t.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: false
      });
      vid.srcObject = stream;
      await vid.play();
      AppState.activeStream = stream;
      AppState.cam = true;
      $('#idle').classList.add('hidden');
      $('#offline-screen').classList.add('hidden');
      $('#camname').textContent = 'This Device (Local)';
      setBadge('ok', 'Local Camera Active');
      fitCanvas();
      showToast('Local camera feed active');
    } catch (e) {
      console.warn('Local camera could not be opened:', e);
      $('#idle').querySelector('p').textContent = 'Camera access was denied or unavailable. You can view remote cameras or simulate visitors.';
    }
  }

  $('#viewer-connect-btn').onclick = connectSelectedFeed;
  $('#viewer-cam-select').onchange = connectSelectedFeed;
  $('#viewer-refresh-cams').onclick = () => {
    if (AppState.socket && AppState.socket.connected) {
      AppState.socket.emit('device:list');
      showToast('Refreshing device list...');
    }
  };
  $('#camOn').onclick = startLocalCam;
  $('#offline-retry-btn').onclick = connectSelectedFeed;
  $('#idle-pair-btn').onclick = () => openPairingModal();

  function fitCanvas() {
    const r = ov.getBoundingClientRect();
    ov.width = r.width * devicePixelRatio;
    ov.height = r.height * devicePixelRatio;
  }
  addEventListener('resize', fitCanvas);

  // Fullscreen toggle
  $('#fs-btn').onclick = () => {
    const stage = $('#stage');
    if (!document.fullscreenElement) {
      stage.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  /* ========================================================
     RECORDING ENGINE INTEGRATION
  ======================================================== */
  function initRecorder() {
    AppState.recorder = new SentinelRecorder.VideoRecorder({
      onTick: (elapsedSec) => {
        $('#rec-timer-txt').textContent = `REC ${formatSec(elapsedSec)}`;
      },
      onStateChange: (isRec) => {
        const btn = $('#rec-btn');
        const badge = $('#rec-badge');
        if (isRec) {
          btn.textContent = '■ Stop Recording';
          btn.classList.add('record-btn');
          badge.classList.remove('hidden');
        } else {
          btn.textContent = '● Record';
          btn.classList.remove('record-btn');
          badge.classList.add('hidden');
        }
      },
      onError: (err) => {
        showToast('Recording error: ' + err.message);
      }
    });
  }

  async function toggleRecording() {
    if (!AppState.recorder) return;

    if (!AppState.recorder.isRecording) {
      const activeStream = (AppState.activeStream && AppState.activeStream.active)
        ? AppState.activeStream
        : (vid.srcObject && vid.srcObject.active)
          ? vid.srcObject
          : null;

      if (!activeStream) {
        showToast('No active video stream to record. Please connect a camera first.');
        return;
      }

      const camName = $('#camname').textContent || 'Security Camera';
      try {
        AppState.recorder.start(activeStream, {
          cameraId: AppState.currentCamId,
          cameraName: camName,
          title: `${camName} Clip`
        });
        showToast('Recording started');
      } catch (e) {
        showToast('Could not start recording: ' + e.message);
      }
    } else {
      try {
        const item = await AppState.recorder.stop(vid);
        showToast(`Recording saved (${formatSec(item.duration)})`);
        loadRecordings();
        updateDashboard();
      } catch (e) {
        showToast('Recording save error: ' + e.message);
      }
    }
  }

  $('#rec-btn').onclick = toggleRecording;

  // Snapshot from video frame
  function takeSnapshot() {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const activeVid = vid.videoWidth ? vid : bVid;

    if (activeVid && activeVid.videoWidth) {
      ctx.drawImage(activeVid, 0, 0, 640, 360);
    } else {
      scene(canvas, Math.floor(Math.random() * 20));
    }

    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(0, 332, 640, 28);
    ctx.fillStyle = '#fff';
    ctx.font = '13px sans-serif';
    ctx.fillText(`${$('#camname').textContent} • ${new Date().toLocaleString()}`, 12, 351);

    return canvas.toDataURL('image/jpeg', 0.8);
  }

  $('#snap-btn').onclick = () => {
    const snapUrl = takeSnapshot();
    const a = document.createElement('a');
    a.href = snapUrl;
    a.download = `Sentinel_Snapshot_${Date.now()}.jpg`;
    a.click();
    showToast('Snapshot downloaded');
  };

  /* ========================================================
     RECORDINGS LIBRARY & VIDEO PLAYER MODAL
  ======================================================== */
  let currentLoadedRecordings = [];

  async function loadRecordings() {
    try {
      const localRecs = await SentinelDB.getAllRecordings();
      currentLoadedRecordings = localRecs;
      renderRecordingsGrid(localRecs);

      // Update storage info
      const estimate = await SentinelDB.getStorageEstimate();
      if (estimate) {
        $('#storage-quota-info').textContent = `Storage: ${estimate.usageMB} MB of ${estimate.quotaMB} MB used`;
      }

      // Populate camera filter dropdown
      const camSelect = $('#rec-filter-camera');
      const uniqueCams = [...new Set(localRecs.map(r => r.cameraName))];
      camSelect.innerHTML = '<option value="all">All Cameras</option>';
      uniqueCams.forEach(cam => {
        const opt = document.createElement('option');
        opt.value = cam;
        opt.textContent = cam;
        select.appendChild(opt);
      });
    } catch (e) {
      console.warn('Error loading recordings:', e);
    }
  }

  function renderRecordingsGrid(recordings) {
    const grid = $('#recordings-grid');
    if (!grid) return;

    if (!recordings || recordings.length === 0) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>No video recordings yet. Start recording from the Live Cameras view or enable Auto-Record on motion.</p></div>';
      return;
    }

    grid.innerHTML = recordings.map(rec => `
      <article class="rec-card" data-id="${rec.id}">
        <div class="rec-thumb" onclick="SentinelApp.playRecording('${rec.id}')">
          <img src="${rec.thumbnail || ''}" alt="${rec.title}">
          <span class="rec-dur">${formatSec(rec.duration)}</span>
          <div class="rec-play-overlay">
            <div class="rec-play-icon">▶</div>
          </div>
        </div>
        <div class="rec-body">
          <h3 class="rec-title">${rec.cameraName}</h3>
          <div class="rec-meta">
            <span>${dayLabel(rec.createdAt || rec.startAt)}, ${tm(rec.createdAt || rec.startAt)}</span>
            <span>${(rec.size / (1024 * 1024)).toFixed(1)} MB</span>
          </div>
          <div class="rec-actions">
            <button class="btn sm primary" onclick="SentinelApp.playRecording('${rec.id}')">▶ Play</button>
            <button class="btn sm" onclick="SentinelApp.downloadRecording('${rec.id}')">⬇ Download</button>
            <button class="btn sm danger" onclick="SentinelApp.deleteRecording('${rec.id}')">🗑 Delete</button>
          </div>
        </div>
      </article>
    `).join('');
  }

  // Filter and search recordings
  function applyRecordingFilters() {
    const cam = $('#rec-filter-camera').value;
    const sort = $('#rec-filter-sort').value;
    const query = $('#rec-search').value.toLowerCase().trim();

    let filtered = [...currentLoadedRecordings];
    if (cam !== 'all') {
      filtered = filtered.filter(r => r.cameraName === cam);
    }
    if (query) {
      filtered = filtered.filter(r => r.cameraName.toLowerCase().includes(query) || (r.title && r.title.toLowerCase().includes(query)));
    }
    if (sort === 'oldest') {
      filtered.sort((a, b) => a.createdAt - b.createdAt);
    } else {
      filtered.sort((a, b) => b.createdAt - a.createdAt);
    }
    renderRecordingsGrid(filtered);
  }

  $('#rec-filter-camera').onchange = applyRecordingFilters;
  $('#rec-filter-sort').onchange = applyRecordingFilters;
  $('#rec-search').oninput = applyRecordingFilters;
  $('#rec-refresh-btn').onclick = () => { loadRecordings(); showToast('Recordings refreshed'); };

  // Video Player Modal
  const playerModal = $('#player-modal');
  const modalVideo = $('#modal-video');
  let activeObjectUrl = null;

  async function playRecording(id) {
    const rec = await SentinelDB.getRecordingById(id);
    if (!rec) {
      showToast('Recording not found');
      return;
    }

    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }

    if (rec.blob) {
      activeObjectUrl = URL.createObjectURL(rec.blob);
      modalVideo.src = activeObjectUrl;
    } else {
      modalVideo.src = `/api/recordings/${id}/stream?token=${AppState.token}`;
    }

    $('#modal-rec-title').textContent = `${rec.cameraName} — ${dayLabel(rec.createdAt)}, ${tm(rec.createdAt)}`;
    playerModal.classList.remove('hidden');
    modalVideo.play().catch(() => {});
    $('#player-play-btn').textContent = '❚❚ Pause';

    // Hook download button inside player
    $('#player-download-btn').onclick = () => downloadRecording(id);
  }

  function closePlayerModal() {
    modalVideo.pause();
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
    modalVideo.src = '';
    playerModal.classList.add('hidden');
  }

  $('#modal-close-btn').onclick = closePlayerModal;
  playerModal.onclick = (e) => {
    if (e.target === playerModal) closePlayerModal();
  };

  // Player controls
  $('#player-play-btn').onclick = () => {
    if (modalVideo.paused) {
      modalVideo.play();
      $('#player-play-btn').textContent = '❚❚ Pause';
    } else {
      modalVideo.pause();
      $('#player-play-btn').textContent = '▶ Play';
    }
  };

  modalVideo.ontimeupdate = () => {
    const cur = modalVideo.currentTime || 0;
    const dur = modalVideo.duration || 1;
    $('#player-scrub').value = (cur / dur) * 100;
    $('#player-time-display').textContent = `${formatSec(cur)} / ${formatSec(dur)}`;
  };

  $('#player-scrub').oninput = (e) => {
    const dur = modalVideo.duration || 1;
    modalVideo.currentTime = (e.target.value / 100) * dur;
  };

  $('#player-volume').oninput = (e) => {
    modalVideo.volume = e.target.value;
    $('#player-mute-btn').textContent = modalVideo.volume === 0 ? '🔇' : '🔊';
  };

  $('#player-mute-btn').onclick = () => {
    modalVideo.muted = !modalVideo.muted;
    $('#player-mute-btn').textContent = modalVideo.muted ? '🔇' : '🔊';
  };

  $('#player-speed').onchange = (e) => {
    modalVideo.playbackRate = parseFloat(e.target.value);
  };

  $('#player-fullscreen-btn').onclick = () => {
    if (!document.fullscreenElement) {
      modalVideo.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  async function downloadRecording(id) {
    const rec = await SentinelDB.getRecordingById(id);
    if (!rec) return;

    const ext = rec.mimeType.includes('mp4') ? '.mp4' : '.webm';
    const filename = `Sentinel_${rec.cameraName.replace(/\s+/g, '_')}_${new Date(rec.createdAt).toISOString().slice(0, 19).replace(/:/g, '-')}${ext}`;

    if (rec.blob) {
      const url = URL.createObjectURL(rec.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Downloading recording...');
    } else {
      window.location.href = `/api/recordings/${id}/download?token=${AppState.token}`;
    }
  }

  async function deleteRecording(id) {
    if (!confirm('Are you sure you want to permanently delete this video recording?')) {
      return;
    }
    await SentinelDB.deleteRecording(id);
    if (AppState.token) {
      fetch(`/api/recordings/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${AppState.token}` }
      }).catch(() => {});
    }
    showToast('Recording deleted');
    loadRecordings();
    updateDashboard();
  }

  $('#clear-storage-btn').onclick = async () => {
    if (!confirm('This will wipe all locally stored video clips from this browser. Continue?')) {
      return;
    }
    const recs = await SentinelDB.getAllRecordings();
    for (const r of recs) {
      await SentinelDB.deleteRecording(r.id);
    }
    loadRecordings();
    updateDashboard();
    showToast('Local recordings cleared');
  };

  /* ========================================================
     DEVICE MANAGEMENT & PAIRING MODALS
  ======================================================== */
  function renderDevicesList() {
    const container = $('#devices-container');
    if (!container) return;

    const cams = AppState.devices.filter(d => d.device_type === 'camera');
    if (cams.length === 0) {
      container.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>No paired cameras found. Click "Add New Camera" above to pair an old smartphone or laptop as a security camera.</p></div>';
      return;
    }

    container.innerHTML = cams.map(cam => `
      <div class="device-card">
        <div class="device-card-header">
          <div>
            <h3>${cam.name}</h3>
            <span>ID: ${cam.id.slice(0, 10)}...</span>
          </div>
          <span class="badge" data-s="${cam.is_online ? 'ok' : 'off'}" style="position:static">
            <span class="dot"></span> ${cam.is_online ? 'Online' : 'Offline'}
          </span>
        </div>
        <div style="font-size:13px;color:var(--muted)">
          Last seen: ${new Date(cam.last_seen).toLocaleString()}
        </div>
        <div class="device-actions">
          <button class="btn sm primary" onclick="SentinelApp.viewCamera('${cam.id}')">View Feed</button>
          <button class="btn sm" onclick="SentinelApp.promptRenameDevice('${cam.id}', '${cam.name}')">Rename</button>
          <button class="btn sm danger" onclick="SentinelApp.removeDevice('${cam.id}')">Remove</button>
        </div>
      </div>
    `).join('');
  }

  let pairingTimerInterval = null;

  async function openPairingModal() {
    const modal = $('#pairing-modal');
    modal.classList.remove('hidden');

    const camName = $('#pair-cam-name').value || 'Front Door';
    try {
      const res = await fetch('/api/pairing/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AppState.token}`
        },
        body: JSON.stringify({ cameraName: camName })
      });
      const data = await res.json();
      if (data.ok) {
        $('#pairing-code-box').textContent = data.code;
        $('#qr-display').innerHTML = SentinelQR.generateQRCodeSVG(data.qrUrl, 180);

        // Start 10-minute expiry timer
        clearInterval(pairingTimerInterval);
        const expiresAt = data.expiresAt;
        pairingTimerInterval = setInterval(() => {
          const remSec = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
          $('#pairing-timer').textContent = `Code expires in ${formatSec(remSec)}`;
          if (remSec <= 0) {
            clearInterval(pairingTimerInterval);
            $('#pairing-code-box').textContent = 'EXPIRED';
          }
        }, 1000);
      }
    } catch (e) {
      console.warn('Pairing generation error:', e);
    }
  }

  $('#pair-modal-close-btn').onclick = () => {
    clearInterval(pairingTimerInterval);
    $('#pairing-modal').classList.add('hidden');
  };
  $('#quick-pair-btn').onclick = openPairingModal;
  $('#add-cam-btn').onclick = openPairingModal;
  $('#generate-new-code-btn').onclick = openPairingModal;

  $$('.chip').forEach(chip => {
    chip.onclick = () => {
      $('#pair-cam-name').value = chip.dataset.name;
      openPairingModal();
    };
  });

  // Claim pairing code on new camera device
  $('#claim-pairing-btn').onclick = () => {
    $('#claim-modal').classList.remove('hidden');
  };
  $('#claim-modal-close-btn').onclick = () => {
    $('#claim-modal').classList.add('hidden');
  };

  $('#claim-submit-btn').onclick = async () => {
    const code = $('#claim-code-input').value.trim();
    const name = $('#claim-name-input').value.trim() || 'Front Door';
    const err = $('#claim-err');
    err.textContent = '';

    if (!code || code.length !== 6) {
      err.textContent = 'Please enter a valid 6-digit code.';
      return;
    }

    try {
      const res = await fetch('/api/pairing/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceName: name, deviceId: AppState.deviceId })
      });
      const data = await res.json();
      if (!data.ok) {
        err.textContent = data.error || 'Pairing failed';
        return;
      }

      // Successfully linked!
      AppState.token = data.token;
      AppState.user = data.user;
      localStorage.setItem('sentinel_token', data.token);
      localStorage.setItem('sentinel_user', JSON.stringify(data.user));

      $('#claim-modal').classList.add('hidden');
      enterApp();
      switchView('broadcast');
      $('#b-name-input').value = name;
      startBroadcasting();
      showToast(`Camera paired and broadcasting as "${name}"`);
    } catch (e) {
      err.textContent = 'Network error: ' + e.message;
    }
  };

  async function promptRenameDevice(id, oldName) {
    const newName = prompt('Enter a new name for this camera:', oldName);
    if (!newName || !newName.trim() || newName.trim() === oldName) return;

    try {
      const res = await fetch(`/api/devices/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AppState.token}`
        },
        body: JSON.stringify({ name: newName.trim() })
      });
      const data = await res.json();
      if (data.ok) {
        showToast('Camera renamed');
        if (AppState.socket && AppState.socket.connected) {
          AppState.socket.emit('device:list');
        }
      }
    } catch (e) {
      showToast('Error renaming camera: ' + e.message);
    }
  }

  async function removeDevice(id) {
    if (!confirm('Are you sure you want to remove this camera?')) return;
    try {
      await fetch(`/api/devices/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${AppState.token}` }
      });
      showToast('Camera removed');
      if (AppState.socket && AppState.socket.connected) {
        AppState.socket.emit('device:list');
      }
    } catch (e) {
      showToast('Error removing camera');
    }
  }

  function viewCamera(id) {
    switchView('live');
    $('#viewer-cam-select').value = id;
    connectSelectedFeed();
  }

  /* ========================================================
     MOTION DETECTION & SECURITY LOGBOOK
  ======================================================== */
  function analyseMotion() {
    const activeVid = (vid.videoWidth && AppState.cam) ? vid : (bVid.videoWidth && AppState.isBroadcasting) ? bVid : null;
    if (!activeVid) return;

    sctx.drawImage(activeVid, 0, 0, W, H);
    const d = sctx.getImageData(0, 0, W, H).data;
    const g = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      g[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11);
    }

    if (!prev) {
      prev = g;
      return;
    }

    const th = 50 - AppState.sens * 0.35;
    const cols = new Uint16Array(W), rows = new Uint16Array(H);
    let n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (Math.abs(g[y * W + x] - prev[y * W + x]) > th) {
          cols[x]++;
          rows[y]++;
          n++;
        }
      }
    }
    prev = g;

    const rng = (a, m) => {
      let s = -1, e = -1;
      a.forEach((v, i) => { if (v >= m) { if (s < 0) s = i; e = i; } });
      return [s, e];
    };

    const [x0, x1] = rng(cols, 2), [y0, y1] = rng(rows, 2);
    let hit = false, box = null;
    if (x0 >= 0 && y0 >= 0) {
      const bw = (x1 - x0 + 1) / W, bh = (y1 - y0 + 1) / H;
      const minArea = 0.09 - AppState.sens * 0.0008;
      box = { x: x0 / W, y: y0 / H, w: bw, h: bh };
      const big = n / (W * H) >= minArea * 0.5 && bw * bh >= minArea;
      const person = !AppState.people || (bh / (bw * W / H) >= 0.9 && bh >= 0.35);
      hit = big && person;
      box.person = person;
    }

    if (hit) {
      AppState.motionBox = box;
      AppState.motionBoxT = performance.now();
      AppState.hits++;
    } else {
      AppState.hits = Math.max(0, AppState.hits - 1);
    }

    if (AppState.hits >= 3 && performance.now() - AppState.lastTrig > AppState.cool * 1000) {
      AppState.hits = 0;
      triggerSecurityEvent();
    }
  }

  function triggerSecurityEvent() {
    const hr = new Date().getHours(), fl = [];
    if (hr >= 22 || hr < 6) fl.push('After hours');
    if (AppState.mode === 'away') fl.push('While away');
    if (AppState.log.some(e => !e.known && Date.now() - e.t < 36e5)) fl.push('Repeat visit');

    const ev = {
      id: 'ev_' + Date.now().toString(36),
      t: Date.now(),
      name: 'Unknown visitor',
      cameraName: $('#camname').textContent || 'Front Door',
      known: false,
      flags: fl,
      img: takeSnapshot()
    };

    AppState.log.push(ev);
    AppState.detUntil = performance.now() + 8000;
    AppState.lastTrig = performance.now();

    renderLog(ev);
    setBadge('detected', 'Visitor Detected');

    // Notify backend and viewers over Socket.IO
    if (AppState.socket && AppState.socket.connected) {
      AppState.socket.emit('alert:motion', ev);
    }

    if (!AppState.silent) {
      showVisitorAlert(ev);
      if (AppState.sound) playChime();
      if (AppState.push && 'Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification('Sentinel Visitor Alert', {
            body: `Visitor detected at ${tm(ev.t)}`,
            icon: ev.img
          });
        } catch (e) {}
      }
    }

    // Auto-record on motion if enabled
    if (AppState.autorec && AppState.recorder && !AppState.recorder.isRecording) {
      const activeStream = (AppState.activeStream && AppState.activeStream.active)
        ? AppState.activeStream
        : (vid.srcObject && vid.srcObject.active)
          ? vid.srcObject
          : null;

      if (activeStream) {
        try {
          AppState.recorder.start(activeStream, {
            cameraId: AppState.currentCamId,
            cameraName: ev.cameraName,
            title: `Motion Alert (${tm(ev.t)})`,
            motionEventId: ev.id
          });
          // Auto-stop after 10 seconds
          setTimeout(() => {
            if (AppState.recorder.isRecording) {
              AppState.recorder.stop(vid).then(() => {
                loadRecordings();
                updateDashboard();
              });
            }
          }, 10000);
        } catch (e) {
          console.warn('Auto-record failed:', e);
        }
      }
    }

    updateDashboard();
  }

  function showRemoteMotionAlert(ev) {
    AppState.log.push(ev);
    renderLog(ev);
    setBadge('detected', `Motion on ${ev.cameraName || 'Camera'}`);
    if (!AppState.silent) {
      showVisitorAlert(ev);
      if (AppState.sound) playChime();
    }
  }

  function showVisitorAlert(ev) {
    $('#alert').innerHTML = `
      <div class="card" role="alertdialog" aria-label="Visitor detected">
        <img alt="Visitor Snapshot" src="${ev.img}">
        <div>
          <h3>Someone is at the door</h3>
          <p>Detected on <b>${ev.cameraName || 'Security Camera'}</b> at ${tm(ev.t)}${(ev.flags || []).length ? ' (' + ev.flags.join(', ').toLowerCase() + ')' : ''}${AppState.mode === 'away' ? '. You are marked as away.' : ''}</p>
          <div class="acts">
            <button class="btn primary" id="a-ack">Acknowledge</button>
            <button class="btn lamp" id="a-snd">Sound Alert</button>
            <button class="btn" id="a-safe">Mark as safe</button>
          </div>
          <div class="name hidden" id="nm">
            <input id="nmi" placeholder="Who is this? (e.g. Sam, neighbour)">
            <button class="btn primary" id="nms">Save</button>
          </div>
        </div>
      </div>
    `;

    $('#a-ack').onclick = () => $('#alert').innerHTML = '';
    $('#a-snd').onclick = playChime;
    $('#a-safe').onclick = () => {
      $('#nm').classList.remove('hidden');
      $('#nmi').focus();
    };
    const saveName = () => {
      ev.name = $('#nmi').value.trim() || 'Known visitor';
      ev.known = true;
      renderLog();
      $('#alert').innerHTML = '';
    };
    $('#nms').onclick = saveName;
    $('#nmi').onkeydown = e => { if (e.key === 'Enter') saveName(); };
  }

  function renderLog(newEv) {
    let lastDay = '', html = '';
    AppState.log.sort((a, b) => b.t - a.t).forEach(e => {
      const d = dayLabel(e.t);
      if (d !== lastDay) {
        html += `<div class="day">${d}</div>`;
        lastDay = d;
      }
      html += `
        <div class="ev${e === newEv ? ' new' : ''}">
          <img alt="${e.name}" src="${e.img}">
          <div>
            <b>${e.name}</b>
            <span>${tm(e.t)} • ${e.cameraName || 'Front Door'}</span>
            ${e.known ? '<span class="tag known">Known</span>' : ''}
            ${(e.flags || []).map(f => `<span class="tag warn">${f}</span>`).join('')}
          </div>
        </div>
      `;
    });
    $('#log').innerHTML = html || '<p class="empty">No visitor events recorded yet.</p>';

    // Intruder and suspicious activity views
    const un = AppState.log.filter(e => !e.known);
    const su = AppState.log.filter(e => (e.flags || []).length);
    $('#n-intr').textContent = un.length;
    $('#n-sus').textContent = su.length;

    $('#intr').innerHTML = un.map((e, idx) => `
      <article class="tile">
        <img alt="Unknown visitor" src="${e.img}">
        <div>
          <b>${dayLabel(e.t)}, ${tm(e.t)}</b>
          <span>${(e.flags || []).map(f => `<span class="tag warn">${f}</span>`).join('')}</span>
          <button class="btn sm" onclick="SentinelApp.markKnown(${idx})">Mark as known</button>
        </div>
      </article>
    `).join('') || '<p class="empty">No unknown visitors right now.</p>';

    const WHY = {
      'After hours': 'Someone came by between 10 PM and 6 AM.',
      'Repeat visit': 'An unknown visitor returned within the hour.',
      'While away': 'Detected while the system was armed.',
      'Lingering': 'Stayed in camera view for extended time.'
    };
    $('#susl').innerHTML = su.map(e => `
      <article class="srow">
        <img alt="Snapshot" src="${e.img}">
        <div>
          <b>${e.name}</b>
          <span>${dayLabel(e.t)}, ${tm(e.t)} • ${e.cameraName || 'Front Door'}</span>
          <div>${(e.flags || []).map(f => `<span class="tag warn">${f}</span>`).join('')}</div>
          <p>${e.flags.map(f => WHY[f] || '').join(' ')}</p>
        </div>
      </article>
    `).join('') || '<p class="empty">Nothing suspicious so far.</p>';
  }

  function markKnown(idx) {
    const un = AppState.log.filter(e => !e.known);
    if (un[idx]) {
      un[idx].known = true;
      un[idx].name = 'Known visitor';
      renderLog();
      showToast('Marked as known visitor');
    }
  }

  $('#clear-log-btn').onclick = () => {
    AppState.log = [];
    renderLog();
    showToast('Logbook cleared');
  };

  function drawBoundingBoxes() {
    octx.clearRect(0, 0, ov.width, ov.height);
    const active = AppState.motionBox && performance.now() - AppState.motionBoxT < 700;
    if (active) {
      const w = ov.width, h = ov.height, b = AppState.motionBox;
      const x = b.x * w, y = b.y * h, bw = b.w * w, bh = b.h * h;
      const L = Math.min(bw, bh) * 0.18, k = devicePixelRatio;

      octx.strokeStyle = '#f2b43a';
      octx.lineWidth = 3 * k;
      octx.beginPath();
      [[x, y, 1, 1], [x + bw, y, -1, 1], [x, y + bh, 1, -1], [x + bw, y + bh, -1, -1]].forEach(([cx, cy, dx, dy]) => {
        octx.moveTo(cx + dx * L, cy);
        octx.lineTo(cx, cy);
        octx.lineTo(cx, cy + dy * L);
      });
      octx.stroke();

      octx.lineWidth = 1 * k;
      octx.globalAlpha = 0.4;
      octx.strokeRect(x, y, bw, bh);
      octx.globalAlpha = 1;

      const t = b.person ? 'Person' : 'Movement';
      octx.font = `600 ${12 * k}px "Schibsted Grotesk", sans-serif`;
      const tw = octx.measureText(t).width + 14 * k;
      octx.fillStyle = '#f2b43a';
      octx.fillRect(x, Math.max(0, y - 22 * k), tw, 20 * k);
      octx.fillStyle = '#1a1200';
      octx.fillText(t, x + 7 * k, Math.max(0, y - 22 * k) + 14 * k);
    }
    requestAnimationFrame(drawBoundingBoxes);
  }

  // Simulated visitor button
  $('#sim').onclick = () => {
    AppState.motionBox = { x: 0.3, y: 0.25, w: 0.2, h: 0.6, person: true };
    AppState.motionBoxT = performance.now();
    triggerSecurityEvent();
    showToast('Simulated visitor detected');
  };

  // Demo seed scene generator (fallback canvas)
  function scene(c, seed) {
    const w = c.width, h = c.height, x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#1a2a33');
    g.addColorStop(1, '#0b1519');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#22363f';
    x.fillRect(w * .58, h * .12, w * .3, h * .88);
    x.fillStyle = '#e9b84a';
    x.globalAlpha = .25;
    x.beginPath();
    x.arc(w * .5, h * .1, w * .18, 0, 7);
    x.fill();
    x.globalAlpha = 1;
    x.fillStyle = '#0b1519';
    x.fillRect(0, h * .86, w, h * .14);
    const px = w * (.25 + ((seed * 37) % 40) / 100), s = .8 + ((seed * 13) % 5) / 10;
    x.fillStyle = ['#3a4b55', '#4a3d3a', '#2f4a45', '#4a4a52'][seed % 4];
    x.beginPath();
    x.arc(px, h * .36, h * .07 * s, 0, 7);
    x.fill();
    x.beginPath();
    x.roundRect(px - h * .1 * s, h * .43, h * .2 * s, h * .45, h * .05);
    x.fill();
  }

  function loadEvents() {
    const now = Date.now(), D = 864e5;
    const thumb = seed => {
      const c = document.createElement('canvas');
      c.width = 240; c.height = 150;
      scene(c, seed);
      return c.toDataURL('image/jpeg', 0.6);
    };

    AppState.log = [
      { t: now - 35 * 6e4, name: 'Maya', cameraName: 'Front Door', known: true, img: thumb(3) },
      { t: now - 5 * 36e5, name: 'Unknown visitor', cameraName: 'Front Door', known: false, img: thumb(8), flags: ['While away'] },
      { t: now - 1 * D - 36e5, name: 'Delivery driver', cameraName: 'Front Door', known: true, img: thumb(5) },
      { t: now - 2 * D - 2 * 36e5, name: 'Unknown visitor', cameraName: 'Backyard', known: false, img: thumb(17), flags: ['After hours'] }
    ];
    renderLog();
  }

  // Periodic intervals
  setInterval(analyseMotion, 250);
  setInterval(() => {
    const timeStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const clock = $('#clock');
    if (clock) clock.textContent = timeStr;
    const bClock = $('#b-clock');
    if (bClock) bClock.textContent = timeStr;
  }, 1000);

  // Settings inputs
  $('#s-sound').onchange = e => AppState.sound = e.target.checked;
  $('#s-silent').onchange = e => AppState.silent = e.target.checked;
  $('#s-people').onchange = e => AppState.people = e.target.checked;
  $('#s-autorec').onchange = e => AppState.autorec = e.target.checked;
  $('#s-sens').oninput = e => {
    AppState.sens = +e.target.value;
    $('#sensTxt').textContent = AppState.sens < 34 ? 'Low sensitivity' : AppState.sens < 67 ? 'Balanced sensitivity' : 'High sensitivity';
  };
  $('#s-cool').oninput = e => {
    AppState.cool = +e.target.value;
    $('#coolTxt').textContent = `After an alert, ignore new movement for ${AppState.cool} seconds.`;
  };
  $('#s-push').onchange = async e => {
    if (!e.target.checked) { AppState.push = false; return; }
    if (!('Notification' in window)) { e.target.checked = false; return; }
    const p = await Notification.requestPermission();
    AppState.push = p === 'granted';
    e.target.checked = AppState.push;
  };
  $('#test').onclick = () => {
    triggerSecurityEvent();
    showToast('Sent test alert');
  };

  /* ========================================================
     SIGN IN & REGISTRATION FORMS
  ======================================================== */
  let contactValue = '', generatedOtp = '';
  let signinKind = 'email';

  $$('#kind button').forEach(b => b.onclick = () => {
    signinKind = b.dataset.k;
    $$('#kind button').forEach(x => x.setAttribute('aria-pressed', x === b));
    const input = $('#lg-id');
    input.type = signinKind === 'email' ? 'email' : 'tel';
    input.placeholder = signinKind === 'email' ? 'you@example.com' : '+1 555-0199';
  });

  $('#lg1').onsubmit = async (e) => {
    e.preventDefault();
    const val = $('#lg-id').value.trim();
    if (!val) {
      $('#lg-err').textContent = 'Please enter your email or phone number.';
      return;
    }
    contactValue = val;
    $('#lg-err').textContent = '';

    try {
      const res = await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact: val })
      });
      const data = await res.json();
      if (!data.ok) {
        $('#lg-err').textContent = data.error || 'Failed to send verification code.';
        return;
      }

      generatedOtp = data.demoCode || '';
      $('#lg-hint').textContent = data.demoCode
        ? `Demo Mode: Verification code is ${data.demoCode}`
        : `We sent a 6-digit code to ${val}`;

      $('#lg1').classList.add('hidden');
      $('#lg2').classList.remove('hidden');
      $('#lg-code').focus();
    } catch (err) {
      $('#lg-err').textContent = 'Network error: ' + err.message;
    }
  };

  $('#lg2').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#lg-code').value.trim();
    if (!code) {
      $('#lg-err2').textContent = 'Please enter the 6-digit verification code.';
      return;
    }

    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact: contactValue, code })
      });
      const data = await res.json();
      if (!data.ok) {
        $('#lg-err2').textContent = data.error || 'Invalid code.';
        return;
      }

      AppState.token = data.token;
      AppState.user = data.user;
      localStorage.setItem('sentinel_token', data.token);
      localStorage.setItem('sentinel_user', JSON.stringify(data.user));

      enterApp();
    } catch (err) {
      $('#lg-err2').textContent = 'Verification error: ' + err.message;
    }
  };

  $('#lg-back').onclick = () => {
    $('#lg2').classList.add('hidden');
    $('#lg1').classList.remove('hidden');
  };

  // Sign in page camera pairing shortcut
  $('#lg-pair-shortcut').onclick = () => {
    $('#lg1').classList.add('hidden');
    $('#lg-pair-form').classList.remove('hidden');
  };
  $('#lg-pair-back').onclick = () => {
    $('#lg-pair-form').classList.add('hidden');
    $('#lg1').classList.remove('hidden');
  };

  $('#lg-pair-form').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#lg-pair-code').value.trim();
    const name = $('#lg-pair-name').value.trim() || 'Front Door';
    const err = $('#lg-pair-err');
    err.textContent = '';

    if (!code || code.length !== 6) {
      err.textContent = 'Enter a valid 6-digit code.';
      return;
    }

    try {
      const res = await fetch('/api/pairing/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceName: name, deviceId: AppState.deviceId })
      });
      const data = await res.json();
      if (!data.ok) {
        err.textContent = data.error || 'Pairing failed';
        return;
      }

      AppState.token = data.token;
      AppState.user = data.user;
      localStorage.setItem('sentinel_token', data.token);
      localStorage.setItem('sentinel_user', JSON.stringify(data.user));

      enterApp();
      switchView('broadcast');
      $('#b-name-input').value = name;
      startBroadcasting();
    } catch (err) {
      err.textContent = 'Pairing error: ' + err.message;
    }
  };

  // Initialize
  populateCameraDevices();
  initAuth();
  drawBoundingBoxes();

  // Export App API for inline onclick handlers
  global.SentinelApp = {
    AppState,
    playRecording,
    downloadRecording,
    deleteRecording,
    viewCamera,
    promptRenameDevice,
    removeDevice,
    markKnown,
    switchView
  };

})(window);
