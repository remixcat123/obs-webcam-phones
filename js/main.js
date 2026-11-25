// main.js — Orquestador de la aplicación Webcam P2P Persistente para OBS Studio (v2.1).

import {
  parseRouteParams,
  resolveRoomId,
  persistRoomId,
  buildObsViewerUrl,
  getPeerConfig,
  getMediaPresets,
  clampAndStepValue
} from './config.js';

import {
  listVideoInputs,
  openCameraStream,
  readTrackCapabilitiesAndSettings,
  queueTrackConstraintUpdate,
  syncAutoToManualConstraint,
  reapplyCurrentTrackConstraints,
  requestScreenWakeLock,
  stopCameraStream
} from './camera.js';

import {
  createEmitterPeer,
  replaceActiveVideoTrack,
  startViewerAutoHealing,
  collectWebRtcStats
} from './webrtc.js';

const SENSOR_CONTROL_SPECS = [
  { key: 'colorTemperature', label: 'Temp. de Color (K)', modeKey: 'whiteBalanceMode' },
  { key: 'exposureTime', label: 'Tiempo Exposición', modeKey: 'exposureMode' },
  { key: 'iso', label: 'ISO', modeKey: null },
  { key: 'exposureCompensation', label: 'Compensación EV', modeKey: null },
  { key: 'focusDistance', label: 'Distancia Enfoque', modeKey: 'focusMode' },
  { key: 'zoom', label: 'Zoom', modeKey: null },
  { key: 'pan', label: 'Pan', modeKey: null },
  { key: 'tilt', label: 'Tilt', modeKey: null },
  { key: 'brightness', label: 'Brillo', modeKey: null },
  { key: 'contrast', label: 'Contraste', modeKey: null },
  { key: 'saturation', label: 'Saturación', modeKey: null },
  { key: 'sharpness', label: 'Nitidez', modeKey: null }
];

const BOOLEAN_CONTROL_SPECS = [
  { key: 'torch', label: 'Linterna (Torch)' }
];

const appState = {
  mode: 'emitter',
  roomId: '',
  roomPassword: '',
  resolutionId: '1280x720_16x9',
  fps: 30,
  bitrateKbps: 4000,
  deviceId: '',
  stream: null,
  track: null,
  capabilities: {},
  settings: {},
  emitterPeerApi: null,
  activeCalls: new Set(),
  viewerController: null,
  wakeLockSentinel: null,
  oledActive: false,
  profiles: [],
  statsTimerId: null,
  prevStatsSample: null,
  toastTimerId: null,
  initialized: false
};

function byId(id) {
  return document.getElementById(id);
}

function setEmitterStatus(statusKey, customLabel) {
  const indicator = byId('status-indicator');
  const textEl = byId('status-text');

  if (indicator) {
    indicator.classList.remove(
      'status-dot--init',
      'status-dot--ready',
      'status-dot--streaming',
      'status-dot--error'
    );
    const modifierMap = {
      initializing: 'status-dot--init',
      ready: 'status-dot--ready',
      streaming: 'status-dot--streaming',
      error: 'status-dot--error'
    };
    indicator.classList.add(modifierMap[statusKey] || 'status-dot--init');
  }

  if (textEl) {
    const defaultLabels = {
      initializing: 'Iniciando...',
      ready: 'Listo para OBS',
      streaming: 'Transmitiendo a OBS',
      error: 'Error de cámara'
    };
    textEl.textContent = customLabel || defaultLabels[statusKey] || 'Iniciando...';
  }
}

function updateWakeLockBadge() {
  const badge = byId('wakelock-badge');
  if (!badge) {
    return;
  }
  const isActive = Boolean(appState.wakeLockSentinel && appState.wakeLockSentinel.released === false);
  badge.textContent = isActive ? 'WakeLock: Activo' : 'WakeLock: Inactivo';
}

function updatePreviewFormatUI() {
  const presets = getMediaPresets().resolutions;
  const selectedPreset = presets.find((r) => r.id === appState.resolutionId) || presets[1] || presets[0];

  const settings = appState.settings || {};
  const width = settings.width || (selectedPreset ? selectedPreset.width : 1280);
  const height = settings.height || (selectedPreset ? selectedPreset.height : 720);
  const fps = typeof settings.frameRate === 'number' && Number.isFinite(settings.frameRate)
    ? Math.round(settings.frameRate)
    : appState.fps;

  const orientation =
    selectedPreset?.orientation || (height > width ? '9:16' : '16:9');

  const container = byId('preview-container');
  if (container) {
    container.setAttribute('data-orientation', orientation);
    container.classList.toggle('preview-container--landscape', orientation === '16:9');
    container.classList.toggle('preview-container--portrait', orientation === '9:16');
  }

  const badge = byId('preview-format-badge');
  if (badge) {
    badge.textContent = `${width}×${height} · ${fps} FPS`;
  }
}

