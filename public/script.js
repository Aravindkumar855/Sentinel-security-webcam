/**
 * Sentinel Security Webcam — Compatibility Layer
 * Preserves original symbols (API_URL, startCam, snap, trigger, analyse, renderLog, deliver, enter)
 * and bridges with the enhanced multi-device architecture.
 */

const API_URL = ''; // Backend base URL (empty for same-origin)

// Forward declarations referencing SentinelApp
function snap() {
  const vid = document.querySelector('#vid');
  const bVid = document.querySelector('#b-vid');
  const activeVid = (vid && vid.videoWidth) ? vid : (bVid && bVid.videoWidth) ? bVid : null;

  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const x = c.getContext('2d');
  if (activeVid) {
    x.drawImage(activeVid, 0, 0, 640, 360);
  } else {
    // Generate scene fallback
    const g = x.createLinearGradient(0, 0, 0, 360);
    g.addColorStop(0, '#1a2a33');
    g.addColorStop(1, '#0b1519');
    x.fillStyle = g;
    x.fillRect(0, 0, 640, 360);
  }
  x.fillStyle = 'rgba(0,0,0,.55)';
  x.fillRect(0, 332, 640, 28);
  x.fillStyle = '#fff';
  x.font = '13px sans-serif';
  x.fillText('Front door  ' + new Date().toLocaleString(), 12, 351);
  return c.toDataURL('image/jpeg', 0.7);
}

function startCam() {
  if (window.SentinelApp) {
    return window.SentinelApp.switchView('live');
  }
}

function trigger() {
  const sim = document.querySelector('#sim');
  if (sim) sim.click();
}

function analyse() {
  // Motion analysis loop running in SentinelApp
}

function renderLog(newId) {
  // Rendered by SentinelApp
}

async function deliver(ev) {
  if (!ev) return;
  try {
    await fetch('/api/alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'email',
        to: (window.SentinelApp && window.SentinelApp.AppState.user) ? window.SentinelApp.AppState.user.identifier : 'alerts@sentinel.local',
        message: `Sentinel Visitor Alert at ${new Date(ev.t).toLocaleTimeString()}`
      })
    });
  } catch (e) {
    console.warn('Delivery test:', e);
  }
}

function enter() {
  if (window.SentinelApp && window.SentinelApp.AppState) {
    window.SentinelApp.switchView('dash');
  }
}

console.log('Sentinel Security Webcam compatibility layer initialized.');
