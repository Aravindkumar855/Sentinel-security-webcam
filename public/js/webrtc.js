/**
 * Sentinel WebRTC Peer Connection & Streaming Manager
 */
(function(global) {
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  async function fetchIceServers() {
    try {
      const res = await fetch('/api/ice-servers');
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.iceServers)) {
        iceServers = data.iceServers;
      }
    } catch (e) {
      console.warn('Using default STUN server:', e);
    }
  }

  class WebRTCManager {
    constructor(socket, options = {}) {
      this.socket = socket;
      this.options = options;
      this.localStream = null;
      // Camera mode: Map of viewerDeviceId -> RTCPeerConnection
      this.viewerConnections = new Map();
      // Viewer mode: single active peer connection to camera
      this.cameraConnection = null;
      this.activeCameraId = null;

      this.setupSocketListeners();
    }

    setLocalStream(stream) {
      this.localStream = stream;
      // If any existing viewer connections need track updates
      this.viewerConnections.forEach((pc) => {
        const senders = pc.getSenders();
        stream.getTracks().forEach(track => {
          const sender = senders.find(s => s.track && s.track.kind === track.kind);
          if (sender) {
            sender.replaceTrack(track);
          } else {
            pc.addTrack(track, stream);
          }
        });
      });
    }

    setupSocketListeners() {
      if (!this.socket) return;

      // Handle incoming WebRTC Offer
      this.socket.on('webrtc:offer', async (data) => {
        const { fromDeviceId, offer } = data || {};
        if (!offer || !fromDeviceId) return;

        // Camera received offer from a viewer
        if (this.options.role === 'camera') {
          await this.handleIncomingViewerOffer(fromDeviceId, offer);
        }
      });

      // Handle incoming WebRTC Answer
      this.socket.on('webrtc:answer', async (data) => {
        const { fromDeviceId, answer } = data || {};
        if (!answer) return;

        // Viewer received answer from camera
        if (this.cameraConnection && this.activeCameraId === fromDeviceId) {
          try {
            await this.cameraConnection.setRemoteDescription(new RTCSessionDescription(answer));
          } catch (e) {
            console.error('Error setting remote description from answer:', e);
          }
        }
      });

      // Handle incoming ICE Candidate
      this.socket.on('webrtc:ice-candidate', async (data) => {
        const { fromDeviceId, candidate } = data || {};
        if (!candidate) return;

        try {
          if (this.options.role === 'camera') {
            const pc = this.viewerConnections.get(fromDeviceId);
            if (pc && pc.remoteDescription) {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
          } else if (this.options.role === 'viewer') {
            if (this.cameraConnection && this.cameraConnection.remoteDescription) {
              await this.cameraConnection.addIceCandidate(new RTCIceCandidate(candidate));
            }
          }
        } catch (e) {
          console.warn('Error adding ICE candidate:', e);
        }
      });

      // Handle Hangup
      this.socket.on('webrtc:hangup', (data) => {
        const { fromDeviceId } = data || {};
        if (this.options.role === 'camera' && fromDeviceId) {
          this.closeViewerConnection(fromDeviceId);
        } else if (this.options.role === 'viewer' && this.activeCameraId === fromDeviceId) {
          this.disconnectFromCamera();
          if (this.options.onCameraDisconnected) {
            this.options.onCameraDisconnected(fromDeviceId);
          }
        }
      });

      // Handle Camera Offline notification
      this.socket.on('device:offline', (data) => {
        const { deviceId } = data || {};
        if (this.activeCameraId === deviceId) {
          this.disconnectFromCamera();
          if (this.options.onCameraOffline) {
            this.options.onCameraOffline(deviceId);
          }
        }
      });
    }

    // ================= CAMERA MODE METHODS =================
    async handleIncomingViewerOffer(viewerDeviceId, offer) {
      this.closeViewerConnection(viewerDeviceId);

      const pc = new RTCPeerConnection({ iceServers });
      this.viewerConnections.set(viewerDeviceId, pc);

      pc.onicecandidate = (event) => {
        if (event.candidate && this.socket) {
          this.socket.emit('webrtc:ice-candidate', {
            targetDeviceId: viewerDeviceId,
            candidate: event.candidate
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          this.closeViewerConnection(viewerDeviceId);
        }
        if (this.options.onViewerCountChange) {
          this.options.onViewerCountChange(this.getConnectedViewerCount());
        }
      };

      // Add local media tracks if camera is active
      if (this.localStream) {
        this.localStream.getTracks().forEach(track => {
          pc.addTrack(track, this.localStream);
        });
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.socket.emit('webrtc:answer', {
          targetDeviceId: viewerDeviceId,
          answer
        });

        if (this.options.onViewerCountChange) {
          this.options.onViewerCountChange(this.getConnectedViewerCount());
        }
      } catch (err) {
        console.error('Failed to negotiate viewer connection:', err);
        this.closeViewerConnection(viewerDeviceId);
      }
    }

    closeViewerConnection(viewerDeviceId) {
      const pc = this.viewerConnections.get(viewerDeviceId);
      if (pc) {
        pc.close();
        this.viewerConnections.delete(viewerDeviceId);
      }
      if (this.options.onViewerCountChange) {
        this.options.onViewerCountChange(this.getConnectedViewerCount());
      }
    }

    getConnectedViewerCount() {
      let count = 0;
      this.viewerConnections.forEach(pc => {
        if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') {
          count++;
        }
      });
      return count;
    }

    closeAllViewerConnections() {
      this.viewerConnections.forEach((pc, id) => {
        if (this.socket) {
          this.socket.emit('webrtc:hangup', { targetDeviceId: id });
        }
        pc.close();
      });
      this.viewerConnections.clear();
      if (this.options.onViewerCountChange) {
        this.options.onViewerCountChange(0);
      }
    }

    // ================= VIEWER MODE METHODS =================
    async connectToCamera(cameraDeviceId) {
      this.disconnectFromCamera();
      this.activeCameraId = cameraDeviceId;

      if (this.options.onConnectionState) {
        this.options.onConnectionState('connecting');
      }

      const pc = new RTCPeerConnection({ iceServers });
      this.cameraConnection = pc;

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          if (this.options.onRemoteStream) {
            this.options.onRemoteStream(event.streams[0]);
          }
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && this.socket) {
          this.socket.emit('webrtc:ice-candidate', {
            targetDeviceId: cameraDeviceId,
            candidate: event.candidate
          });
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (this.options.onConnectionState) {
          this.options.onConnectionState(state);
        }
        if (state === 'failed') {
          console.warn('WebRTC connection failed. Ready to reconnect.');
        }
      };

      try {
        const offer = await pc.createOffer({
          offerToReceiveVideo: true,
          offerToReceiveAudio: true
        });
        await pc.setLocalDescription(offer);

        this.socket.emit('webrtc:offer', {
          targetDeviceId: cameraDeviceId,
          offer
        });
      } catch (err) {
        console.error('Failed to create WebRTC offer:', err);
        if (this.options.onConnectionState) {
          this.options.onConnectionState('failed');
        }
      }
    }

    disconnectFromCamera() {
      if (this.cameraConnection) {
        if (this.socket && this.activeCameraId) {
          this.socket.emit('webrtc:hangup', { targetDeviceId: this.activeCameraId });
        }
        this.cameraConnection.close();
        this.cameraConnection = null;
      }
      this.activeCameraId = null;
      if (this.options.onConnectionState) {
        this.options.onConnectionState('disconnected');
      }
    }
  }

  global.SentinelWebRTC = {
    fetchIceServers,
    WebRTCManager
  };
})(window);
