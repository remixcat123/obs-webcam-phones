import {
  parseRouteParams,
  resolveRoomId,
  persistRoomId,
  buildObsViewerUrl,
  getPeerConfig,
  getMediaPresets,
  clampAndStepValue,
  loadSession,
  saveSession,
} from './config.js';
import {
  listVideoInputs,
  openCameraStream,
  readTrackCapabilitiesAndSettings,
  requestScreenWakeLock,
  stopCameraStream,
  getDesiredState,
  queueSensorPatch,
  reapplyDesiredState,
  restoreSensorState,
} from './camera.js';
import {
  createEmitterPeer,
  applySenderEncodingParams,
  replaceActiveVideoTrack,
  startViewerAutoHealing,
  collectWebRtcStats,
} from './webrtc.js';

const STORAGE_KEY_PROFILES = 'obs_p2p_webcam_profiles';

const KNOWN_CAPABILITY_LABELS = {
  whiteBalanceMode: 'Balance de blancos',
  colorTemperature: 'Temperatura de color',
  exposureMode: 'Modo de exposición',
  exposureTime: 'Tiempo de exposición',
  iso: 'ISO',
  exposureCompensation: 'Compensación EV',
  focusMode: 'Modo de enfoque',
  focusDistance: 'Distancia de enfoque',
  zoom: 'Zoom',
  torch: 'Linterna',
  pan: 'Pan',
  tilt: 'Tilt',
  brightness: 'Brillo',
  contrast: 'Contraste',
  saturation: 'Saturación',
  sharpness: 'Nitidez',
};

const KNOWN_MODE_LINKS = {
  colorTemperature: 'whiteBalanceMode',
  exposureTime: 'exposureMode',
  iso: 'exposureMode',
  focusDistance: 'focusMode',
};

const EXCLUDED_SENSOR_KEYS = new Set([
  'deviceId',
  'groupId',
  'width',
  'height',
  'frameRate',
  'aspectRatio',
  'facingMode',
  'resizeMode',
]);

const appState = {
  mode: 'emitter',
  roomId: '',
  roomPassword: '',
  selectedDeviceId: '',
  resolutionId: '720p-16x9',
  fps: 30,
  bitrateKbps: 4000,
  stream: null,
  track: null,
  capabilities: {},
  settings: {},
  emitterPeerController: null,
  activePeerConnections: new Set(),
  viewerController: null,
  wakeLockSentinel: null,
  profiles: [],
  statsTimer: null,
  prevStatsSample: null,
  toastTimer: null,
  listenersBound: false,
};

function getEl(id) {
  return document.getElementById(id);
}

function formatCapabilityLabel(key) {
  if (Object.prototype.hasOwnProperty.call(KNOWN_CAPABILITY_LABELS, key)) {
    return KNOWN_CAPABILITY_LABELS[key];
  }
  const spaced = String(key || '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

function resolveModeKeyForCapability(key, capabilities = {}) {
  if (Object.prototype.hasOwnProperty.call(KNOWN_MODE_LINKS, key)) {
    const linked = KNOWN_MODE_LINKS[key];
    if (Array.isArray(capabilities[linked]) && capabilities[linked].length > 0) {
      return linked;
    }
  }
  if (key.endsWith('Distance') || key.endsWith('Temperature') || key === 'iso' || key === 'exposureTime') {
    const prefix = key.startsWith('whiteBalance')
      ? 'whiteBalanceMode'
      : key.startsWith('exposure') || key === 'iso'
      ? 'exposureMode'
      : key.startsWith('focus')
      ? 'focusMode'
      : null;
    if (prefix && Array.isArray(capabilities[prefix]) && capabilities[prefix].length > 0) {
      return prefix;
    }
  }
  return null;
}

function saveProfilesToLocalStorage() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(appState.profiles));
  } catch (_) {}
}

function loadProfilesFromLocalStorage() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PROFILES);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item, idx) => ({
        name:
          typeof item.name === 'string' && item.name.trim() !== ''
            ? item.name.trim()
            : `Perfil guardado ${idx + 1}`,
        createdAt:
          typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
        resolutionId:
          typeof item.resolutionId === 'string' ? item.resolutionId : '720p-16x9',
        fps: typeof item.fps === 'number' && Number.isFinite(item.fps) ? item.fps : 30,
        bitrateKbps:
          typeof item.bitrateKbps === 'number' && Number.isFinite(item.bitrateKbps)
            ? item.bitrateKbps
            : 4000,
        sensorValues:
          item.sensorValues && typeof item.sensorValues === 'object'
            ? { ...item.sensorValues }
            : {},
        modeValues:
          item.modeValues && typeof item.modeValues === 'object'
            ? { ...item.modeValues }
            : {},
      }));
  } catch (_) {
    return [];
  }
}

function setStatus(statusKey, labelText) {
  const indicator = getEl('status-indicator');
  const statusText = getEl('status-text');

  if (indicator) {
    indicator.classList.remove(
      'status-dot--init',
      'status-dot--ready',
      'status-dot--streaming',
      'status-dot--error'
    );
    const validModifiers = ['init', 'ready', 'streaming', 'error'];
    const mod = validModifiers.includes(statusKey) ? statusKey : 'init';
    indicator.classList.add(`status-dot--${mod}`);
  }

  if (statusText && typeof labelText === 'string') {
    statusText.textContent = labelText;
  }
}

function updateWakeLockBadge(active) {
  const badge = getEl('wakelock-badge');
  if (!badge) return;
  if (active) {
    badge.textContent = 'WakeLock: Activo';
  } else if (typeof navigator !== 'undefined' && navigator.wakeLock) {
    badge.textContent = 'WakeLock: Inactivo';
  } else {
    badge.textContent = 'WakeLock: No soportado';
  }
}

