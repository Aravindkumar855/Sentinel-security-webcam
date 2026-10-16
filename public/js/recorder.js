/**
 * Sentinel Recording Engine
 * Uses MediaRecorder with fallback codec detection, IndexedDB persistence, and server sync.
 */
(function(global) {
  function getSupportedMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4'
    ];
    for (const candidate of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }
    return '';
  }

  function captureVideoThumbnail(videoElement) {
    if (!videoElement || !videoElement.videoWidth) {
      // Fallback empty thumbnail
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0a1013';
      ctx.fillRect(0, 0, 320, 180);
      return canvas.toDataURL('image/jpeg', 0.6);
    }

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0, 320, 180);

    // Add timestamp watermark
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 155, 320, 25);
    ctx.fillStyle = '#e6edf0';
    ctx.font = '11px sans-serif';
    ctx.fillText(`Sentinel • ${new Date().toLocaleTimeString()}`, 10, 172);

    return canvas.toDataURL('image/jpeg', 0.65);
  }

  class VideoRecorder {
    constructor(options = {}) {
      this.options = options;
      this.mediaRecorder = null;
      this.recordedChunks = [];
      this.isRecording = false;
      this.startTime = 0;
      this.timerInterval = null;
      this.activeStream = null;
    }

    start(stream, metadata = {}) {
      if (this.isRecording) {
        throw new Error('Recording is already in progress');
      }

      if (!stream || !stream.active || stream.getVideoTracks().length === 0) {
        throw new Error('No active video stream available to record');
      }

      const mimeType = getSupportedMimeType();
      if (!mimeType) {
        throw new Error('MediaRecorder is not supported or no supported video codecs found');
      }

      this.activeStream = stream;
      this.recordedChunks = [];
      this.startTime = Date.now();
      this.metadata = metadata;

      try {
        this.mediaRecorder = new MediaRecorder(stream, { mimeType });
      } catch (e) {
        // Fallback without mimeType option
        this.mediaRecorder = new MediaRecorder(stream);
      }

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onerror = (err) => {
        console.error('MediaRecorder error:', err);
        this.stop();
        if (this.options.onError) {
          this.options.onError(err);
        }
      };

      this.mediaRecorder.start(1000); // 1-second chunks
      this.isRecording = true;

      // Start elapsed timer
      if (this.options.onTick) {
        this.options.onTick(0);
        this.timerInterval = setInterval(() => {
          const elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
          this.options.onTick(elapsedSec);
        }, 1000);
      }

      if (this.options.onStateChange) {
        this.options.onStateChange(true);
      }
    }

    async stop(videoElementForThumbnail) {
      if (!this.isRecording || !this.mediaRecorder) {
        return null;
      }

      clearInterval(this.timerInterval);
      this.timerInterval = null;

      const durationSec = Math.max(1, Math.round((Date.now() - this.startTime) / 1000));
      const mimeType = this.mediaRecorder.mimeType || 'video/webm';
      const thumbnail = captureVideoThumbnail(videoElementForThumbnail);

      return new Promise((resolve, reject) => {
        this.mediaRecorder.onstop = async () => {
          this.isRecording = false;
          if (this.options.onStateChange) {
            this.options.onStateChange(false);
          }

          if (this.recordedChunks.length === 0) {
            reject(new Error('No video data recorded'));
            return;
          }

          const blob = new Blob(this.recordedChunks, { type: mimeType });
          const id = 'rec_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
          const recordingItem = {
            id,
            cameraId: this.metadata.cameraId || null,
            cameraName: this.metadata.cameraName || 'Security Camera',
            title: this.metadata.title || `Clip ${new Date().toLocaleTimeString()}`,
            startAt: this.startTime,
            endAt: Date.now(),
            duration: durationSec,
            size: blob.size,
            mimeType,
            blob,
            thumbnail,
            motionEventId: this.metadata.motionEventId || null,
            createdAt: Date.now()
          };

          // 1. Save to local IndexedDB for immediate offline access
          try {
            await SentinelDB.saveRecording(recordingItem);
          } catch (e) {
            console.warn('Failed to save recording to IndexedDB:', e);
          }

          // 2. Synchronize to backend server if user has an auth token
          this.syncToServer(recordingItem, blob).catch(e => {
            console.warn('Background server recording upload skipped or failed:', e);
          });

          resolve(recordingItem);
        };

        try {
          this.mediaRecorder.stop();
        } catch (e) {
          reject(e);
        }
      });
    }

    async syncToServer(item, blob) {
      const token = localStorage.getItem('sentinel_token');
      if (!token) return;

      const formData = new FormData();
      const ext = item.mimeType.includes('mp4') ? '.mp4' : '.webm';
      formData.append('video', blob, `recording_${item.id}${ext}`);
      formData.append('cameraId', item.cameraId || '');
      formData.append('cameraName', item.cameraName || 'Security Camera');
      formData.append('title', item.title || 'Security Clip');
      formData.append('duration', item.duration);
      formData.append('thumbnailData', item.thumbnail || '');
      if (item.motionEventId) {
        formData.append('motionEventId', item.motionEventId);
      }

      await fetch('/api/recordings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });
    }
  }

  global.SentinelRecorder = {
    VideoRecorder,
    getSupportedMimeType,
    captureVideoThumbnail
  };
})(window);