function populateFormatSelects() {
  const { resolutions, fpsList, bitrateList } = getMediaPresets();

  const resSelect = byId('resolution-select');
  if (resSelect) {
    resSelect.innerHTML = '';
    for (const res of resolutions) {
      const opt = document.createElement('option');
      opt.value = res.id;
      opt.textContent = res.label;
      if (res.id === appState.resolutionId) {
        opt.selected = true;
      }
      resSelect.appendChild(opt);
    }
  }

  const fpsSelect = byId('fps-select');
  if (fpsSelect) {
    fpsSelect.innerHTML = '';
    for (const fps of fpsList) {
      const opt = document.createElement('option');
      opt.value = String(fps);
      opt.textContent = `${fps} FPS`;
      if (fps === appState.fps) {
        opt.selected = true;
      }
      fpsSelect.appendChild(opt);
    }
  }

  const bitrateSelect = byId('bitrate-select');
  if (bitrateSelect) {
    bitrateSelect.innerHTML = '';
    for (const kbps of bitrateList) {
      const opt = document.createElement('option');
      opt.value = String(kbps);
      opt.textContent = `${kbps} kbps`;
      if (kbps === appState.bitrateKbps) {
        opt.selected = true;
      }
      bitrateSelect.appendChild(opt);
    }
  }
}

async function refreshCameraDeviceList(preferredDeviceId = '') {
  const cameraSelect = byId('camera-select');
  const devices = await listVideoInputs();

  if (!cameraSelect) {
    return devices;
  }

  cameraSelect.innerHTML = '';
  for (const dev of devices) {
    const opt = document.createElement('option');
    opt.value = dev.deviceId;
    opt.textContent = dev.label;
    cameraSelect.appendChild(opt);
  }

  const activeTrackId =
    appState.settings && typeof appState.settings.deviceId === 'string'
      ? appState.settings.deviceId
      : '';
  const targetId = preferredDeviceId || activeTrackId || appState.deviceId;

  if (targetId && devices.some((d) => d.deviceId === targetId)) {
    cameraSelect.value = targetId;
    appState.deviceId = targetId;
  } else if (devices[0]) {
    cameraSelect.value = devices[0].deviceId;
    appState.deviceId = devices[0].deviceId;
  }

  return devices;
}

function getPrimaryPeerConnection() {
  for (const call of appState.activeCalls) {
    if (call && call.peerConnection) {
      return call.peerConnection;
    }
    if (call && call._pc) {
      return call._pc;
    }
  }
  return null;
}

function stopStatsLoop() {
  if (appState.statsTimerId !== null) {
    clearInterval(appState.statsTimerId);
    appState.statsTimerId = null;
  }
  appState.prevStatsSample = null;
}

async function tickStatsMonitor() {
  const details = byId('stats-details');
  if (!details || !details.open) {
    stopStatsLoop();
    return;
  }

  const pc = getPrimaryPeerConnection();
  if (!pc) {
    return;
  }

  const metrics = await collectWebRtcStats(pc, appState.prevStatsSample);
  appState.prevStatsSample = metrics.sample;

  const resEl = byId('stat-resolution');
  const fpsEl = byId('stat-fps');
  const bitrateEl = byId('stat-bitrate');
  const rttEl = byId('stat-rtt');

  if (resEl) {
    resEl.textContent = metrics.resolution;
  }
  if (fpsEl) {
    fpsEl.textContent = `${metrics.fps}`;
  }
  if (bitrateEl) {
    bitrateEl.textContent = `${metrics.bitrateKbps} kbps`;
  }
  if (rttEl) {
    rttEl.textContent = metrics.rttMs !== null && metrics.rttMs !== undefined ? `${metrics.rttMs} ms` : '—';
  }
}

function startStatsLoop() {
  stopStatsLoop();
  const details = byId('stats-details');
  if (!details || !details.open) {
    return;
  }
  tickStatsMonitor();
  appState.statsTimerId = setInterval(() => {
    tickStatsMonitor();
  }, 1000);
}

async function replaceTrackAcrossActiveCalls(newTrack) {
  if (!newTrack) {
    return;
  }
  for (const call of appState.activeCalls) {
    const pc = call?.peerConnection || call?._pc || null;
    if (pc) {
      try {
        await replaceActiveVideoTrack(pc, newTrack);
      } catch (_err) {
        // Continuar con las demás llamadas activas
      }
    }
  }
}

