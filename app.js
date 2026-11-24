/**
 * ============================================================================
 * WEBCAM P2P PERSISTENTE PARA OBS STUDIO (Versión 2.1 - Fix URL/Pass & Camera)
 * Arquitectura: Single-File Vanilla JS + PeerJS + MediaStreamTrack Constraints
 * Archivo: app.js
 * ============================================================================
 */

const PEER_PREFIX = 'obs-webcam-p2p-';
const STORAGE_KEY = 'obs_webcam_p2p_state_v2';
const PROFILES_KEY = 'obs_webcam_p2p_profiles_v2';

// Detectar modo de operación según parámetros de URL (?view&id=SALA&password=CLAVE)
const urlParams = new URLSearchParams(window.location.search);
const isObsView = urlParams.has('view');
const obsRoomId = urlParams.get('id');
const obsUrlPassword = urlParams.get('password') || '';

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function generateRoomId(length = 7) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Arranque seguro tanto con o sin defer / DOMContentLoaded ya disparado
function onReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

if (isObsView) {
  document.body.classList.add('obs-mode');
  onReady(() => initObsReceiver(obsRoomId, obsUrlPassword));
} else {
  onReady(initMobileEmitter);
}

/* ==========================================================================
   RAMA A: MODO RECEPTOR (OBS STUDIO - AUTO-HEALING & CLAVE OPCIONAL)
   ========================================================================== */
function initObsReceiver(roomId, initialPassword = '') {
  const videoEl = document.getElementById('obs-video');
  const authModal = document.getElementById('obs-auth-modal');
  const passInput = document.getElementById('obs-pass-input');
  const btnAuth = document.getElementById('btn-obs-auth');
  const authError = document.getElementById('obs-auth-error');

  if (!roomId) {
    console.error('[OBS Mode] Falta el parámetro ?id=SALA en la URL.');
    return;
  }

  const targetPeerId = PEER_PREFIX + roomId.trim();
  let peer = null;
  let currentCall = null;
  let reconnectTimer = null;
  let isConnected = false;
  let roomPassword = initialPassword.trim();
  let authRequired = false;
  let failedAttempts = 0;

  if (passInput && roomPassword) {
    passInput.value = roomPassword;
  }

  function showAuthModal(showError = false) {
    authRequired = true;
    if (authModal) authModal.style.display = 'flex';
    if (authError) authError.style.display = showError ? 'block' : 'none';
  }

  if (btnAuth) {
    btnAuth.addEventListener('click', () => {
      roomPassword = passInput ? passInput.value.trim() : '';
      if (authError) authError.style.display = 'none';
      clearTimeout(reconnectTimer);
      attemptCall();
    });
  }

  function createDummyStream() {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext('2d');
    ctx.fillRect(0, 0, 1, 1);
    return canvas.captureStream(1);
  }

  const dummyStream = createDummyStream();

  function scheduleReconnect() {
    isConnected = false;
    videoEl.srcObject = null;
    clearTimeout(reconnectTimer);

    // Si se requiere contraseña y aún no se ha ingresado/corregido, pausar bucle ciego hasta que el usuario envíe la clave
    if (authRequired && failedAttempts >= 1) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      attemptCall();
    }, 2500);
  }

  function attemptCall() {
    if (isConnected) return;

    if (!peer || peer.destroyed) {
      peer = new Peer({
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        }
      });

      peer.on('open', () => {
        dialEmitter();
      });

      peer.on('error', (err) => {
        console.warn('[OBS Receiver] Reintentando conexión:', err.type);
        scheduleReconnect();
      });

      peer.on('disconnected', () => {
        if (!peer.destroyed) peer.reconnect();
        scheduleReconnect();
      });
    } else if (peer.open) {
      dialEmitter();
    }
  }

  function dialEmitter() {
    if (currentCall) {
      try { currentCall.close(); } catch (e) {}
    }

    console.log('[OBS Receiver] Llamando al emisor:', targetPeerId);
    const call = peer.call(targetPeerId, dummyStream, {
      metadata: { password: roomPassword }
    });
    currentCall = call;

    if (!call) {
      scheduleReconnect();
      return;
    }

    let gotStream = false;

    const handshakeTimeout = setTimeout(() => {
      if (!gotStream && !isConnected) {
        try { call.close(); } catch (e) {}
        // Si el emisor rechazó por clave (cerró antes de enviar stream), pedir contraseña si no venía en URL
        if (!initialPassword || failedAttempts > 0) {
          failedAttempts += 1;
          showAuthModal(Boolean(roomPassword));
        }
        scheduleReconnect();
      }
    }, 3500);

    call.on('stream', (remoteStream) => {
      gotStream = true;
      clearTimeout(handshakeTimeout);
      isConnected = true;
      authRequired = false;
      failedAttempts = 0;
      if (authModal) authModal.style.display = 'none';
      if (authError) authError.style.display = 'none';
      videoEl.srcObject = remoteStream;
      videoEl.play().catch(e => console.warn('Autoplay bloqueado:', e));

      const videoTrack = remoteStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => scheduleReconnect();
        videoTrack.onmute = () => {
          setTimeout(() => {
            if (videoTrack.muted) scheduleReconnect();
          }, 3000);
        };
      }
    });

    call.on('close', () => {
      clearTimeout(handshakeTimeout);
      if (!gotStream && !isConnected) {
        failedAttempts += 1;
        showAuthModal(Boolean(roomPassword));
      }
      scheduleReconnect();
    });

    call.on('error', () => {
      clearTimeout(handshakeTimeout);
      scheduleReconnect();
    });
  }

  attemptCall();
}