function updatePreviewFormatBadge() {
  const badge = getEl('preview-format-badge');
  const container = getEl('preview-container');
  const presets = getMediaPresets();
  const preset =
    presets.resolutions.find((r) => r.id === appState.resolutionId) || presets.resolutions[0];

  const actualWidth =
    appState.settings && typeof appState.settings.width === 'number' && appState.settings.width > 0
      ? appState.settings.width
      : preset
      ? preset.width
      : 1280;
  const actualHeight =
    appState.settings && typeof appState.settings.height === 'number' && appState.settings.height > 0
      ? appState.settings.height
      : preset
      ? preset.height
      : 720;
  const actualFps =
    appState.settings &&
    typeof appState.settings.frameRate === 'number' &&
    appState.settings.frameRate > 0
      ? Math.round(appState.settings.frameRate)
      : appState.fps;

  if (badge) {
    badge.textContent = `${actualWidth}x${actualHeight} · ${actualFps} FPS`;
  }

  if (container) {
    const orientation =
      actualHeight > actualWidth ? '9:16' : preset ? preset.orientation : '16:9';
    container.dataset.orientation = orientation;
    container.classList.toggle('preview-container--portrait', orientation === '9:16');
    container.classList.toggle('preview-container--landscape', orientation !== '9:16');
  }
}

function populateFormatSelectors() {
  const presets = getMediaPresets();
  const resSelect = getEl('resolution-select');
  const fpsSelect = getEl('fps-select');
  const bitrateSelect = getEl('bitrate-select');

  if (resSelect) {
    resSelect.innerHTML = '';
    presets.resolutions.forEach((item) => {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.label;
      if (item.id === appState.resolutionId) {
        opt.selected = true;
      }
      resSelect.appendChild(opt);
    });
  }

  if (fpsSelect) {
    fpsSelect.innerHTML = '';
    presets.fpsList.forEach((fpsVal) => {
      const opt = document.createElement('option');
      opt.value = String(fpsVal);
      opt.textContent = `${fpsVal} fps`;
      if (fpsVal === appState.fps) {
        opt.selected = true;
      }
      fpsSelect.appendChild(opt);
    });
  }

  if (bitrateSelect) {
    bitrateSelect.innerHTML = '';
    presets.bitrateList.forEach((kbps) => {
      const opt = document.createElement('option');
      opt.value = String(kbps);
      opt.textContent = `${kbps} kbps`;
      if (kbps === appState.bitrateKbps) {
        opt.selected = true;
      }
      bitrateSelect.appendChild(opt);
    });
  }
}

function findPreferredBackCameraDeviceId(devices) {
  const back = devices.filter(
    (d) => d.deviceId && /back|rear|environment|trasera|posterior/i.test(d.label || '')
  );
  if (!back.length) return '';
  const idx = (d) => {
    const m = /camera2?\s*(\d+)/i.exec(d.label || '');
    return m ? +m[1] : 999;
  };
  return back.sort((a, b) => idx(a) - idx(b))[0].deviceId;
}

async function refreshCameraDeviceList(preferredDeviceId = '') {
  const cameraSelect = getEl('camera-select');
  const devices = await listVideoInputs();

  const activeTrackDeviceId =
    appState.settings && typeof appState.settings.deviceId === 'string'
      ? appState.settings.deviceId
      : '';
  const targetId = preferredDeviceId || activeTrackDeviceId || appState.selectedDeviceId;

  if (cameraSelect) {
    cameraSelect.innerHTML = '';
    if (devices.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Cámara predeterminada';
      cameraSelect.appendChild(opt);
    } else {
      devices.forEach((dev) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label;
        if (dev.deviceId === targetId) {
          opt.selected = true;
        }
        cameraSelect.appendChild(opt);
      });
    }
  }

  if (targetId) {
    appState.selectedDeviceId = targetId;
  } else if (devices[0] && devices[0].deviceId) {
    appState.selectedDeviceId = devices[0].deviceId;
  }

  return devices;
}

function getSelectedResolutionPreset() {
  const presets = getMediaPresets();
  return (
    presets.resolutions.find((r) => r.id === appState.resolutionId) || presets.resolutions[0]
  );
}

// La interfaz muestra lo que se pidió y se aceptó (desired), y cae a lo que informa la cámara
function sensorViewState() {
  return { ...appState.settings, ...(appState.track ? getDesiredState(appState.track) : {}) };
}

async function commitSensorChange(patch) {
  if (!appState.track) return;
  const result = await queueSensorPatch(appState.track, patch, 100);
  if (!result) return;
  if (result.settings) appState.settings = result.settings;
  persistSensors();
  const rejectedKeys = Object.keys(result.rejected || {});
  if (rejectedKeys.length) {
    showToast(`El sensor rechazó: ${rejectedKeys.map(formatCapabilityLabel).join(', ')}`);
  }
  renderActiveSensorControls();
  updatePreviewFormatBadge();
}

function renderActiveSensorControls() {
  renderSensorControls(
    appState.capabilities,
    sensorViewState(),
    (key, value) => commitSensorChange({ [key]: value }),
    (modeKey, value) => commitSensorChange({ [modeKey]: value })
  );
}

function showDiagnostics() {
  const t = appState.track;
  const dump = {
    userAgent: navigator.userAgent,
    label: t && t.label,
    capabilities: t && t.getCapabilities ? t.getCapabilities() : null,
    settings: t && t.getSettings ? t.getSettings() : null,
    desired: t ? getDesiredState(t) : null,
    saved: loadSession().sensors || {},
  };
  let ta = getEl('diag-output');
  if (!ta) {
    ta = document.createElement('textarea');
    ta.id = 'diag-output';
    ta.readOnly = true;
    ta.rows = 12;
    ta.style.width = '100%';
    getEl('sensor-controls-container').after(ta);
  }
  ta.value = JSON.stringify(dump, null, 2);
  ta.select();
}

function collectCurrentNumericSensorValues() {
  const values = {};
  if (!appState.capabilities || typeof appState.capabilities !== 'object') {
    return values;
  }
  const viewState = sensorViewState();
  for (const [key, cap] of Object.entries(appState.capabilities)) {
    if (EXCLUDED_SENSOR_KEYS.has(key)) continue;
    if (!cap || typeof cap !== 'object') continue;
    if (typeof cap.min !== 'number' || typeof cap.max !== 'number') continue;
    const val = viewState[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      values[key] = val;
    }
  }
  return values;
}