async function startOrSwitchCamera(overrideOptions = {}) {
  const presets = getMediaPresets().resolutions;
  const targetResId = overrideOptions.resolutionId || appState.resolutionId;
  const preset = presets.find((r) => r.id === targetResId) || presets[1] || presets[0];
  const targetFps = overrideOptions.fps || appState.fps;
  const targetDeviceId =
    overrideOptions.deviceId !== undefined ? overrideOptions.deviceId : appState.deviceId;

  appState.resolutionId = preset.id;
  appState.fps = targetFps;
  if (typeof targetDeviceId === 'string') {
    appState.deviceId = targetDeviceId;
  }

  const previousStream = appState.stream;

  try {
    const opened = await openCameraStream({
      deviceId: appState.deviceId || undefined,
      width: preset.width,
      height: preset.height,
      fps: appState.fps
    });

    appState.stream = opened.stream;
    appState.track = opened.track;
    appState.capabilities = opened.capabilities || {};
    appState.settings = opened.settings || {};

    if (typeof appState.settings.deviceId === 'string' && appState.settings.deviceId.length > 0) {
      appState.deviceId = appState.settings.deviceId;
    }

    const localVideo = byId('local-video');
    if (localVideo) {
      localVideo.srcObject = appState.stream;
      try {
        await localVideo.play();
      } catch (_playErr) {
        // Algunos navegadores requieren interacción previa o muted ya aplicado
      }
    }

    await refreshCameraDeviceList(appState.deviceId);
    updatePreviewFormatUI();

    renderSensorControls(
      appState.capabilities,
      appState.settings,
      async (key, value) => {
        if (!appState.track) {
          return;
        }
        const capRange = appState.capabilities[key];
        const clamped =
          capRange && typeof capRange === 'object'
            ? clampAndStepValue(value, capRange.min, capRange.max, capRange.step ?? 1)
            : value;
        const updatedSettings = await queueTrackConstraintUpdate(appState.track, { [key]: clamped }, 100);
        if (updatedSettings) {
          appState.settings = { ...appState.settings, ...updatedSettings, [key]: clamped };
        } else {
          appState.settings = { ...appState.settings, [key]: clamped };
        }
        updatePreviewFormatUI();
      },
      async (key, isAuto) => {
        if (!appState.track) {
          return;
        }
        const spec = SENSOR_CONTROL_SPECS.find((s) => s.key === key);
        const modeKey = spec?.modeKey || `${key}Mode`;
        const modeCap = appState.capabilities[modeKey];

        if (isAuto) {
          const autoModeVal =
            Array.isArray(modeCap) && modeCap.includes('continuous')
              ? 'continuous'
              : Array.isArray(modeCap) && modeCap.includes('auto')
              ? 'auto'
              : 'continuous';
          await queueTrackConstraintUpdate(appState.track, { [modeKey]: autoModeVal }, 80);
          const refreshed = readTrackCapabilitiesAndSettings(appState.track);
          appState.settings = { ...appState.settings, ...refreshed.settings };
          renderSensorControls(
            appState.capabilities,
            appState.settings,
            (k, v) => queueTrackConstraintUpdate(appState.track, { [k]: v }, 100),
            (k, auto) => handleModeToggleExternal(k, auto)
          );
        } else {
          const synced = await syncAutoToManualConstraint(
            appState.track,
            key,
            modeKey,
            appState.settings[key]
          );
          appState.settings = { ...appState.settings, ...synced.settings };
          renderSensorControls(
            appState.capabilities,
            appState.settings,
            (k, v) => queueTrackConstraintUpdate(appState.track, { [k]: v }, 100),
            (k, auto) => handleModeToggleExternal(k, auto)
          );
        }
      }
    );

    await replaceTrackAcrossActiveCalls(appState.track);

    if (previousStream && previousStream !== appState.stream) {
      stopCameraStream(previousStream);
    }

    if (appState.activeCalls.size > 0) {
      setEmitterStatus('streaming');
    } else {
      setEmitterStatus('ready');
    }
  } catch (err) {
    setEmitterStatus('error', 'Error de cámara');
    showToast(err?.message || 'Error al acceder a la cámara');
  }
}

async function handleModeToggleExternal(key, isAuto) {
  if (!appState.track) {
    return;
  }
  const spec = SENSOR_CONTROL_SPECS.find((s) => s.key === key);
  const modeKey = spec?.modeKey || `${key}Mode`;
  if (isAuto) {
    const modeCap = appState.capabilities[modeKey];
    const autoVal =
      Array.isArray(modeCap) && modeCap.includes('continuous') ? 'continuous' : 'auto';
    await queueTrackConstraintUpdate(appState.track, { [modeKey]: autoVal }, 80);
    appState.settings = { ...appState.settings, ...readTrackCapabilitiesAndSettings(appState.track).settings };
  } else {
    const synced = await syncAutoToManualConstraint(appState.track, key, modeKey, appState.settings[key]);
    appState.settings = { ...appState.settings, ...synced.settings };
  }
}