/* ==========================================================================
   RAMA B: MODO EMISOR (TELÉFONO MÓVIL - HARDAWARE, CLAVE Y MONITOR V2)
   ========================================================================== */
function initMobileEmitter() {
  const defaultState = {
    roomId: generateRoomId(),
    roomPassword: '',
    bitrateKbps: 3500,
    deviceId: '',
    width: 1280,
    height: 720,
    frameRate: 30,
    whiteBalanceMode: 'continuous',
    colorTemperature: 5000,
    exposureMode: 'continuous',
    exposureTime: 300,
    iso: 400,
    exposureCompensation: 0,
    focusMode: 'continuous',
    focusDistance: 0.25,
    zoom: 1
  };

  let state = loadState();
  let currentStream = null;
  let videoTrack = null;
  let capabilities = {};
  let peer = null;
  let activeCalls = new Set();
  let wakeLock = null;
  let statsInterval = null;

  const el = {
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    previewBox: document.getElementById('preview-box'),
    localVideo: document.getElementById('local-video'),
    resBadge: document.getElementById('res-badge'),
    wakeBadge: document.getElementById('wake-badge'),
    roomId: document.getElementById('room-id'),
    roomPassword: document.getElementById('room-password'),
    bitrateSelect: document.getElementById('bitrate-select'),
    btnCopyObs: document.getElementById('btn-copy-obs'),
    btnReconnectPeer: document.getElementById('btn-reconnect-peer'),
    cameraSelect: document.getElementById('camera-select'),
    resPreset: document.getElementById('res-preset'),
    fpsSelect: document.getElementById('fps-select'),
    btnReapply: document.getElementById('btn-reapply'),
    autoWb: document.getElementById('auto-whiteBalanceMode'),
    rangeCt: document.getElementById('range-colorTemperature'),
    valCt: document.getElementById('val-colorTemperature'),
    autoExp: document.getElementById('auto-exposureMode'),
    rangeExp: document.getElementById('range-exposureTime'),
    valExp: document.getElementById('val-exposureTime'),
    rangeIso: document.getElementById('range-iso'),
    valIso: document.getElementById('val-iso'),
    rangeEv: document.getElementById('range-exposureCompensation'),
    valEv: document.getElementById('val-exposureCompensation'),
    autoFocus: document.getElementById('auto-focusMode'),
    rangeFocus: document.getElementById('range-focusDistance'),
    valFocus: document.getElementById('val-focusDistance'),
    rangeZoom: document.getElementById('range-zoom'),
    valZoom: document.getElementById('val-zoom'),
    statsDetails: document.getElementById('stats-details'),
    statRes: document.getElementById('stat-res'),
    statFps: document.getElementById('stat-fps'),
    statBitrate: document.getElementById('stat-bitrate'),
    statRtt: document.getElementById('stat-rtt'),
    profileSelect: document.getElementById('profile-select'),
    btnSaveProfile: document.getElementById('btn-save-profile'),
    btnExportJson: document.getElementById('btn-export-json'),
    btnImportJson: document.getElementById('btn-import-json'),
    fileImport: document.getElementById('file-import'),
    btnResetAll: document.getElementById('btn-reset-all'),
    btnOled: document.getElementById('btn-oled'),
    oledSaver: document.getElementById('oled-saver')
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return saved ? { ...defaultState, ...saved } : { ...defaultState };
    } catch (e) {
      return { ...defaultState };
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('No se pudo guardar en localStorage:', e);
    }
  }

  function setStatus(type, text) {
    if (el.statusDot) el.statusDot.className = 'dot ' + type;
    if (el.statusText) el.statusText.textContent = text;
  }

  /* ------------------------------------------------------------------------
     1. WAKE LOCK Y VISIBILIDAD
     ------------------------------------------------------------------------ */
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      if (el.wakeBadge) el.wakeBadge.textContent = 'WakeLock: N/A';
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      if (el.wakeBadge) el.wakeBadge.textContent = 'WakeLock: Activo';
      wakeLock.addEventListener('release', () => {
        if (el.wakeBadge) el.wakeBadge.textContent = 'WakeLock: Pausado';
      });
    } catch (err) {
      if (el.wakeBadge) el.wakeBadge.textContent = 'WakeLock: Error';
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      if (videoTrack) applyAllHardwareConstraints();
    }
  });

  /* ------------------------------------------------------------------------
     2. CÁMARA Y CONSTRAINTS ESCALONADOS (CON MANEJO DE ERRORES MÓVILES)
     ------------------------------------------------------------------------ */
  async function populateCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      el.cameraSelect.innerHTML = '<option value="">API de cámara no disponible</option>';
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      el.cameraSelect.innerHTML = '';

      if (videoInputs.length === 0) {
        el.cameraSelect.innerHTML = '<option value="">No se detectaron cámaras</option>';
        return;
      }

      videoInputs.forEach((device, idx) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Cámara ${idx + 1}`;
        el.cameraSelect.appendChild(option);
      });

      if (state.deviceId && videoInputs.some(d => d.deviceId === state.deviceId)) {
        el.cameraSelect.value = state.deviceId;
      } else {
        const backCam = videoInputs.find(d => /back|rear|trasera|environment/i.test(d.label));
        state.deviceId = backCam ? backCam.deviceId : videoInputs[0].deviceId;
        el.cameraSelect.value = state.deviceId;
        saveState();
      }
    } catch (err) {
      console.error('Error listando cámaras:', err);
      el.cameraSelect.innerHTML = '<option value="">Error al listar cámaras</option>';
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      el.cameraSelect.innerHTML = '<option value="">Requiere HTTPS o navegador compatible</option>';
      setStatus('error', 'Sin acceso a cámara');
      showToast('Usa HTTPS (GitHub Pages) y permite la cámara');
      return;
    }

    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
    }

    const baseVideo = {
      width: { ideal: Number(state.width) },
      height: { ideal: Number(state.height) },
      frameRate: { ideal: Number(state.frameRate) }
    };

    const constraints = {
      audio: false,
      video: state.deviceId
        ? { ...baseVideo, deviceId: { exact: state.deviceId } }
        : { ...baseVideo, facingMode: { ideal: 'environment' } }
    };

    try {
      currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err1) {
      console.warn('Intento 1 de cámara falló, probando sin deviceId exacto:', err1);
      try {
        currentStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...baseVideo, facingMode: { ideal: 'environment' } }
        });
      } catch (err2) {
        console.warn('Intento 2 falló, probando video: true básico:', err2);
        try {
          currentStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true
          });
        } catch (err3) {
          console.error('Error definitivo al abrir cámara:', err3);
          el.cameraSelect.innerHTML = '<option value="">Permiso denegado o cámara ocupada</option>';
          setStatus('error', 'Error de cámara');
          showToast('Revisa los permisos de cámara en el navegador');
          return;
        }
      }
    }

    videoTrack = currentStream.getVideoTracks()[0];
    if (!videoTrack) {
      el.cameraSelect.innerHTML = '<option value="">Sin pista de video</option>';
      return;
    }

    el.localVideo.srcObject = currentStream;
    el.localVideo.play().catch(() => {});

    await populateCameras();
    replaceStreamTrackInActiveCalls(videoTrack);
    inspectCapabilitiesAndSyncUI();
    await applyAllHardwareConstraints();
    updateResolutionBadge();
  }

  function updateResolutionBadge() {
    if (!videoTrack) return;
    const settings = videoTrack.getSettings();
    const w = settings.width || state.width;
    const h = settings.height || state.height;
    const fps = Math.round(settings.frameRate || state.frameRate);
    el.resBadge.textContent = `${w}x${h} @ ${fps}fps`;

    if (h > w) {
      el.previewBox.classList.add('portrait');
    } else {
      el.previewBox.classList.remove('portrait');
    }
  }

  function clampValue(val, capObj, fallback) {
    if (!capObj || typeof capObj.min !== 'number' || typeof capObj.max !== 'number') {
      return val ?? fallback;
    }
    const num = Number(val);
    if (isNaN(num)) return fallback;
    return Math.min(Math.max(num, capObj.min), capObj.max);
  }

  function configureSlider(rangeEl, capObj, currentValue, containerEl) {
    if (!capObj || typeof capObj.min !== 'number') {
      if (containerEl) containerEl.classList.add('unsupported');
      return null;
    }
    if (containerEl) containerEl.classList.remove('unsupported');
    rangeEl.min = capObj.min;
    rangeEl.max = capObj.max;
    if (capObj.step) rangeEl.step = capObj.step;

    const clamped = clampValue(currentValue, capObj, capObj.min);
    rangeEl.value = clamped;
    return clamped;
  }

  function inspectCapabilitiesAndSyncUI() {
    if (!videoTrack || typeof videoTrack.getCapabilities !== 'function') {
      capabilities = {};
      return;
    }

    capabilities = videoTrack.getCapabilities();

    const wbSupported = Array.isArray(capabilities.whiteBalanceMode);
    document.getElementById('ctrl-wb').classList.toggle('unsupported', !wbSupported && !capabilities.colorTemperature);
    el.autoWb.checked = state.whiteBalanceMode === 'continuous';
    if (capabilities.colorTemperature) {
      state.colorTemperature = configureSlider(el.rangeCt, capabilities.colorTemperature, state.colorTemperature);
    }
    el.rangeCt.disabled = el.autoWb.checked || !capabilities.colorTemperature;
    el.valCt.textContent = `${state.colorTemperature}K`;

    const expSupported = Array.isArray(capabilities.exposureMode);
    document.getElementById('ctrl-exp').classList.toggle('unsupported', !expSupported && !capabilities.exposureTime);
    el.autoExp.checked = state.exposureMode === 'continuous';
    if (capabilities.exposureTime) {
      state.exposureTime = configureSlider(el.rangeExp, capabilities.exposureTime, state.exposureTime);
    }
    el.rangeExp.disabled = el.autoExp.checked || !capabilities.exposureTime;
    el.valExp.textContent = `${state.exposureTime}`;

    if (capabilities.iso) {
      state.iso = configureSlider(el.rangeIso, capabilities.iso, state.iso, document.getElementById('ctrl-iso'));
      el.rangeIso.disabled = el.autoExp.checked;
    } else {
      document.getElementById('ctrl-iso').classList.add('unsupported');
    }
    el.valIso.textContent = `${state.iso}`;

    if (capabilities.exposureCompensation) {
      state.exposureCompensation = configureSlider(
        el.rangeEv,
        capabilities.exposureCompensation,
        state.exposureCompensation,
        document.getElementById('ctrl-ev')
      );
      el.rangeEv.disabled = !el.autoExp.checked;
    } else {
      document.getElementById('ctrl-ev').classList.add('unsupported');
    }
    el.valEv.textContent = `${state.exposureCompensation}`;

    const focusSupported = Array.isArray(capabilities.focusMode);
    document.getElementById('ctrl-focus').classList.toggle('unsupported', !focusSupported && !capabilities.focusDistance);
    el.autoFocus.checked = state.focusMode === 'continuous';
    if (capabilities.focusDistance) {
      state.focusDistance = configureSlider(el.rangeFocus, capabilities.focusDistance, state.focusDistance);
    }
    el.rangeFocus.disabled = el.autoFocus.checked || !capabilities.focusDistance;
    el.valFocus.textContent = Number(state.focusDistance).toFixed(2);

    if (capabilities.zoom) {
      state.zoom = configureSlider(el.rangeZoom, capabilities.zoom, state.zoom, document.getElementById('ctrl-zoom'));
    } else {
      document.getElementById('ctrl-zoom').classList.add('unsupported');
    }
    el.valZoom.textContent = `${Number(state.zoom).toFixed(1)}x`;

    saveState();
  }

  async function applySingleConstraint(key, value) {
    if (!videoTrack) return;
    try {
      await videoTrack.applyConstraints({
        advanced: [{ [key]: value }]
      });
    } catch (err) {
      console.warn(`[Constraint Rechazado] ${key}=${value}:`, err.message);
    }
  }

  async function applyAllHardwareConstraints() {
    if (!videoTrack) return;

    if (Array.isArray(capabilities.whiteBalanceMode) && capabilities.whiteBalanceMode.includes(state.whiteBalanceMode)) {
      await applySingleConstraint('whiteBalanceMode', state.whiteBalanceMode);
    }
    if (state.whiteBalanceMode === 'manual' && capabilities.colorTemperature) {
      const val = clampValue(state.colorTemperature, capabilities.colorTemperature, 5000);
      await applySingleConstraint('colorTemperature', val);
    }

    if (Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes(state.exposureMode)) {
      await applySingleConstraint('exposureMode', state.exposureMode);
    }
    if (state.exposureMode === 'manual') {
      if (capabilities.exposureTime) {
        const expVal = clampValue(state.exposureTime, capabilities.exposureTime, 300);
        await applySingleConstraint('exposureTime', expVal);
      }
      if (capabilities.iso) {
        const isoVal = clampValue(state.iso, capabilities.iso, 400);
        await applySingleConstraint('iso', isoVal);
      }
    } else {
      if (capabilities.exposureCompensation) {
        const evVal = clampValue(state.exposureCompensation, capabilities.exposureCompensation, 0);
        await applySingleConstraint('exposureCompensation', evVal);
      }
    }

    if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes(state.focusMode)) {
      await applySingleConstraint('focusMode', state.focusMode);
    }
    if (state.focusMode === 'manual' && capabilities.focusDistance) {
      const focusVal = clampValue(state.focusDistance, capabilities.focusDistance, 0.25);
      await applySingleConstraint('focusDistance', focusVal);
    }

    if (capabilities.zoom) {
      const zoomVal = clampValue(state.zoom, capabilities.zoom, 1);
      await applySingleConstraint('zoom', zoomVal);
    }
  }

  /* ------------------------------------------------------------------------
     3. WEBRTC (PEERJS), AUTENTICACIÓN Y BITRATE
     ------------------------------------------------------------------------ */
  function initPeerEmitter() {
    if (peer && !peer.destroyed) {
      peer.destroy();
    }
    activeCalls.clear();

    const fullId = PEER_PREFIX + state.roomId.trim();
    setStatus('', 'Registrando sala...');

    peer = new Peer(fullId, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });

    peer.on('open', () => {
      setStatus('ready', 'Listo para OBS');
    });

    peer.on('call', (incomingCall) => {
      const clientPass = incomingCall.metadata ? String(incomingCall.metadata.password || '') : '';
      const expectedPass = String(state.roomPassword || '').trim();

      if (expectedPass !== '' && clientPass !== expectedPass) {
        console.warn('[Emitter] Intento de conexión rechazado por clave incorrecta.');
        incomingCall.close();
        return;
      }

      if (!currentStream) return;

      incomingCall.answer(currentStream);
      activeCalls.add(incomingCall);
      setStatus('connected', 'Transmitiendo a OBS');

      enforceHighBitrate(incomingCall);

      incomingCall.on('close', () => {
        activeCalls.delete(incomingCall);
        if (activeCalls.size === 0) setStatus('ready', 'Listo para OBS');
      });

      incomingCall.on('error', () => {
        activeCalls.delete(incomingCall);
        if (activeCalls.size === 0) setStatus('ready', 'Listo para OBS');
      });
    });

    peer.on('error', (err) => {
      console.error('[Emitter Peer Error]:', err);
      if (err.type === 'unavailable-id') {
        setStatus('error', 'ID en uso (cámbialo)');
        showToast('Ese ID de sala ya está en uso. Prueba otro.');
      } else {
        setStatus('error', 'Error de red');
      }
    });

    peer.on('disconnected', () => {
      setStatus('', 'Reconectando...');
      if (!peer.destroyed) peer.reconnect();
    });
  }

  function enforceHighBitrate(call) {
    const pc = call.peerConnection;
    if (!pc) return;

    const applySenderParams = async () => {
      const senders = pc.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (!videoSender) return;

      try {
        const params = videoSender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = Number(state.bitrateKbps) * 1000;
        params.degradationPreference = 'maintain-resolution';
        await videoSender.setParameters(params);
      } catch (e) {
        console.warn('[WebRTC QoS] No se pudo aplicar setParameters:', e);
      }
    };

    pc.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        applySenderParams();
      }
    });

    setTimeout(applySenderParams, 800);
  }

  function replaceStreamTrackInActiveCalls(newTrack) {
    activeCalls.forEach(call => {
      const pc = call.peerConnection;
      if (!pc) return;
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        sender.replaceTrack(newTrack).catch(e => console.warn('Error reemplazando pista:', e));
      }
    });
  }

  /* ------------------------------------------------------------------------
     4. MONITOR DE ESTADÍSTICAS V2
     ------------------------------------------------------------------------ */
  let prevBytesSent = 0;
  let prevTimestamp = 0;

  function startStatsMonitor() {
    stopStatsMonitor();
    statsInterval = setInterval(async () => {
      if (!el.statsDetails || !el.statsDetails.open || activeCalls.size === 0) return;

      const activeCall = Array.from(activeCalls)[0];
      if (!activeCall || !activeCall.peerConnection) return;

      try {
        const statsReport = await activeCall.peerConnection.getStats();
        let bytesSent = 0;
        let now = 0;
        let rtt = null;

        statsReport.forEach(report => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            bytesSent = report.bytesSent;
            now = report.timestamp;
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (report.currentRoundTripTime !== undefined) {
              rtt = Math.round(report.currentRoundTripTime * 1000);
            }
          }
        });

        if (prevBytesSent > 0 && now > prevTimestamp) {
          const bitrate = ((bytesSent - prevBytesSent) * 8) / (now - prevTimestamp);
          el.statBitrate.textContent = `${(bitrate / 1000).toFixed(2)} Mbps`;
        }
        prevBytesSent = bytesSent;
        prevTimestamp = now;

        if (rtt !== null) {
          el.statRtt.textContent = `${rtt} ms`;
        }

        if (videoTrack) {
          const settings = videoTrack.getSettings();
          el.statRes.textContent = `${settings.width || state.width}x${settings.height || state.height}`;
          el.statFps.textContent = `${Math.round(settings.frameRate || state.frameRate)} fps`;
        }
      } catch (err) {
        console.warn('Error obteniendo métricas RTC:', err);
      }
    }, 1500);
  }

  function stopStatsMonitor() {
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
  }

  if (el.statsDetails) {
    el.statsDetails.addEventListener('toggle', () => {
      if (el.statsDetails.open) {
        startStatsMonitor();
      } else {
        stopStatsMonitor();
      }
    });
  }

  /* ------------------------------------------------------------------------
     5. EVENTOS DE UI Y CONTROLES
     ------------------------------------------------------------------------ */
  function syncInitialUI() {
    el.roomId.value = state.roomId;
    el.roomPassword.value = state.roomPassword || '';
    el.bitrateSelect.value = String(state.bitrateKbps);
    el.resPreset.value = `${state.width}x${state.height}`;
    el.fpsSelect.value = String(state.frameRate);
  }

  el.roomId.addEventListener('change', () => {
    const cleanId = el.roomId.value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanId) return;
    state.roomId = cleanId;
    el.roomId.value = cleanId;
    saveState();
    initPeerEmitter();
    showToast('ID de sala actualizado');
  });

  el.roomPassword.addEventListener('change', () => {
    state.roomPassword = el.roomPassword.value.trim();
    saveState();
    showToast(state.roomPassword ? 'Contraseña de sala guardada' : 'Contraseña desactivada');
  });

  el.bitrateSelect.addEventListener('change', () => {
    state.bitrateKbps = Number(el.bitrateSelect.value);
    saveState();
    activeCalls.forEach(call => enforceHighBitrate(call));
    showToast(`Bitrate ajustado a ${state.bitrateKbps} kbps`);
  });

  el.btnReconnectPeer.addEventListener('click', () => {
    initPeerEmitter();
    showToast('Reiniciando señalización WebRTC...');
  });

  // Copia la URL con ?view&id=... y, si hay clave activa, añade &password=...
  el.btnCopyObs.addEventListener('click', async () => {
    const baseUrl = window.location.origin + window.location.pathname;
    const roomId = (el.roomId.value.trim() || state.roomId).replace(/[^a-zA-Z0-9_-]/g, '');
    const password = (el.roomPassword.value.trim() || state.roomPassword || '').trim();

    state.roomId = roomId;
    state.roomPassword = password;
    saveState();

    let obsUrl = `${baseUrl}?view&id=${encodeURIComponent(roomId)}`;
    if (password) {
      obsUrl += `&password=${encodeURIComponent(password)}`;
    }

    try {
      await navigator.clipboard.writeText(obsUrl);
      showToast(password ? '¡URL con contraseña copiada para OBS!' : '¡URL de OBS copiada al portapapeles!');
    } catch (e) {
      prompt('Copia esta URL para OBS Studio:', obsUrl);
    }
  });

  el.cameraSelect.addEventListener('change', async () => {
    state.deviceId = el.cameraSelect.value;
    saveState();
    await startCamera();
    showToast('Lente cambiado y ajustes aplicados');
  });

  el.resPreset.addEventListener('change', async () => {
    const [w, h] = el.resPreset.value.split('x').map(Number);
    state.width = w;
    state.height = h;
    saveState();
    await startCamera();
  });

  el.fpsSelect.addEventListener('change', async () => {
    state.frameRate = Number(el.fpsSelect.value);
    saveState();
    await startCamera();
  });

  el.btnReapply.addEventListener('click', async () => {
    await applyAllHardwareConstraints();
    showToast('Ajustes de hardware reaplicados');
  });

  el.autoWb.addEventListener('change', async () => {
    state.whiteBalanceMode = el.autoWb.checked ? 'continuous' : 'manual';
    el.rangeCt.disabled = el.autoWb.checked;
    saveState();
    await applySingleConstraint('whiteBalanceMode', state.whiteBalanceMode);
    if (!el.autoWb.checked) {
      await applySingleConstraint('colorTemperature', Number(state.colorTemperature));
    }
  });

  el.rangeCt.addEventListener('input', async () => {
    state.colorTemperature = Number(el.rangeCt.value);
    el.valCt.textContent = `${state.colorTemperature}K`;
    saveState();
    await applySingleConstraint('colorTemperature', state.colorTemperature);
  });

  el.autoExp.addEventListener('change', async () => {
    state.exposureMode = el.autoExp.checked ? 'continuous' : 'manual';
    el.rangeExp.disabled = el.autoExp.checked;
    el.rangeIso.disabled = el.autoExp.checked;
    el.rangeEv.disabled = !el.autoExp.checked;
    saveState();

    await applySingleConstraint('exposureMode', state.exposureMode);
    if (state.exposureMode === 'manual') {
      await applySingleConstraint('exposureTime', Number(state.exposureTime));
      await applySingleConstraint('iso', Number(state.iso));
    } else {
      await applySingleConstraint('exposureCompensation', Number(state.exposureCompensation));
    }
  });

  el.rangeExp.addEventListener('input', async () => {
    state.exposureTime = Number(el.rangeExp.value);
    el.valExp.textContent = `${state.exposureTime}`;
    saveState();
    await applySingleConstraint('exposureTime', state.exposureTime);
  });

  el.rangeIso.addEventListener('input', async () => {
    state.iso = Number(el.rangeIso.value);
    el.valIso.textContent = `${state.iso}`;
    saveState();
    await applySingleConstraint('iso', state.iso);
  });

  el.rangeEv.addEventListener('input', async () => {
    state.exposureCompensation = Number(el.rangeEv.value);
    el.valEv.textContent = `${state.exposureCompensation}`;
    saveState();
    await applySingleConstraint('exposureCompensation', state.exposureCompensation);
  });

  el.autoFocus.addEventListener('change', async () => {
    state.focusMode = el.autoFocus.checked ? 'continuous' : 'manual';
    el.rangeFocus.disabled = el.autoFocus.checked;
    saveState();
    await applySingleConstraint('focusMode', state.focusMode);
    if (!el.autoFocus.checked) {
      await applySingleConstraint('focusDistance', Number(state.focusDistance));
    }
  });

  el.rangeFocus.addEventListener('input', async () => {
    state.focusDistance = Number(el.rangeFocus.value);
    el.valFocus.textContent = state.focusDistance.toFixed(2);
    saveState();
    await applySingleConstraint('focusDistance', state.focusDistance);
  });

  el.rangeZoom.addEventListener('input', async () => {
    state.zoom = Number(el.rangeZoom.value);
    el.valZoom.textContent = `${state.zoom.toFixed(1)}x`;
    saveState();
    await applySingleConstraint('zoom', state.zoom);
  });

  function getProfiles() {
    try {
      return JSON.parse(localStorage.getItem(PROFILES_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  el.btnSaveProfile.addEventListener('click', () => {
    const profileKey = el.profileSelect.value;
    const profiles = getProfiles();
    const { roomId, roomPassword, ...cameraSettings } = state;
    profiles[profileKey] = cameraSettings;
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    showToast(`Ajustes guardados en perfil "${profileKey}"`);
  });

  el.profileSelect.addEventListener('change', async () => {
    const profileKey = el.profileSelect.value;
    const profiles = getProfiles();
    if (profiles[profileKey]) {
      state = { ...state, ...profiles[profileKey] };
      saveState();
      syncInitialUI();
      await startCamera();
      showToast(`Perfil "${profileKey}" cargado`);
    } else {
      showToast('Este perfil aún no tiene ajustes guardados');
    }
  });

  el.btnExportJson.addEventListener('click', () => {
    const dataStr = JSON.stringify(state, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `obs-webcam-config-${state.roomId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Configuración exportada');
  });

  el.btnImportJson.addEventListener('click', () => el.fileImport.click());

  el.fileImport.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        state = { ...defaultState, ...imported };
        saveState();
        syncInitialUI();
        initPeerEmitter();
        await startCamera();
        showToast('Configuración importada correctamente');
      } catch (err) {
        showToast('Error: Archivo JSON inválido');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  el.btnResetAll.addEventListener('click', async () => {
    if (!confirm('¿Restablecer todos los ajustes de cámara a valores de fábrica?')) return;
    const keepRoomId = state.roomId;
    const keepPass = state.roomPassword;
    state = { ...defaultState, roomId: keepRoomId, roomPassword: keepPass };
    saveState();
    syncInitialUI();
    await startCamera();
    showToast('Valores restablecidos');
  });

  el.btnOled.addEventListener('click', () => {
    el.oledSaver.classList.add('active');
  });

  let lastTap = 0;
  el.oledSaver.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 350) {
      el.oledSaver.classList.remove('active');
    }
    lastTap = now;
  });

  (async () => {
    syncInitialUI();
    await requestWakeLock();
    await startCamera();
    initPeerEmitter();
  })();
}