function collectCurrentModeValues() {
  const modes = {};
  if (!appState.capabilities || typeof appState.capabilities !== 'object') {
    return modes;
  }
  const viewState = sensorViewState();
  for (const [key, cap] of Object.entries(appState.capabilities)) {
    if (EXCLUDED_SENSOR_KEYS.has(key)) continue;
    if (Array.isArray(cap) && cap.length > 0) {
      const val = viewState[key];
      if (typeof val === 'string' && val.trim() !== '') {
        modes[key] = val;
      }
    }
  }
  return modes;
}

function refreshProfileSelectOptions(selectedName = '') {
  const select = getEl('profile-select');
  if (!select) return;

  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent =
    appState.profiles.length > 0
      ? 'Seleccionar perfil...'
      : 'No hay perfiles en sesión';
  select.appendChild(placeholder);

  appState.profiles.forEach((profile, index) => {
    const opt = document.createElement('option');
    opt.value = String(index);
    opt.textContent = profile.name || `Perfil ${index + 1}`;
    if (selectedName && profile.name === selectedName) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

async function propagateTrackToActivePeers(newTrack) {
  if (!newTrack) return false;
  newTrack.enabled = true;

  const tasks = [];
  for (const pc of appState.activePeerConnections) {
    tasks.push(replaceActiveVideoTrack(pc, newTrack));
  }
  const results = await Promise.allSettled(tasks);
  return results.some((r) => r.status === 'fulfilled' && r.value === true);
}

function persistSensors() {
  const id = appState.settings.deviceId || appState.selectedDeviceId;
  if (!id || !appState.track) return;
  const all = loadSession().sensors || {};
  saveSession({ sensors: { ...all, [id]: getDesiredState(appState.track) } });
}

async function initializeOrSwitchCamera(options = {}) {
  const { resetFresh = true, preferredDeviceId = '', allowRearFallback = false } = options || {};
  const preset = getSelectedResolutionPreset();
  const isExplicitLensSwitch =
    typeof preferredDeviceId === 'string' && preferredDeviceId.trim() !== '';
  const targetDeviceId = isExplicitLensSwitch
    ? preferredDeviceId.trim()
    : appState.selectedDeviceId || undefined;

  const previousStream = appState.stream;
  const previousDeviceId = appState.selectedDeviceId;

  try {
    setStatus('init', 'Iniciando...');

    if (isExplicitLensSwitch && previousStream) {
      stopCameraStream(previousStream);
      appState.stream = null;
      appState.track = null;
    }

    const opened = await openCameraStream({
      deviceId: targetDeviceId,
      width: preset ? preset.width : undefined,
      height: preset ? preset.height : undefined,
      fps: appState.fps,
    });

    appState.stream = opened.stream;
    appState.track = opened.track;
    if (appState.track) {
      appState.track.enabled = true;
    }
    appState.capabilities = opened.capabilities || {};
    appState.settings = opened.settings || {};

    const devId = appState.settings.deviceId || '';
    const saved = (loadSession().sensors || {})[devId] || {};
    const restored = await restoreSensorState(appState.track, saved);
    if (restored && restored.settings) appState.settings = restored.settings;
    const cont = getEl('sensor-controls-container');
    if (cont) cont.innerHTML = '';//podre un comentario yo aqui

    if (typeof appState.settings.deviceId === 'string' && appState.settings.deviceId) {
      appState.selectedDeviceId = appState.settings.deviceId;
    } else if (isExplicitLensSwitch) {
      appState.selectedDeviceId = targetDeviceId;
    }

    const localVideo = getEl('local-video');
    if (localVideo) {
      localVideo.srcObject = appState.stream;
      try {
        await localVideo.play();
      } catch (_) {}
    }

    const devices = await refreshCameraDeviceList(appState.selectedDeviceId);

    if (allowRearFallback && !isExplicitLensSwitch && !targetDeviceId) {
      const rearId = findPreferredBackCameraDeviceId(devices);
      if (rearId && rearId !== appState.selectedDeviceId) {
        await initializeOrSwitchCamera({
          resetFresh,
          preferredDeviceId: rearId,
          allowRearFallback: false,
        });
        return;
      }
    }

    if (appState.selectedDeviceId) {
      saveSession({ deviceId: appState.selectedDeviceId });
    }

    updatePreviewFormatBadge();
    renderActiveSensorControls();

    if (appState.track && previousStream && previousStream !== appState.stream) {
      const replaced = await propagateTrackToActivePeers(appState.track);
      if (isExplicitLensSwitch && replaced) {
        showToast('Cámara actualizada en la transmisión.');
      }
      stopCameraStream(previousStream);
    }

    if (resetFresh) {
      appState.wakeLockSentinel = await requestScreenWakeLock(appState.wakeLockSentinel);
      updateWakeLockBadge(
        Boolean(appState.wakeLockSentinel && !appState.wakeLockSentinel.released)
      );
    }

    const hasStreamingPeer = appState.activePeerConnections.size > 0;
    setStatus(
      hasStreamingPeer ? 'streaming' : 'ready',
      hasStreamingPeer ? 'Transmitiendo a OBS' : 'Listo para OBS'
    );
  } catch (err) {
    if (previousStream && previousStream !== appState.stream) {
      stopCameraStream(previousStream);
    }

    if (!isExplicitLensSwitch) {
      appState.selectedDeviceId = previousDeviceId;
    }

    setStatus('error', 'Error de cámara');
    showToast(
      `Error de cámara: ${err && err.message ? err.message : 'No se pudo acceder al sensor'}`
    );
  }
}

function registerPeerConnection(pc) {
  if (!pc || appState.activePeerConnections.has(pc)) return;
  appState.activePeerConnections.add(pc);
  applySenderEncodingParams(pc, appState.bitrateKbps);

  const cleanupPc = () => {
    appState.activePeerConnections.delete(pc);
  };

  pc.addEventListener('connectionstatechange', () => {
    if (
      pc.connectionState === 'failed' ||
      pc.connectionState === 'disconnected' ||
      pc.connectionState === 'closed'
    ) {
      cleanupPc();
    }
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
      cleanupPc();
    }
  });
}

function setupEmitterPeer() {
  if (appState.emitterPeerController) {
    appState.emitterPeerController.destroy();
    appState.emitterPeerController = null;
  }
  appState.activePeerConnections.clear();

  setStatus('init', 'Iniciando...');

  try {
    appState.emitterPeerController = createEmitterPeer({
      roomId: appState.roomId,
      getPassword: () => appState.roomPassword,
      getStream: () => appState.stream,
      bitrateKbps: appState.bitrateKbps,
      peerConfig: getPeerConfig(),
      onIncomingCall: (call) => {
        if (call && call.peerConnection) {
          registerPeerConnection(call.peerConnection);
        }
      },
      onStatusChange: (status) => {
        if (status === 'streaming') {
          setStatus('streaming', 'Transmitiendo a OBS');
        } else if (status === 'ready') {
          setStatus('ready', 'Listo para OBS');
        } else if (status === 'error') {
          setStatus('error', 'Error de cámara');
        } else {
          setStatus('init', 'Iniciando...');
        }
      },
      onError: (err) => {
        if (err && err.code === 'INVALID_PASSWORD') {
          showToast('Rechazada conexión de receptor: contraseña inválida.');
          return;
        }
        if (err && err.type === 'unavailable-id') {
          showToast('El ID de sala ya está en uso. Cambia o reinicia la sala.');
          setStatus('error', 'Error de cámara');
        }
      },
    });
  } catch (err) {
    setStatus('error', 'Error de cámara');
    showToast(`Error de señalización: ${err && err.message ? err.message : 'PeerJS no disponible'}`);
  }
}

function stopStatsMonitor() {
  if (appState.statsTimer !== null) {
    clearInterval(appState.statsTimer);
    appState.statsTimer = null;
  }
  appState.prevStatsSample = null;
}

function startStatsMonitor() {
  stopStatsMonitor();

  const updateOnce = async () => {
    const details = getEl('stats-details');
    if (!details || !details.open) {
      stopStatsMonitor();
      return;
    }

    const activePc = Array.from(appState.activePeerConnections).find(
      (pc) => pc && pc.connectionState !== 'closed'
    );
    if (!activePc) {
      const resEl = getEl('stat-resolution');
      const fpsEl = getEl('stat-fps');
      const brEl = getEl('stat-bitrate');
      const rttEl = getEl('stat-rtt');
      if (resEl) resEl.textContent = '--';
      if (fpsEl) fpsEl.textContent = '--';
      if (brEl) brEl.textContent = '--';
      if (rttEl) rttEl.textContent = '--';
      return;
    }

    const metrics = await collectWebRtcStats(activePc, appState.prevStatsSample);
    appState.prevStatsSample = metrics.sample;

    const resEl = getEl('stat-resolution');
    const fpsEl = getEl('stat-fps');
    const brEl = getEl('stat-bitrate');
    const rttEl = getEl('stat-rtt');

    if (resEl) resEl.textContent = metrics.resolution || '--';
    if (fpsEl) fpsEl.textContent = metrics.fps > 0 ? `${metrics.fps} fps` : '--';
    if (brEl) brEl.textContent = `${metrics.bitrateKbps} kbps`;
    if (rttEl) {
      rttEl.textContent =
        typeof metrics.rttMs === 'number' && Number.isFinite(metrics.rttMs)
          ? `${metrics.rttMs} ms`
          : '--';
    }
  };

  updateOnce();
  appState.statsTimer = setInterval(updateOnce, 1000);
}

function showAuthModal(errorMessage = '') {
  const modal = getEl('obs-auth-modal');
  const errEl = getEl('obs-auth-error');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('modal-backdrop--open');
  }
  if (errEl) {
    if (errorMessage) {
      errEl.textContent = errorMessage;
      errEl.classList.remove('hidden');
    } else {
      errEl.textContent = '';
      errEl.classList.add('hidden');
    }
  }
}

function hideAuthModal() {
  const modal = getEl('obs-auth-modal');
  const errEl = getEl('obs-auth-error');
  if (modal) {
    modal.classList.remove('modal-backdrop--open');
    modal.classList.add('hidden');
  }
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
}

function bindEmitterEvents() {
  if (appState.listenersBound) return;
  appState.listenersBound = true;

  const roomIdInput = getEl('room-id-input');
  if (roomIdInput) {
    roomIdInput.addEventListener('change', () => {
      const nextId = roomIdInput.value.trim();
      if (!nextId) {
        roomIdInput.value = appState.roomId;
        return;
      }
      if (nextId !== appState.roomId) {
        appState.roomId = persistRoomId(nextId);
        setupEmitterPeer();
        showToast(`Sala actualizada: ${appState.roomId}`);
      }
    });
  }

  const roomPasswordInput = getEl('room-password-input');
  if (roomPasswordInput) {
    roomPasswordInput.addEventListener('input', () => {
      appState.roomPassword = roomPasswordInput.value;
      saveSession({ password: appState.roomPassword });
    });
  }

  const bitrateSelect = getEl('bitrate-select');
  if (bitrateSelect) {
    bitrateSelect.addEventListener('change', async () => {
      const parsed = Number(bitrateSelect.value);
      if (Number.isFinite(parsed) && parsed > 0) {
        appState.bitrateKbps = parsed;
        saveSession({ bitrateKbps: appState.bitrateKbps });
        if (
          appState.emitterPeerController &&
          typeof appState.emitterPeerController.setMaxBitrate === 'function'
        ) {
          await appState.emitterPeerController.setMaxBitrate(appState.bitrateKbps);
        }
        showToast(`Bitrate máx. configurado: ${appState.bitrateKbps} kbps`);
      }
    });
  }

  const copyBtn = getEl('copy-obs-url-btn');
  const fallbackBox = getEl('obs-url-fallback-box');
  const fallbackInput = getEl('obs-url-fallback-input');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const obsUrl = buildObsViewerUrl(appState.roomId, appState.roomPassword);
      let copied = false;
      try {
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          await navigator.clipboard.writeText(obsUrl);
          copied = true;
        }
      } catch (_) {
        copied = false;
      }

      if (copied) {
        if (fallbackBox) fallbackBox.classList.add('hidden');
        showToast('URL para OBS copiada al portapapeles.');
      } else {
        if (fallbackInput) {
          fallbackInput.value = obsUrl;
          fallbackInput.focus();
          fallbackInput.select();
        }
        if (fallbackBox) fallbackBox.classList.remove('hidden');
        showToast('Portapapeles bloqueado: copia la URL desde el cuadro de respaldo.');
      }
    });
  }

  const resetRoomBtn = getEl('reset-room-btn');
  if (resetRoomBtn) {
    resetRoomBtn.addEventListener('click', () => {
      const generated = resolveRoomId(null, true);
      appState.roomId = persistRoomId(generated);
      if (roomIdInput) {
        roomIdInput.value = appState.roomId;
      }
      setupEmitterPeer();
      showToast(`Nueva sala generada: ${appState.roomId}`);
    });
  }

  const oledBtn = getEl('oled-mode-btn');
  if (oledBtn) {
    oledBtn.addEventListener('click', () => {
      setOledSaverActive(true);
    });
  }

  const oledSaver = getEl('oled-saver');
  if (oledSaver) {
    oledSaver.addEventListener('dblclick', () => {
      setOledSaverActive(false);
    });
  }

  const statsDetails = getEl('stats-details');
  if (statsDetails) {
    statsDetails.addEventListener('toggle', () => {
      if (statsDetails.open) {
        startStatsMonitor();
      } else {
        stopStatsMonitor();
      }
    });
  }

  const cameraSelect = getEl('camera-select');
  if (cameraSelect) {
    cameraSelect.addEventListener('change', async () => {
      const requestedDeviceId = cameraSelect.value;
      await initializeOrSwitchCamera({
        resetFresh: true,
        preferredDeviceId: requestedDeviceId,
        allowRearFallback: false,
      });
    });
  }

  const resolutionSelect = getEl('resolution-select');
  if (resolutionSelect) {
    resolutionSelect.addEventListener('change', async () => {
      appState.resolutionId = resolutionSelect.value;
      saveSession({ resolutionId: appState.resolutionId });
      updatePreviewFormatBadge();
      await initializeOrSwitchCamera({
        resetFresh: false,
        preferredDeviceId: appState.selectedDeviceId,
        allowRearFallback: false,
      });
    });
  }

  const fpsSelect = getEl('fps-select');
  if (fpsSelect) {
    fpsSelect.addEventListener('change', async () => {
      const nextFps = Number(fpsSelect.value);
      if (Number.isFinite(nextFps) && nextFps > 0) {
        appState.fps = nextFps;
        saveSession({ fps: appState.fps });
        updatePreviewFormatBadge();
        await initializeOrSwitchCamera({
          resetFresh: false,
          preferredDeviceId: appState.selectedDeviceId,
          allowRearFallback: false,
        });
      }
    });
  }

  const reapplyBtn = getEl('reapply-controls-btn');
  if (reapplyBtn) {
    reapplyBtn.addEventListener('click', async () => {
      if (!appState.track) return;
      const updated = await reapplyDesiredState(appState.track);
      if (updated) {
        appState.settings = updated;
      }
      updatePreviewFormatBadge();
      showToast('Restricciones del sensor reaplicadas.');
    });
  }

  const saveProfileBtn = getEl('save-profile-btn');
  const profileNameInput = getEl('profile-name-input');
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', () => {
      const rawName = profileNameInput ? profileNameInput.value.trim() : '';
      const name = rawName || `Perfil ${appState.profiles.length + 1}`;
      const snapshot = buildCurrentProfileSnapshot(name, {
        resolutionId: appState.resolutionId,
        fps: appState.fps,
        bitrateKbps: appState.bitrateKbps,
        sensorValues: collectCurrentNumericSensorValues(),
        modeValues: collectCurrentModeValues(),
      });
      const existingIdx = appState.profiles.findIndex((p) => p.name === name);
      if (existingIdx >= 0) {
        appState.profiles[existingIdx] = snapshot;
      } else {
        appState.profiles.push(snapshot);
      }
      saveProfilesToLocalStorage();
      refreshProfileSelectOptions(name);
      showToast(`Perfil "${name}" guardado.`);
    });
  }

  const applyProfileBtn = getEl('apply-profile-btn');
  const profileSelect = getEl('profile-select');
  if (applyProfileBtn) {
    applyProfileBtn.addEventListener('click', async () => {
      const idx = profileSelect ? Number(profileSelect.value) : -1;
      const profile = Number.isInteger(idx) && idx >= 0 ? appState.profiles[idx] : null;
      if (!profile) {
        showToast('Selecciona un perfil de la lista.');
        return;
      }

      if (typeof profile.resolutionId === 'string' && profile.resolutionId) {
        appState.resolutionId = profile.resolutionId;
        const resSelect = getEl('resolution-select');
        if (resSelect) resSelect.value = appState.resolutionId;
      }
      if (typeof profile.fps === 'number' && profile.fps > 0) {
        appState.fps = profile.fps;
        const fpsSel = getEl('fps-select');
        if (fpsSel) fpsSel.value = String(appState.fps);
      }
      if (typeof profile.bitrateKbps === 'number' && profile.bitrateKbps > 0) {
        appState.bitrateKbps = profile.bitrateKbps;
        const brSel = getEl('bitrate-select');
        if (brSel) brSel.value = String(appState.bitrateKbps);
        if (
          appState.emitterPeerController &&
          typeof appState.emitterPeerController.setMaxBitrate === 'function'
        ) {
          await appState.emitterPeerController.setMaxBitrate(appState.bitrateKbps);
        }
      }

      saveSession({
        resolutionId: appState.resolutionId,
        fps: appState.fps,
        bitrateKbps: appState.bitrateKbps,
      });

      await initializeOrSwitchCamera({
        resetFresh: false,
        preferredDeviceId: appState.selectedDeviceId,
        allowRearFallback: false,
      });

      const result = await applyProfileToActiveCamera(
        profile,
        appState.capabilities,
        appState.settings
      );
      const readBack = readTrackCapabilitiesAndSettings(appState.track);
      appState.capabilities = readBack.capabilities || appState.capabilities;
      appState.settings = readBack.settings || appState.settings;
      renderActiveSensorControls();

      showToast(`Perfil "${profile.name}" aplicado (${result.appliedCount} parámetros).`);
    });
  }

  const exportProfilesBtn = getEl('export-profiles-btn');
  if (exportProfilesBtn) {
    exportProfilesBtn.addEventListener('click', () => {
      if (appState.profiles.length === 0) {
        showToast('No hay perfiles para exportar.');
        return;
      }
      exportProfilesToJsonFile(appState.profiles);
      showToast('Perfiles exportados a archivo .json.');
    });
  }

  const importProfilesBtn = getEl('import-profiles-btn');
  const importProfilesFile = getEl('import-profiles-file');
  if (importProfilesBtn && importProfilesFile) {
    importProfilesBtn.addEventListener('click', () => {
      importProfilesFile.value = '';
      importProfilesFile.click();
    });

    importProfilesFile.addEventListener('change', async () => {
      const file =
        importProfilesFile.files && importProfilesFile.files[0]
          ? importProfilesFile.files[0]
          : null;
      if (!file) return;

      try {
        const imported = await importProfilesFromJsonFile(file);
        if (imported.length === 0) {
          showToast('El archivo .json no contiene perfiles válidos.');
          return;
        }
        for (const prof of imported) {
          const idx = appState.profiles.findIndex((p) => p.name === prof.name);
          if (idx >= 0) {
            appState.profiles[idx] = prof;
          } else {
            appState.profiles.push(prof);
          }
        }
        saveProfilesToLocalStorage();
        refreshProfileSelectOptions(imported[imported.length - 1].name);
        showToast(`Importados ${imported.length} perfil(es) sin aplicar automáticamente.`);
      } catch (err) {
        showToast(
          `Error al importar JSON: ${err && err.message ? err.message : 'archivo inválido'}`
        );
      }
    });
  }

  const resetNativeBtn = getEl('reset-native-btn');
  if (resetNativeBtn) {
    resetNativeBtn.addEventListener('click', async () => {
      const id = appState.settings.deviceId || appState.selectedDeviceId;
      const all = { ...(loadSession().sensors || {}) };
      delete all[id];
      saveSession({ sensors: all });
      await initializeOrSwitchCamera({
        resetFresh: false,
        preferredDeviceId: appState.selectedDeviceId,
        allowRearFallback: false,
      });
      showToast('Sensores restablecidos a valores nativos.');
    });
  }

  const diagBtn = getEl('diag-btn');
  if (diagBtn) diagBtn.addEventListener('click', showDiagnostics);

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      appState.wakeLockSentinel = await requestScreenWakeLock(appState.wakeLockSentinel);
      updateWakeLockBadge(
        Boolean(appState.wakeLockSentinel && !appState.wakeLockSentinel.released)
      );
      if (appState.track) {
        const updated = await reapplyDesiredState(appState.track);
        if (updated) {
          appState.settings = updated;
        }
        updatePreviewFormatBadge();
      }
    } else {
      updateWakeLockBadge(false);
    }
  });
}