function initEmitterPeer() {
  if (appState.emitterPeerApi && typeof appState.emitterPeerApi.destroy === 'function') {
    appState.emitterPeerApi.destroy();
    appState.emitterPeerApi = null;
  }
  appState.activeCalls.clear();

  setEmitterStatus('initializing');

  appState.emitterPeerApi = createEmitterPeer({
    roomId: appState.roomId,
    getPassword: () => appState.roomPassword,
    getStream: () => appState.stream,
    bitrateKbps: appState.bitrateKbps,
    peerConfig: getPeerConfig(),
    onIncomingCall: (call) => {
      appState.activeCalls.add(call);
      call.on('close', () => {
        appState.activeCalls.delete(call);
        if (appState.activeCalls.size === 0) {
          stopStatsLoop();
          if (appState.track) {
            setEmitterStatus('ready');
          }
        }
      });
      call.on('error', () => {
        appState.activeCalls.delete(call);
        if (appState.activeCalls.size === 0) {
          stopStatsLoop();
        }
      });
    },
    onStatusChange: (status) => {
      if (status === 'initializing') {
        setEmitterStatus('initializing');
      } else if (status === 'ready') {
        setEmitterStatus('ready');
      } else if (status === 'streaming') {
        setEmitterStatus('streaming');
      } else if (status === 'error') {
        setEmitterStatus('error');
      }
    },
    onError: (err) => {
      if (err && String(err.message || '').toLowerCase().includes('contraseña')) {
        showToast('Se rechazó una conexión por contraseña inválida');
      }
    }
  });
}

function renderProfileSelect() {
  const select = byId('profile-select');
  if (!select) {
    return;
  }
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent =
    appState.profiles.length > 0 ? 'Selecciona un perfil...' : 'Sin perfiles cargados';
  select.appendChild(placeholder);

  appState.profiles.forEach((prof, index) => {
    const opt = document.createElement('option');
    opt.value = String(index);
    opt.textContent = prof.name || `Perfil ${index + 1}`;
    select.appendChild(opt);
  });
}

