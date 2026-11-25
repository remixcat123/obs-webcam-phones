import {
  parseRouteParams,
  resolveRoomId,
  persistRoomId,
  buildObsViewerUrl,
  getPeerConfig,
  getMediaPresets,
  clampAndStepValue,
} from './config.js';
import {
  listVideoInputs,
  openCameraStream,
  readTrackCapabilitiesAndSettings,
  queueTrackConstraintUpdate,
  syncAutoToManualConstraint,
  reapplyCurrentTrackConstraints,
  requestScreenWakeLock,
  stopCameraStream,
} from './camera.js';
import {
  createEmitterPeer,
  applySenderEncodingParams,
  replaceActiveVideoTrack,
  startViewerAutoHealing,
  collectWebRtcStats,
} from './webrtc.js';

const SENSOR_CAPABILITY_SPECS = [
  { key: 'whiteBalanceMode', label: 'Balance de blancos', modeKey: null },
  { key: 'colorTemperature', label: 'Temperatura de color', modeKey: 'whiteBalanceMode' },
  { key: 'exposureMode', label: 'Modo de exposición', modeKey: null },
  { key: 'exposureTime', label: 'Tiempo de exposición', modeKey: 'exposureMode' },
  { key: 'iso', label: 'ISO', modeKey: 'exposureMode' },
  { key: 'exposureCompensation', label: 'Compensación EV', modeKey: null },
  { key: 'focusMode', label: 'Modo de enfoque', modeKey: null },
  { key: 'focusDistance', label: 'Distancia de enfoque', modeKey: 'focusMode' },
  { key: 'zoom', label: 'Zoom', modeKey: null },
  { key: 'torch', label: 'Linterna', modeKey: null },
  { key: 'pan', label: 'Pan', modeKey: null },
  { key: 'tilt', label: 'Tilt', modeKey: null },
  { key: 'brightness', label: 'Brillo', modeKey: null },
  { key: 'contrast', label: 'Contraste', modeKey: null },
  { key: 'saturation', label: 'Saturación', modeKey: null },
  { key: 'sharpness', label: 'Nitidez', modeKey: null },
];

const MODE_CAPABILITY_KEYS = new Set(['whiteBalanceMode', 'exposureMode', 'focusMode']);

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

function collectCurrentNumericSensorValues() {
  const values = {};
  for (const spec of SENSOR_CAPABILITY_SPECS) {
    if (MODE_CAPABILITY_KEYS.has(spec.key)) continue;
    const cap = appState.capabilities ? appState.capabilities[spec.key] : null;
    if (!cap || typeof cap !== 'object') continue;
    const val = appState.settings ? appState.settings[spec.key] : undefined;
    if (typeof val === 'number' && Number.isFinite(val)) {
      values[spec.key] = val;
    }
  }
  return values;
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
  const tasks = [];
  for (const pc of appState.activePeerConnections) {
    tasks.push(replaceActiveVideoTrack(pc, newTrack));
  }
  await Promise.allSettled(tasks);
}