export async function initApp() {
  const route = parseRouteParams(window.location.search);
  appState.mode = route.mode;

  const obsApp = getEl('obs-app');
  const emitterApp = getEl('emitter-app');

  if (route.mode === 'viewer') {
    if (emitterApp) emitterApp.classList.add('hidden');
    if (obsApp) obsApp.classList.remove('hidden');

    const targetRoomId = resolveRoomId(route.roomId, false);
    let currentPassword = route.password;

    if (!targetRoomId) {
      showAuthModal('Falta el parámetro ?id=SALA en la URL del receptor.');
      return;
    }

    const authForm = getEl('obs-auth-form');
    const authInput = getEl('obs-auth-input');
    const obsVideo = getEl('obs-video');

    if (obsVideo) {
      obsVideo.muted = true;
      obsVideo.playsInline = true;
    }

    const ensureViewerPlaying = () => {
      if (!obsVideo) return;
      if (obsVideo.paused || obsVideo.readyState < 2) {
        obsVideo.play().catch(() => {});
      }
    };

    const attachTrackListeners = (track) => {
      if (!track || track.__obsViewerBound) return;
      track.__obsViewerBound = true;
      track.addEventListener('unmute', ensureViewerPlaying);
      track.addEventListener('mute', ensureViewerPlaying);
    };

    const controller = startViewerAutoHealing({
      targetPeerId: targetRoomId,
      getPassword: () => currentPassword,
      peerConfig: getPeerConfig(),
      onStream: (remoteStream) => {
        hideAuthModal();
        if (!obsVideo || !remoteStream) return;

        if (obsVideo.srcObject !== remoteStream) {
          obsVideo.srcObject = remoteStream;
        }

        if (typeof remoteStream.getTracks === 'function') {
          remoteStream.getTracks().forEach((t) => attachTrackListeners(t));
        }

        if (typeof remoteStream.addEventListener === 'function' && !remoteStream.__obsStreamBound) {
          remoteStream.__obsStreamBound = true;
          remoteStream.addEventListener('addtrack', (ev) => {
            if (ev && ev.track) {
              attachTrackListeners(ev.track);
            }
            if (obsVideo.srcObject !== remoteStream) {
              obsVideo.srcObject = remoteStream;
            }
            ensureViewerPlaying();
          });
        }

        ensureViewerPlaying();
      },
      onAuthRequired: (reason) => {
        showAuthModal(reason || 'Introduce la contraseña de la sala.');
      },
    });

    appState.viewerController = controller;

    if (authForm) {
      authForm.addEventListener('submit', (event) => {
        event.preventDefault();
        currentPassword = authInput ? authInput.value : '';
        const errEl = getEl('obs-auth-error');
        if (errEl) {
          errEl.textContent = 'Conectando...';
          errEl.classList.remove('hidden');
        }
        controller.retryNow(currentPassword);
      });
    }

    return;
  }

  if (obsApp) obsApp.classList.add('hidden');
  if (emitterApp) emitterApp.classList.remove('hidden');

  appState.roomId = persistRoomId(resolveRoomId(route.roomId, true));

  const s = loadSession();
  appState.roomPassword = route.password ?? s.password ?? '';
  appState.resolutionId = s.resolutionId || appState.resolutionId;
  appState.fps = s.fps || appState.fps;
  appState.bitrateKbps = s.bitrateKbps || appState.bitrateKbps;
  appState.selectedDeviceId = s.deviceId || '';
  
  const roomIdInput = getEl('room-id-input');
  const roomPasswordInput = getEl('room-password-input');
  if (roomIdInput) roomIdInput.value = appState.roomId;
  if (roomPasswordInput) roomPasswordInput.value = appState.roomPassword;

  appState.profiles = loadProfilesFromLocalStorage();

  populateFormatSelectors();
  refreshProfileSelectOptions();
  bindEmitterEvents();

  await initializeOrSwitchCamera({ resetFresh: true, allowRearFallback: true });
  setupEmitterPeer();
}