function bindEmitterEvents() {
  const roomIdInput = byId('room-id-input');
  if (roomIdInput) {
    roomIdInput.value = appState.roomId;
    roomIdInput.addEventListener('change', () => {
      const nextId = persistRoomId(roomIdInput.value);
      appState.roomId = nextId;
      roomIdInput.value = nextId;
      initEmitterPeer();
      showToast(`Sala actualizada: ${nextId}`);
    });
  }

  const roomPassInput = byId('room-password-input');
  if (roomPassInput) {
    roomPassInput.value = appState.roomPassword;
    roomPassInput.addEventListener('input', () => {
      appState.roomPassword = roomPassInput.value;
    });
  }

  const bitrateSelect = byId('bitrate-select');
  if (bitrateSelect) {
    bitrateSelect.addEventListener('change', async () => {
      const kbps = Number(bitrateSelect.value);
      if (Number.isFinite(kbps) && kbps > 0) {
        appState.bitrateKbps = kbps;
        if (appState.emitterPeerApi && typeof appState.emitterPeerApi.setMaxBitrate === 'function') {
          await appState.emitterPeerApi.setMaxBitrate(kbps);
        }
        showToast(`Bitrate máximo ajustado a ${kbps} kbps`);
      }
    });
  }

  const copyBtn = byId('copy-obs-url-btn');
  const fallbackBox = byId('obs-url-fallback-box');
  const fallbackInput = byId('obs-url-fallback-input');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const url = buildObsViewerUrl(appState.roomId, appState.roomPassword);
      let copied = false;

      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch (_clipErr) {
          copied = false;
        }
      }

      if (copied) {
        if (fallbackBox) {
          fallbackBox.classList.add('hidden');
        }
        showToast('URL para OBS copiada al portapapeles');
      } else {
        if (fallbackBox) {
          fallbackBox.classList.remove('hidden');
        }
        if (fallbackInput) {
          fallbackInput.value = url;
          fallbackInput.focus();
          fallbackInput.select();
        }
        showToast('Copia la URL manualmente desde el campo de respaldo');
      }
    });
  }

  const resetRoomBtn = byId('reset-room-btn');
  if (resetRoomBtn) {
    resetRoomBtn.addEventListener('click', () => {
      const freshId = persistRoomId('');
      appState.roomId = freshId;
      if (roomIdInput) {
        roomIdInput.value = freshId;
      }
      initEmitterPeer();
      showToast(`Nueva sala generada: ${freshId}`);
    });
  }

  const oledBtn = byId('oled-mode-btn');
  const oledSaver = byId('oled-saver');
  if (oledBtn) {
    oledBtn.addEventListener('click', () => {
      setOledSaverActive(true);
    });
  }
  if (oledSaver) {
    oledSaver.addEventListener('dblclick', () => {
      setOledSaverActive(false);
    });
  }

  const statsDetails = byId('stats-details');
  if (statsDetails) {
    statsDetails.addEventListener('toggle', () => {
      if (statsDetails.open) {
        startStatsLoop();
      } else {
        stopStatsLoop();
      }
    });
  }

  const cameraSelect = byId('camera-select');
  if (cameraSelect) {
    cameraSelect.addEventListener('change', async () => {
      await startOrSwitchCamera({ deviceId: cameraSelect.value });
    });
  }

  const resolutionSelect = byId('resolution-select');
  if (resolutionSelect) {
    resolutionSelect.addEventListener('change', async () => {
      await startOrSwitchCamera({ resolutionId: resolutionSelect.value });
    });
  }

  const fpsSelect = byId('fps-select');
  if (fpsSelect) {
    fpsSelect.addEventListener('change', async () => {
      await startOrSwitchCamera({ fps: Number(fpsSelect.value) });
    });
  }

  const reapplyBtn = byId('reapply-controls-btn');
  if (reapplyBtn) {
    reapplyBtn.addEventListener('click', async () => {
      if (!appState.track) {
        return;
      }
      const updated = await reapplyCurrentTrackConstraints(appState.track, appState.settings);
      if (updated) {
        appState.settings = { ...appState.settings, ...updated };
      }
      showToast('Controles reaplicados al sensor');
    });
  }

  const resetNativeBtn = byId('reset-native-btn');
  if (resetNativeBtn) {
    resetNativeBtn.addEventListener('click', async () => {
      await startOrSwitchCamera({
        deviceId: appState.deviceId,
        resolutionId: appState.resolutionId,
        fps: appState.fps
      });
      showToast('Valores nativos releídos desde el hardware');
    });
  }

  const saveProfileBtn = byId('save-profile-btn');
  const profileNameInput = byId('profile-name-input');
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', () => {
      const rawName = profileNameInput ? profileNameInput.value.trim() : '';
      const name = rawName || `Perfil ${appState.profiles.length + 1}`;
      const snapshot = buildCurrentProfileSnapshot(name, {
        resolutionId: appState.resolutionId,
        fps: appState.fps,
        bitrateKbps: appState.bitrateKbps,
        sensorValues: { ...appState.settings }
      });
      appState.profiles.push(snapshot);
      if (profileNameInput) {
        profileNameInput.value = '';
      }
      renderProfileSelect();
      showToast(`Perfil "${name}" guardado en sesión`);
    });
  }

  const applyProfileBtn = byId('apply-profile-btn');
  const profileSelect = byId('profile-select');
  if (applyProfileBtn && profileSelect) {
    applyProfileBtn.addEventListener('click', async () => {
      const idx = Number(profileSelect.value);
      const selected = Number.isInteger(idx) && idx >= 0 ? appState.profiles[idx] : null;
      if (!selected) {
        showToast('Selecciona un perfil para aplicar');
        return;
      }

      if (selected.bitrateKbps && bitrateSelect) {
        appState.bitrateKbps = Number(selected.bitrateKbps);
        bitrateSelect.value = String(appState.bitrateKbps);
        if (appState.emitterPeerApi && typeof appState.emitterPeerApi.setMaxBitrate === 'function') {
          await appState.emitterPeerApi.setMaxBitrate(appState.bitrateKbps);
        }
      }

      const result = await applyProfileToActiveCamera(
        selected,
        appState.capabilities,
        appState.settings
      );
      appState.settings = { ...appState.settings, ...result.appliedConstraints };
      renderSensorControls(
        appState.capabilities,
        appState.settings,
        (k, v) => queueTrackConstraintUpdate(appState.track, { [k]: v }, 100),
        (k, isAuto) => handleModeToggleExternal(k, isAuto)
      );
      showToast(`Perfil "${selected.name}" aplicado`);
    });
  }

  const exportProfilesBtn = byId('export-profiles-btn');
  if (exportProfilesBtn) {
    exportProfilesBtn.addEventListener('click', () => {
      exportProfilesToJsonFile(appState.profiles);
      showToast('Perfiles exportados a archivo .json');
    });
  }

  const importProfilesBtn = byId('import-profiles-btn');
  const importProfilesFile = byId('import-profiles-file');
  if (importProfilesBtn && importProfilesFile) {
    importProfilesBtn.addEventListener('click', () => {
      importProfilesFile.value = '';
      importProfilesFile.click();
    });

    importProfilesFile.addEventListener('change', async () => {
      const file = importProfilesFile.files && importProfilesFile.files[0];
      if (!file) {
        return;
      }
      try {
        const imported = await importProfilesFromJsonFile(file);
        appState.profiles = [...appState.profiles, ...imported];
        renderProfileSelect();
        showToast(`Se importaron ${imported.length} perfil(es)`);
      } catch (err) {
        showToast(err?.message || 'Error al importar el archivo JSON');
      }
    });
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      appState.wakeLockSentinel = await requestScreenWakeLock(appState.wakeLockSentinel);
      updateWakeLockBadge();

      if (appState.track && appState.track.readyState === 'live') {
        const refreshed = await reapplyCurrentTrackConstraints(appState.track, appState.settings);
        if (refreshed) {
          appState.settings = { ...appState.settings, ...refreshed };
        }
      }
    }
  });
}