async function initializeOrSwitchCamera(options = {}) {
  const { resetFresh = true, preferredDeviceId = '' } = options || {};
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

    // En dispositivos móviles, liberar el stream previo antes de abrir otro lente evita bloqueos de hardware
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
    appState.capabilities = opened.capabilities || {};
    appState.settings = opened.settings || {};

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

    await refreshCameraDeviceList(appState.selectedDeviceId);
    updatePreviewFormatBadge();

    renderSensorControls(
      appState.capabilities,
      appState.settings,
      async (key, value) => {
        if (!appState.track) return;
        try {
          const updated = await queueTrackConstraintUpdate(appState.track, { [key]: value }, 100);
          if (updated) {
            appState.settings = updated;
          } else {
            const readBack = readTrackCapabilitiesAndSettings(appState.track);
            appState.settings = readBack.settings;
          }
          updatePreviewFormatBadge();
        } catch (err) {
          showToast(`No se pudo aplicar ${key}: ${err && err.message ? err.message : 'error'}`);
        }
      },
      async (key, isAuto) => {
        if (!appState.track) return;
        const targetMode = isAuto ? 'continuous' : 'manual';
        try {
          await queueTrackConstraintUpdate(appState.track, { [key]: targetMode }, 100);
          if (!isAuto) {
            const dependentSpec = SENSOR_CAPABILITY_SPECS.find((s) => s.modeKey === key);
            const capKey = dependentSpec ? dependentSpec.key : key;
            const currentVal = appState.settings ? appState.settings[capKey] : undefined;
            const synced = await syncAutoToManualConstraint(
              appState.track,
              capKey,
              key,
              currentVal
            );
            if (synced && synced.settings) {
              appState.settings = synced.settings;
            }
          } else {
            const readBack = readTrackCapabilitiesAndSettings(appState.track);
            appState.settings = readBack.settings;
          }

          renderSensorControls(
            appState.capabilities,
            appState.settings,
            async (ctrlKey, ctrlVal) => {
              if (!appState.track) return;
              const updated = await queueTrackConstraintUpdate(
                appState.track,
                { [ctrlKey]: ctrlVal },
                100
              );
              if (updated) appState.settings = updated;
            },
            async (modeKey, autoState) => {
              if (!appState.track) return;
              await queueTrackConstraintUpdate(
                appState.track,
                { [modeKey]: autoState ? 'continuous' : 'manual' },
                100
              );
              const readBack = readTrackCapabilitiesAndSettings(appState.track);
              appState.settings = readBack.settings;
            }
          );
        } catch (err) {
          showToast(`Error al cambiar modo en ${key}`);
        }
      }
    );

    if (!isExplicitLensSwitch && previousStream && previousStream !== appState.stream) {
      await propagateTrackToActivePeers(appState.track);
      stopCameraStream(previousStream);
    } else if (isExplicitLensSwitch && appState.track) {
      await propagateTrackToActivePeers(appState.track);
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

    // Si falló al cambiar de lente, conservar el ID anterior en el estado sin sobrescribirlo
    // y no revertir silenciosamente el <select> si el usuario eligió otra opción
    if (!isExplicitLensSwitch) {
      appState.selectedDeviceId = previousDeviceId;
    }

    setStatus('error', 'Error de cámara');
    showToast(
      `Error de cámara: ${err && err.message ? err.message : 'No se pudo acceder al sensor'}`
    );
  }
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
          const pc = call.peerConnection;
          appState.activePeerConnections.add(pc);
          applySenderEncodingParams(pc, appState.bitrateKbps);
          pc.addEventListener('connectionstatechange', () => {
            if (
              pc.connectionState === 'failed' ||
              pc.connectionState === 'disconnected' ||
              pc.connectionState === 'closed'
            ) {
              appState.activePeerConnections.delete(pc);
            }
          });
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

    const [firstPc] = Array.from(appState.activePeerConnections);
    if (!firstPc) {
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

    const metrics = await collectWebRtcStats(firstPc, appState.prevStatsSample);
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
    });
  }

  const bitrateSelect = getEl('bitrate-select');
  if (bitrateSelect) {
    bitrateSelect.addEventListener('change', async () => {
      const parsed = Number(bitrateSelect.value);
      if (Number.isFinite(parsed) && parsed > 0) {
        appState.bitrateKbps = parsed;
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
      });
    });
  }

  const resolutionSelect = getEl('resolution-select');
  if (resolutionSelect) {
    resolutionSelect.addEventListener('change', async () => {
      appState.resolutionId = resolutionSelect.value;
      updatePreviewFormatBadge();
      await initializeOrSwitchCamera({
        resetFresh: false,
        preferredDeviceId: appState.selectedDeviceId,
      });
    });
  }

  const fpsSelect = getEl('fps-select');
  if (fpsSelect) {
    fpsSelect.addEventListener('change', async () => {
      const nextFps = Number(fpsSelect.value);
      if (Number.isFinite(nextFps) && nextFps > 0) {
        appState.fps = nextFps;
        updatePreviewFormatBadge();
        await initializeOrSwitchCamera({
          resetFresh: false,
          preferredDeviceId: appState.selectedDeviceId,
        });
      }
    });
  }

  const reapplyBtn = getEl('reapply-controls-btn');
  if (reapplyBtn) {
    reapplyBtn.addEventListener('click', async () => {
      if (!appState.track) return;
      const updated = await reapplyCurrentTrackConstraints(appState.track, appState.settings);
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
      });
      const existingIdx = appState.profiles.findIndex((p) => p.name === name);
      if (existingIdx >= 0) {
        appState.profiles[existingIdx] = snapshot;
      } else {
        appState.profiles.push(snapshot);
      }
      refreshProfileSelectOptions(name);
      showToast(`Perfil "${name}" guardado en sesión.`);
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

      await initializeOrSwitchCamera({
        resetFresh: false,
        preferredDeviceId: appState.selectedDeviceId,
      });

      const result = await applyProfileToActiveCamera(
        profile,
        appState.capabilities,
        appState.settings
      );
      const readBack = readTrackCapabilitiesAndSettings(appState.track);
      appState.settings = readBack.settings;

      renderSensorControls(
        appState.capabilities,
        appState.settings,
        async (key, value) => {
          if (!appState.track) return;
          const updated = await queueTrackConstraintUpdate(appState.track, { [key]: value }, 100);
          if (updated) appState.settings = updated;
        },
        async (key, isAuto) => {
          if (!appState.track) return;
          await queueTrackConstraintUpdate(
            appState.track,
            { [key]: isAuto ? 'continuous' : 'manual' },
            100
          );
          const latest = readTrackCapabilitiesAndSettings(appState.track);
          appState.settings = latest.settings;
        }
      );

      const appliedCount = Object.keys(result.appliedConstraints || {}).length;
      showToast(`Perfil "${profile.name}" aplicado (${appliedCount} parámetros).`);
    });
  }

  const exportProfilesBtn = getEl('export-profiles-btn');
  if (exportProfilesBtn) {
    exportProfilesBtn.addEventListener('click', () => {
      if (appState.profiles.length === 0) {
        showToast('No hay perfiles en sesión para exportar.');
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
      await initializeOrSwitchCamera({
        resetFresh: false,
        preferredDeviceId: appState.selectedDeviceId,
      });
      showToast('Valores nativos releídos desde el hardware.');
    });
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      appState.wakeLockSentinel = await requestScreenWakeLock(appState.wakeLockSentinel);
      updateWakeLockBadge(
        Boolean(appState.wakeLockSentinel && !appState.wakeLockSentinel.released)
      );
      if (appState.track) {
        const updated = await reapplyCurrentTrackConstraints(appState.track, appState.settings);
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

    const attachTrackListeners = (track) => {
      if (!track) return;
      track.addEventListener('unmute', () => {
        if (obsVideo) {
          obsVideo.play().catch(() => {});
        }
      });
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

        if (typeof remoteStream.addEventListener === 'function') {
          remoteStream.addEventListener('addtrack', (ev) => {
            if (ev && ev.track) {
              attachTrackListeners(ev.track);
            }
            if (obsVideo.srcObject !== remoteStream) {
              obsVideo.srcObject = remoteStream;
            }
            obsVideo.play().catch(() => {});
          });
        }

        obsVideo.play().catch(() => {});
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
  appState.roomPassword = typeof route.password === 'string' ? route.password : '';

  const roomIdInput = getEl('room-id-input');
  const roomPasswordInput = getEl('room-password-input');
  if (roomIdInput) roomIdInput.value = appState.roomId;
  if (roomPasswordInput) roomPasswordInput.value = appState.roomPassword;

  populateFormatSelectors();
  refreshProfileSelectOptions();
  bindEmitterEvents();

  await initializeOrSwitchCamera({ resetFresh: true });
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

  container.innerHTML = '';

  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const currSettings = settings && typeof settings === 'object' ? settings : {};

  for (const spec of SENSOR_CAPABILITY_SPECS) {
    const cap = caps[spec.key];
    if (cap === undefined || cap === null) {
      continue;
    }

    const row = document.createElement('div');
    row.className = 'sensor-control-row';

    const labelEl = document.createElement('span');
    labelEl.textContent = spec.label;
    row.appendChild(labelEl);

    let modeCheckbox = null;
    if (spec.modeKey && Array.isArray(caps[spec.modeKey]) && caps[spec.modeKey].length > 0) {
      const modeWrapper = document.createElement('label');
      modeWrapper.style.display = 'inline-flex';
      modeWrapper.style.alignItems = 'center';
      modeWrapper.style.gap = '6px';
      modeWrapper.style.fontSize = '0.82rem';

      modeCheckbox = document.createElement('input');
      modeCheckbox.type = 'checkbox';
      const currentModeVal = currSettings[spec.modeKey];
      modeCheckbox.checked =
        currentModeVal === 'continuous' ||
        currentModeVal === 'single-shot' ||
        currentModeVal === 'auto';

      modeCheckbox.addEventListener('change', () => {
        const isAutoNow = Boolean(modeCheckbox.checked);
        row.classList.toggle('sensor-control-row--disabled', isAutoNow);
        if (typeof onModeToggle === 'function') {
          onModeToggle(spec.modeKey, isAutoNow);
        }
      });

      const modeText = document.createElement('span');
      modeText.textContent = 'Auto';

      modeWrapper.appendChild(modeCheckbox);
      modeWrapper.appendChild(modeText);
      row.appendChild(modeWrapper);
    } else {
      const spacer = document.createElement('span');
      row.appendChild(spacer);
    }

    if (typeof cap === 'object' && typeof cap.min === 'number' && typeof cap.max === 'number') {
      const min = cap.min;
      const max = cap.max;
      const step = typeof cap.step === 'number' && cap.step > 0 ? cap.step : 1;
      const initialRaw =
        typeof currSettings[spec.key] === 'number' ? currSettings[spec.key] : min;
      const initialVal = clampAndStepValue(initialRaw, min, max, step);

      const rangeInput = document.createElement('input');
      rangeInput.type = 'range';
      rangeInput.min = String(min);
      rangeInput.max = String(max);
      rangeInput.step = String(step);
      rangeInput.value = String(initialVal);

      const numberInput = document.createElement('input');
      numberInput.type = 'number';
      numberInput.min = String(min);
      numberInput.max = String(max);
      numberInput.step = String(step);
      numberInput.value = String(initialVal);

      rangeInput.addEventListener('input', () => {
        const numVal = Number(rangeInput.value);
        numberInput.value = String(numVal);
        if (typeof onControlCommit === 'function') {
          onControlCommit(spec.key, numVal, 'range');
        }
      });

      numberInput.addEventListener('input', () => {
        const partialNum = Number(numberInput.value);
        if (
          numberInput.value.trim() !== '' &&
          Number.isFinite(partialNum) &&
          partialNum >= min &&
          partialNum <= max
        ) {
          rangeInput.value = String(partialNum);
        }
      });

      const commitNumberInput = () => {
        const rawNum = Number(numberInput.value);
        const targetRaw = Number.isFinite(rawNum) ? rawNum : initialVal;
        const clamped = clampAndStepValue(targetRaw, min, max, step);
        numberInput.value = String(clamped);
        rangeInput.value = String(clamped);
        if (typeof onControlCommit === 'function') {
          onControlCommit(spec.key, clamped, 'number');
        }
      };

      numberInput.addEventListener('change', commitNumberInput);
      numberInput.addEventListener('blur', commitNumberInput);
      numberInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitNumberInput();
        }
      });

      row.appendChild(rangeInput);
      row.appendChild(numberInput);
    } else if (typeof cap === 'boolean') {
      const boolCheckbox = document.createElement('input');
      boolCheckbox.type = 'checkbox';
      boolCheckbox.checked = Boolean(currSettings[spec.key]);
      boolCheckbox.addEventListener('change', () => {
        if (typeof onControlCommit === 'function') {
          onControlCommit(spec.key, boolCheckbox.checked ? 1 : 0, 'range');
        }
      });
      row.appendChild(boolCheckbox);
      row.appendChild(document.createElement('span'));
    } else if (Array.isArray(cap)) {
      const selectEl = document.createElement('select');
      cap.forEach((optVal) => {
        const opt = document.createElement('option');
        opt.value = String(optVal);
        opt.textContent = String(optVal);
        if (String(currSettings[spec.key]) === String(optVal)) {
          opt.selected = true;
        }
        selectEl.appendChild(opt);
      });
      selectEl.addEventListener('change', () => {
        if (typeof onControlCommit === 'function') {
          onControlCommit(spec.key, selectEl.value, 'number');
        }
      });
      row.appendChild(selectEl);
      row.appendChild(document.createElement('span'));
    }

    if (modeCheckbox && modeCheckbox.checked) {
      row.classList.add('sensor-control-row--disabled');
    }

    container.appendChild(row);
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
  };
}

export async function applyProfileToActiveCamera(profile, capabilities, settings) {
  const appliedConstraints = {};
  const skippedKeys = [];

  const prof = profile && typeof profile === 'object' ? profile : {};
  const sensorValues =
    prof.sensorValues && typeof prof.sensorValues === 'object' ? prof.sensorValues : {};
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};

  for (const [key, rawVal] of Object.entries(sensorValues)) {
    const cap = caps[key];
    if (!cap || typeof cap !== 'object' || typeof cap.min !== 'number' || typeof cap.max !== 'number') {
      skippedKeys.push(key);
      continue;
    }

    const step = typeof cap.step === 'number' && cap.step > 0 ? cap.step : 1;
    const clamped = clampAndStepValue(rawVal, cap.min, cap.max, step);
    appliedConstraints[key] = clamped;
  }

  if (appState.track && Object.keys(appliedConstraints).length > 0) {
    const updated = await queueTrackConstraintUpdate(appState.track, appliedConstraints, 100);
    if (updated) {
      appState.settings = updated;
    } else if (settings && typeof settings === 'object') {
      appState.settings = { ...settings, ...appliedConstraints };
    }
  }

  return {
    appliedConstraints,
    skippedKeys,
  };
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