export function renderSensorControls(
  capabilities,
  settings,
  onControlCommit,
  onModeToggle
) {
  const container = getEl('sensor-controls-container');
  if (!container) return;

  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const currSettings = settings && typeof settings === 'object' ? settings : {};

  const existingRows = new Map();
  Array.from(container.children).forEach((row) => {
    if (row.dataset && row.dataset.capabilityKey) {
      existingRows.set(row.dataset.capabilityKey, row);
    }
  });

  const processedKeys = new Set();

  for (const [key, cap] of Object.entries(caps)) {
    if (EXCLUDED_SENSOR_KEYS.has(key)) continue;
    if (cap === undefined || cap === null) continue;
    processedKeys.add(key);

    const isModeArray = Array.isArray(cap);
    const linkedModeKey = !isModeArray ? resolveModeKeyForCapability(key, caps) : null;
    const supportedModes = linkedModeKey && Array.isArray(caps[linkedModeKey]) ? caps[linkedModeKey] : [];

    let row = existingRows.get(key);
    let rangeInput, numberInput, boolCheckbox, selectEl;

    if (!row) {
      row = document.createElement('div');
      row.className = 'sensor-control-row';
      row.dataset.capabilityKey = key;

      const labelEl = document.createElement('span');
      labelEl.textContent = formatCapabilityLabel(key);
      row.appendChild(labelEl);
      
      const spacer = document.createElement('span');
      row.appendChild(spacer);

      if (typeof cap === 'object' && !isModeArray && typeof cap.min === 'number' && typeof cap.max === 'number') {
        const min = cap.min;
        const max = cap.max;
        const step = typeof cap.step === 'number' && cap.step > 0 ? cap.step : 1;
        const useLog = key === 'exposureTime' && min > 0 && max / min > 100;
        const posToVal = (p) => (useLog ? min * Math.pow(max / min, p / 1000) : p);
        const valToPos = (v) =>
          useLog ? (1000 * Math.log(Math.max(v, min) / min)) / Math.log(max / min) : v;

        rangeInput = document.createElement('input');
        rangeInput.type = 'range';
        rangeInput.dataset.role = 'range-input';
        rangeInput.min = useLog ? '0' : String(min);
        rangeInput.max = useLog ? '1000' : String(max);
        rangeInput.step = useLog ? '1' : String(step);
        rangeInput.__toPos = valToPos;

        numberInput = document.createElement('input');
        numberInput.type = 'number';
        numberInput.dataset.role = 'number-input';
        numberInput.min = String(min);
        numberInput.max = String(max);
        numberInput.step = String(step);

        rangeInput.addEventListener('input', () => {
          const val = clampAndStepValue(posToVal(Number(rangeInput.value)), min, max, step);
          numberInput.value = String(val);
          if (typeof onControlCommit === 'function') onControlCommit(key, val, 'range');
        });

        numberInput.addEventListener('input', () => {
          const n = Number(numberInput.value);
          if (numberInput.value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max) {
            rangeInput.value = String(valToPos(n));
          }
        });

        const commitNumberInput = () => {
          const rawNum = Number(numberInput.value);
          const fallback = posToVal(Number(rangeInput.value)) || min;
          const clamped = clampAndStepValue(Number.isFinite(rawNum) ? rawNum : fallback, min, max, step);
          numberInput.value = String(clamped);
          rangeInput.value = String(valToPos(clamped));
          if (typeof onControlCommit === 'function') onControlCommit(key, clamped, 'number');
        };
        numberInput.addEventListener('change', commitNumberInput);

        row.appendChild(rangeInput);
        row.appendChild(numberInput);
      } else if (typeof cap === 'boolean') {
        boolCheckbox = document.createElement('input');
        boolCheckbox.type = 'checkbox';
        boolCheckbox.dataset.role = 'bool-checkbox';
        boolCheckbox.addEventListener('change', () => {
          if (typeof onControlCommit === 'function') {
            onControlCommit(key, boolCheckbox.checked, 'range');
          }
        });
        row.appendChild(boolCheckbox);
        row.appendChild(document.createElement('span'));
      } else if (isModeArray) {
        selectEl = document.createElement('select');
        selectEl.dataset.role = 'select-input';
        cap.forEach((optVal) => {
          const opt = document.createElement('option');
          opt.value = String(optVal);
          opt.textContent = String(optVal);
          selectEl.appendChild(opt);
        });
        selectEl.addEventListener('change', () => {
          if (typeof onModeToggle === 'function') {
            onModeToggle(key, selectEl.value);
          } else if (typeof onControlCommit === 'function') {
            onControlCommit(key, selectEl.value, 'number');
          }
        });
        row.appendChild(selectEl);
        row.appendChild(document.createElement('span'));
      }

      container.appendChild(row);
    } else {
      rangeInput = row.querySelector('[data-role="range-input"]');
      numberInput = row.querySelector('[data-role="number-input"]');
      boolCheckbox = row.querySelector('[data-role="bool-checkbox"]');
      selectEl = row.querySelector('[data-role="select-input"]');
    }

    let isAutoActive = false;
    if (linkedModeKey && supportedModes.length > 0) {
      const currentModeVal = currSettings[linkedModeKey];
      isAutoActive = currentModeVal !== undefined && currentModeVal !== 'manual' && currentModeVal !== 'none';
    }

    if (typeof cap === 'object' && !isModeArray && typeof cap.min === 'number' && typeof cap.max === 'number') {
      const min = cap.min;
      const max = cap.max;
      const step = typeof cap.step === 'number' && cap.step > 0 ? cap.step : 1;
      const initialRaw = typeof currSettings[key] === 'number' ? currSettings[key] : min;
      const initialVal = clampAndStepValue(initialRaw, min, max, step);

      if (rangeInput && document.activeElement !== rangeInput) {
        rangeInput.value = String(rangeInput.__toPos ? rangeInput.__toPos(initialVal) : initialVal);
      }
      if (numberInput && document.activeElement !== numberInput) {
        numberInput.value = String(initialVal);
        if (key === 'exposureTime') {
          const sec = initialVal * 0.0001;
          row.children[1].textContent = sec >= 1 ? `${sec.toFixed(1)} s` : `1/${Math.round(1 / sec)} s`;
        }
      }

      const isInputsDisabled = isAutoActive || (linkedModeKey && !supportedModes.includes('manual'));
      if (rangeInput) rangeInput.disabled = isInputsDisabled;
      if (numberInput) numberInput.disabled = isInputsDisabled;
      row.classList.toggle('sensor-control-row--disabled', isInputsDisabled);
    } else if (typeof cap === 'boolean') {
      if (boolCheckbox) {
        boolCheckbox.checked = Boolean(currSettings[key]);
      }
    } else if (isModeArray) {
      if (selectEl) {
        const cur = currSettings[key];
        if (cur !== undefined && cap.map(String).includes(String(cur))) {
          selectEl.value = String(cur);
        }
      }
    }
  }

  for (const [key, row] of existingRows.entries()) {
    if (!processedKeys.has(key)) {
      row.remove();
    }
  }
}