function initViewerMode(routeParams) {
  const obsApp = byId('obs-app');
  const emitterApp = byId('emitter-app');
  const obsVideo = byId('obs-video');
  const authModal = byId('obs-auth-modal');
  const authForm = byId('obs-auth-form');
  const authInput = byId('obs-auth-input');
  const authError = byId('obs-auth-error');

  if (obsApp) {
    obsApp.classList.remove('hidden');
  }
  if (emitterApp) {
    emitterApp.classList.add('hidden');
  }

  let currentPassword = routeParams.password || '';
  const targetRoomId = resolveRoomId(routeParams.roomId, false);

  const showAuthModal = (message) => {
    if (authModal) {
      authModal.classList.remove('hidden');
      authModal.classList.add('modal-backdrop--open');
    }
    if (authError) {
      authError.textContent = message || 'Contraseña requerida para conectar a la sala.';
      authError.classList.remove('hidden');
    }
    if (authInput) {
      authInput.focus();
    }
  };

  const hideAuthModal = () => {
    if (authModal) {
      authModal.classList.add('hidden');
      authModal.classList.remove('modal-backdrop--open');
    }
    if (authError) {
      authError.textContent = '';
      authError.classList.add('hidden');
    }
  };

  if (authForm) {
    authForm.addEventListener('submit', (event) => {
      event.preventDefault();
      currentPassword = authInput ? authInput.value : '';
      hideAuthModal();
      if (appState.viewerController && typeof appState.viewerController.retryNow === 'function') {
        appState.viewerController.retryNow(currentPassword);
      }
    });
  }

  if (!targetRoomId) {
    showAuthModal('Falta el parámetro id en la URL del receptor (?view&id=SALA).');
    return;
  }

  appState.viewerController = startViewerAutoHealing({
    targetPeerId: targetRoomId,
    getPassword: () => currentPassword,
    peerConfig: getPeerConfig(),
    retryIntervalMs: 2500,
    onStream: (remoteStream) => {
      hideAuthModal();
      if (obsVideo) {
        obsVideo.srcObject = remoteStream;
        obsVideo.play().catch(() => {
          // Reproducción automática manejada por OBS / navegador
        });
      }
    },
    onAuthRequired: (reason) => {
      showAuthModal(reason || 'Ingresa la contraseña de la sala.');
    }
  });
}

async function initEmitterMode(routeParams) {
  const obsApp = byId('obs-app');
  const emitterApp = byId('emitter-app');

  if (obsApp) {
    obsApp.classList.add('hidden');
  }
  if (emitterApp) {
    emitterApp.classList.remove('hidden');
  }

  appState.roomId = resolveRoomId(routeParams.roomId, true);
  appState.roomPassword = routeParams.password || '';

  populateFormatSelects();
  renderProfileSelect();
  bindEmitterEvents();

  appState.wakeLockSentinel = await requestScreenWakeLock(appState.wakeLockSentinel);
  updateWakeLockBadge();

  await startOrSwitchCamera({
    resolutionId: appState.resolutionId,
    fps: appState.fps
  });

  initEmitterPeer();
}

export async function initApp() {
  if (appState.initialized) {
    return;
  }
  appState.initialized = true;

  const routeParams = parseRouteParams(window.location.search);
  appState.mode = routeParams.mode;

  if (routeParams.mode === 'viewer') {
    initViewerMode(routeParams);
  } else {
    await initEmitterMode(routeParams);
  }
}