export function buildCurrentProfileSnapshot(profileName, state = {}) {
  const safeName =
    typeof profileName === 'string' && profileName.trim() !== ''
      ? profileName.trim()
      : 'Perfil sin nombre';
  const s = state && typeof state === 'object' ? state : {};

  return {
    name: safeName,
    createdAt: new Date().toISOString(),
    resolutionId: typeof s.resolutionId === 'string' ? s.resolutionId : '720p-16x9',
    fps: typeof s.fps === 'number' && Number.isFinite(s.fps) ? s.fps : 30,
    bitrateKbps:
      typeof s.bitrateKbps === 'number' && Number.isFinite(s.bitrateKbps) ? s.bitrateKbps : 4000,
    sensorValues:
      s.sensorValues && typeof s.sensorValues === 'object' ? { ...s.sensorValues } : {},
    modeValues:
      s.modeValues && typeof s.modeValues === 'object' ? { ...s.modeValues } : {},
  };
}

export async function applyProfileToActiveCamera(profile) {
  const prof = profile && typeof profile === 'object' ? profile : {};
  const sensorValues = prof.sensorValues && typeof prof.sensorValues === 'object' ? prof.sensorValues : {};
  const modeValues = prof.modeValues && typeof prof.modeValues === 'object' ? prof.modeValues : {};
  if (!appState.track) return { appliedCount: 0 };
  const res = await restoreSensorState(appState.track, { ...modeValues, ...sensorValues });
  if (res.settings) appState.settings = res.settings;
  persistSensors();
  return { appliedCount: Object.keys(res.accepted || {}).length };
}