export function renderSensorControls(capabilities, settings, onControlCommit, onModeToggle) {
  const container = byId('sensor-controls-container');
  if (!container) {
    return;
  }

  container.innerHTML = '';
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const current = settings && typeof settings === 'object' ? settings : {};

  let renderedCount = 0;

  for (const spec of SENSOR_CONTROL_SPECS) {
    const cap = caps[spec.key];
    if (!cap || typeof cap !== 'object') {
      continue;
    }

    const min = typeof cap.min === 'number' && Number.isFinite(cap.min) ? cap.min : 0;
    const max = typeof cap.max === 'number' && Number.isFinite(cap.max) ? cap.max : min + 100;
    const step = typeof cap.step === 'number' && Number.isFinite(cap.step) && cap.step > 0 ? cap.step : 1;

    const initialRaw =
      typeof current[spec.key] === 'number' && Number.isFinite(current[spec.key])
        ? current[spec.key]
        : min;
    const initialVal = clampAndStepValue(initialRaw, min, max, step);

    const modeKey = spec.modeKey || `${spec.key}Mode`;
    const modeCap = caps[modeKey];
    const hasAutoCapability = Array.isArray(modeCap) && modeCap.length > 0;
    const activeMode = typeof current[modeKey] === 'string' ? current[modeKey] : '';
    const isAutoActive = hasAutoCapability && activeMode !== 'manual';

    const row = document.createElement('div');
    row.className = 'sensor-control-row';
    if (isAutoActive) {
      row.classList.add('sensor-control-row--disabled');
    }

    const labelEl = document.createElement('span');
    labelEl.textContent = spec.label;
    row.appendChild(labelEl);

    if (hasAutoCapability) {
      const autoLabel = document.createElement('label');
      autoLabel.style.display = 'inline-flex';
      autoLabel.style.alignItems = 'center';
      autoLabel.style.gap = '0.35rem';
      autoLabel.style.fontSize = '0.82rem';
      autoLabel.style.pointerEvents = 'auto';

      const autoCheckbox = document.createElement('input');
      autoCheckbox.type = 'checkbox';
      autoCheckbox.checked = isAutoActive;
      autoCheckbox.addEventListener('change', () => {
        if (typeof onModeToggle === 'function') {
          onModeToggle(spec.key, autoCheckbox.checked);
        }
      });

      const autoSpan = document.createElement('span');
      autoSpan.textContent = 'Auto';

      autoLabel.appendChild(autoCheckbox);
      autoLabel.appendChild(autoSpan);
      row.appendChild(autoLabel);
    } else {
      const spacer = document.createElement('span');
      row.appendChild(spacer);
    }

    const rangeInput = document.createElement('input');
    rangeInput.type = 'range';
    rangeInput.min = String(min);
    rangeInput.max = String(max);
    rangeInput.step = String(step);
    rangeInput.value = String(initialVal);
    rangeInput.disabled = isAutoActive;

    const numberInput = document.createElement('input');
    numberInput.type = 'number';
    numberInput.min = String(min);
    numberInput.max = String(max);
    numberInput.step = String(step);
    numberInput.value = String(initialVal);
    numberInput.disabled = isAutoActive;

    // Interacción desde el slider: actualiza número de inmediato, envía a cámara con throttling/cola
    rangeInput.addEventListener('input', () => {
      const parsed = Number(rangeInput.value);
      if (!Number.isFinite(parsed)) {
        return;
      }
      numberInput.value = String(parsed);
      if (typeof onControlCommit === 'function') {
        onControlCommit(spec.key, parsed, 'range');
      }
    });

    // Interacción desde el campo numérico: actualiza slider si válido al escribir; valida y aplica al confirmar
    numberInput.addEventListener('input', () => {
      const raw = numberInput.value.trim();
      if (raw === '' || raw === '-' || raw === '.') {
        return;
      }
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
        rangeInput.value = String(parsed);
      }
    });

    const commitNumberInput = () => {
      const normalized = clampAndStepValue(numberInput.value, min, max, step);
      numberInput.value = String(normalized);
      rangeInput.value = String(normalized);
      if (typeof onControlCommit === 'function') {
        onControlCommit(spec.key, normalized, 'number');
      }
    };

    numberInput.addEventListener('change', commitNumberInput);
    numberInput.addEventListener('blur', commitNumberInput);
    numberInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitNumberInput();
      }
    });

    row.appendChild(rangeInput);
    row.appendChild(numberInput);
    container.appendChild(row);
    renderedCount += 1;
  }

  for (const boolSpec of BOOLEAN_CONTROL_SPECS) {
    if (caps[boolSpec.key] !== true) {
      continue;
    }

    const row = document.createElement('div');
    row.className = 'sensor-control-row';

    const labelEl = document.createElement('span');
    labelEl.textContent = boolSpec.label;
    row.appendChild(labelEl);

    const toggleLabel = document.createElement('label');
    toggleLabel.style.display = 'inline-flex';
    toggleLabel.style.alignItems = 'center';
    toggleLabel.style.gap = '0.4rem';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(current[boolSpec.key]);
    checkbox.addEventListener('change', () => {
      if (typeof onControlCommit === 'function') {
        onControlCommit(boolSpec.key, checkbox.checked, 'range');
      }
    });

    const stateText = document.createElement('span');
    stateText.textContent = checkbox.checked ? 'Encendida' : 'Apagada';

    toggleLabel.appendChild(checkbox);
    toggleLabel.appendChild(stateText);
    row.appendChild(toggleLabel);

    container.appendChild(row);
    renderedCount += 1;
  }

  if (renderedCount === 0) {
    const emptyMsg = document.createElement('p');
    emptyMsg.textContent = 'El sensor o navegador actual no expone controles manuales adicionales.';
    emptyMsg.style.color = 'var(--text-secondary)';
    emptyMsg.style.margin = '0';
    container.appendChild(emptyMsg);
  }
}

export function buildCurrentProfileSnapshot(profileName, state = {}) {
  const cleanName =
    typeof profileName === 'string' && profileName.trim().length > 0
      ? profileName.trim()
      : 'Perfil sin nombre';

  return {
    name: cleanName,
    createdAt: new Date().toISOString(),
    resolutionId: state.resolutionId || appState.resolutionId,
    fps: Number(state.fps) || appState.fps,
    bitrateKbps: Number(state.bitrateKbps) || appState.bitrateKbps,
    sensorValues: state.sensorValues && typeof state.sensorValues === 'object' ? { ...state.sensorValues } : {}
  };
}