export function exportProfilesToJsonFile(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  const payload = JSON.stringify(
    {
      app: 'Webcam P2P Persistente para OBS Studio (v2.1)',
      exportedAt: new Date().toISOString(),
      profiles: list,
    },
    null,
    2
  );

  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'obs-p2p-webcam-perfiles.json';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

export function importProfilesFromJsonFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('No se seleccionó ningún archivo.'));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = typeof reader.result === 'string' ? reader.result : '';
        const parsed = JSON.parse(text);
        const rawProfiles = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.profiles)
          ? parsed.profiles
          : [];

        const normalized = rawProfiles
          .filter((item) => item && typeof item === 'object')
          .map((item, idx) => ({
            name:
              typeof item.name === 'string' && item.name.trim() !== ''
                ? item.name.trim()
                : `Perfil importado ${idx + 1}`,
            createdAt:
              typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
            resolutionId:
              typeof item.resolutionId === 'string' ? item.resolutionId : '720p-16x9',
            fps: typeof item.fps === 'number' && Number.isFinite(item.fps) ? item.fps : 30,
            bitrateKbps:
              typeof item.bitrateKbps === 'number' && Number.isFinite(item.bitrateKbps)
                ? item.bitrateKbps
                : 4000,
            sensorValues:
              item.sensorValues && typeof item.sensorValues === 'object'
                ? { ...item.sensorValues }
                : {},
            modeValues:
              item.modeValues && typeof item.modeValues === 'object'
                ? { ...item.modeValues }
                : {},
          }));

        resolve(normalized);
      } catch (err) {
        reject(new Error('JSON inválido o mal formado.'));
      }
    };

    reader.onerror = () => {
      reject(new Error('Error de lectura al procesar el archivo con FileReader.'));
    };

    reader.readAsText(file);
  });
}

export function setOledSaverActive(active) {
  const isActive = Boolean(active);
  const oledSaver = getEl('oled-saver');
  const localVideo = getEl('local-video');

  if (oledSaver) {
    oledSaver.classList.toggle('oled-saver--active', isActive);
    oledSaver.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  }

  if (localVideo) {
    localVideo.classList.toggle('video-oled-hidden', isActive);
  }
}

export function showToast(message, durationMs = 2800) {
  const toastEl = getEl('toast');
  if (!toastEl) return;

  if (appState.toastTimer !== null) {
    clearTimeout(appState.toastTimer);
    appState.toastTimer = null;
  }

  toastEl.textContent = String(message || '');
  toastEl.classList.remove('hidden');
  toastEl.classList.add('toast--visible');

  const ms = Math.max(800, Number(durationMs) || 2800);
  appState.toastTimer = setTimeout(() => {
    appState.toastTimer = null;
    toastEl.classList.remove('toast--visible');
    toastEl.classList.add('hidden');
  }, ms);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initApp();
    });
  } else {
    initApp();
  }
}