export async function applyProfileToActiveCamera(profile, capabilities, settings) {
  const appliedConstraints = {};
  const skippedKeys = [];

  if (!profile || typeof profile !== 'object') {
    return { appliedConstraints, skippedKeys };
  }

  const caps = capabilities && typeof capabilities === 'object' ? capabilities : appState.capabilities || {};
  const sourceValues =
    profile.sensorValues && typeof profile.sensorValues === 'object' ? profile.sensorValues : {};

  for (const spec of SENSOR_CONTROL_SPECS) {
    const key = spec.key;
    if (!(key in sourceValues)) {
      continue;
    }

    const cap = caps[key];
    if (!cap || typeof cap !== 'object') {
      skippedKeys.push(key);
      continue;
    }

    const rawVal = Number(sourceValues[key]);
    if (!Number.isFinite(rawVal)) {
      skippedKeys.push(key);
      continue;
    }

    const min = typeof cap.min === 'number' && Number.isFinite(cap.min) ? cap.min : rawVal;
    const max = typeof cap.max === 'number' && Number.isFinite(cap.max) ? cap.max : rawVal;
    const step = typeof cap.step === 'number' && Number.isFinite(cap.step) && cap.step > 0 ? cap.step : 1;

    const clamped = clampAndStepValue(rawVal, min, max, step);
    appliedConstraints[key] = clamped;

    const modeKey = spec.modeKey || `${key}Mode`;
    if (Array.isArray(caps[modeKey]) && caps[modeKey].includes('manual')) {
      appliedConstraints[modeKey] = 'manual';
    }
  }

  for (const boolSpec of BOOLEAN_CONTROL_SPECS) {
    if (!(boolSpec.key in sourceValues)) {
      continue;
    }
    if (caps[boolSpec.key] === true) {
      appliedConstraints[boolSpec.key] = Boolean(sourceValues[boolSpec.key]);
    } else {
      skippedKeys.push(boolSpec.key);
    }
  }

  if (appState.track && Object.keys(appliedConstraints).length > 0) {
    await queueTrackConstraintUpdate(appState.track, appliedConstraints, 80);
  }

  return {
    appliedConstraints: { ...(settings || {}), ...appliedConstraints },
    skippedKeys
  };
}

export function exportProfilesToJsonFile(profiles) {
  const payload = {
    app: 'obs-p2p-webcam',
    version: '2.1',
    exportedAt: new Date().toISOString(),
    profiles: Array.isArray(profiles) ? profiles : []
  };

  const jsonString = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = 'obs-p2p-webcam-perfiles.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}

export function importProfilesFromJsonFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || typeof FileReader === 'undefined') {
      reject(new Error('No se puede leer el archivo seleccionado.'));
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      try {
        const text = typeof reader.result === 'string' ? reader.result : '';
        const parsed = JSON.parse(text);
        const rawList = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.profiles)
          ? parsed.profiles
          : null;

        if (!rawList) {
          reject(new Error('El archivo JSON no contiene una lista válida de perfiles.'));
          return;
        }

        const normalized = rawList
          .filter((item) => item && typeof item === 'object')
          .map((item, idx) => ({
            name:
              typeof item.name === 'string' && item.name.trim().length > 0
                ? item.name.trim()
                : `Perfil importado ${idx + 1}`,
            createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
            resolutionId: typeof item.resolutionId === 'string' ? item.resolutionId : appState.resolutionId,
            fps: Number.isFinite(Number(item.fps)) ? Number(item.fps) : appState.fps,
            bitrateKbps: Number.isFinite(Number(item.bitrateKbps)) ? Number(item.bitrateKbps) : appState.bitrateKbps,
            sensorValues:
              item.sensorValues && typeof item.sensorValues === 'object'
                ? { ...item.sensorValues }
                : {}
          }));

        resolve(normalized);
      } catch (_err) {
        reject(new Error('JSON inválido o corrupto.'));
      }
    };

    reader.onerror = () => {
      reject(new Error('Error al leer el archivo con FileReader.'));
    };

    reader.readAsText(file, 'utf-8');
  });
}

export function setOledSaverActive(active) {
  const isActive = Boolean(active);
  appState.oledActive = isActive;

  const oledSaver = byId('oled-saver');
  if (oledSaver) {
    oledSaver.classList.toggle('hidden', !isActive);
    oledSaver.classList.toggle('oled-saver--active', isActive);
    oledSaver.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  }

  const localVideo = byId('local-video');
  if (localVideo) {
    localVideo.classList.toggle('video-oled-hidden', isActive);
  }

  if (isActive) {
    showToast('Modo OLED activo — doble toque para salir');
  }
}

export function showToast(message, durationMs = 2800) {
  const toastEl = byId('toast');
  if (!toastEl) {
    return;
  }

  if (appState.toastTimerId !== null) {
    clearTimeout(appState.toastTimerId);
    appState.toastTimerId = null;
  }

  toastEl.textContent = String(message || '');
  toastEl.classList.add('toast--visible');

  appState.toastTimerId = setTimeout(() => {
    toastEl.classList.remove('toast--visible');
    appState.toastTimerId = null;
  }, Math.max(800, Number(durationMs) || 2800));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initApp();
  });
} else {
  initApp();
}