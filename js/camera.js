// camera.js — Captura de video, capacidades/ajustes del sensor, throttling/cola latest-wins y WakeLock.

import { clampAndStepValue } from './config.js';

// Mapa de cola por MediaStreamTrack para garantizar latest-wins y esperar promesas en curso
const trackQueueState = new WeakMap();

function getTrackQueue(track) {
  let queue = trackQueueState.get(track);
  if (!queue) {
    queue = {
      inFlight: false,
      pendingPatch: null,
      pendingThrottleMs: 100,
      timerId: null,
      waiters: []
    };
    trackQueueState.set(track, queue);
  }
  return queue;
}

function flushQueueWaiters(queue, error, result) {
  const currentWaiters = queue.waiters.splice(0, queue.waiters.length);
  for (const waiter of currentWaiters) {
    if (error) {
      waiter.reject(error);
    } else {
      waiter.resolve(result);
    }
  }
}

async function drainTrackQueue(track, queue) {
  if (!track || track.readyState === 'ended') {
    queue.inFlight = false;
    queue.pendingPatch = null;
    if (queue.timerId !== null) {
      clearTimeout(queue.timerId);
      queue.timerId = null;
    }
    flushQueueWaiters(queue, null, null);
    return;
  }

  if (queue.inFlight || !queue.pendingPatch) {
    return;
  }

  const patchToApply = queue.pendingPatch;
  queue.pendingPatch = null;
  queue.inFlight = true;

  try {
    await track.applyConstraints({ advanced: [patchToApply] });
    const latestSettings = readTrackCapabilitiesAndSettings(track).settings;
    queue.inFlight = false;

    if (queue.pendingPatch) {
      await drainTrackQueue(track, queue);
    } else {
      flushQueueWaiters(queue, null, latestSettings);
    }
  } catch (err) {
    // Respaldo: intentar aplicar restricción plana si el driver rechaza `advanced`
    try {
      await track.applyConstraints(patchToApply);
      const latestSettings = readTrackCapabilitiesAndSettings(track).settings;
      queue.inFlight = false;

      if (queue.pendingPatch) {
        await drainTrackQueue(track, queue);
      } else {
        flushQueueWaiters(queue, null, latestSettings);
      }
    } catch (fallbackErr) {
      queue.inFlight = false;
      const finalErr = fallbackErr || err;
      if (queue.pendingPatch) {
        await drainTrackQueue(track, queue);
      } else {
        flushQueueWaiters(queue, finalErr, null);
      }
    }
  }
}

function buildFallbackConstraintCandidates(options = {}) {
  const { deviceId, width, height, fps } = options;

  const videoBase = {};
  if (typeof deviceId === 'string' && deviceId.trim().length > 0) {
    videoBase.deviceId = { exact: deviceId.trim() };
  }

  const hasDims =
    typeof width === 'number' &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof height === 'number' &&
    Number.isFinite(height) &&
    height > 0;
  const hasFps = typeof fps === 'number' && Number.isFinite(fps) && fps > 0;

  const candidates = [];

  // 1. Restricciones ideales completas (resolución + fps + deviceId exacto)
  if (hasDims || hasFps || videoBase.deviceId) {
    const idealVideo = { ...videoBase };
    if (hasDims) {
      idealVideo.width = { ideal: width };
      idealVideo.height = { ideal: height };
    }
    if (hasFps) {
      idealVideo.frameRate = { ideal: fps };
    }
    candidates.push({ audio: false, video: idealVideo });
  }

  // 2. Relajar FPS manteniendo resolución y deviceId
  if (hasDims && hasFps) {
    const dimsOnlyVideo = { ...videoBase };
    dimsOnlyVideo.width = { ideal: width };
    dimsOnlyVideo.height = { ideal: height };
    candidates.push({ audio: false, video: dimsOnlyVideo });
  }

  // 3. Mantener deviceId exacto sin restricciones de resolución/FPS
  if (videoBase.deviceId) {
    candidates.push({ audio: false, video: { ...videoBase } });
  }

  // 4. Respaldo final genérico de cámara nativa
  candidates.push({ audio: false, video: true });

  return candidates;
}

export async function listVideoInputs() {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== 'function'
  ) {
    return [];
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device && device.kind === 'videoinput')
    .map((device, index) => ({
      deviceId: device.deviceId || '',
      label:
        typeof device.label === 'string' && device.label.trim().length > 0
          ? device.label.trim()
          : `Cámara ${index + 1}`,
      groupId: device.groupId || ''
    }));
}

export async function openCameraStream(options = {}) {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new Error('La API navigator.mediaDevices.getUserMedia no está disponible en este entorno.');
  }

  const candidates = buildFallbackConstraintCandidates(options);
  let lastError = null;
  let stream = null;

  for (const constraints of candidates) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (stream) {
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (!stream) {
    throw lastError || new Error('No se pudo inicializar el flujo de cámara.');
  }

  const videoTracks = stream.getVideoTracks();
  const track = videoTracks[0] || null;
  const { capabilities, settings } = readTrackCapabilitiesAndSettings(track);

  return {
    stream,
    track,
    settings,
    capabilities
  };
}

export function readTrackCapabilitiesAndSettings(track) {
  if (!track) {
    return { capabilities: {}, settings: {} };
  }

  let capabilities = {};
  let settings = {};

  try {
    if (typeof track.getCapabilities === 'function') {
      capabilities = track.getCapabilities() || {};
    }
  } catch (_err) {
    capabilities = {};
  }

  try {
    if (typeof track.getSettings === 'function') {
      settings = track.getSettings() || {};
    }
  } catch (_err) {
    settings = {};
  }

  return { capabilities, settings };
}

export function queueTrackConstraintUpdate(track, constraintPatch, throttleMs = 100) {
  if (!track || !constraintPatch || typeof constraintPatch !== 'object') {
    return Promise.resolve(null);
  }

  const clampedMs = Math.max(80, Math.min(120, Number.isFinite(Number(throttleMs)) ? Number(throttleMs) : 100));
  const queue = getTrackQueue(track);

  // Fusionar último estado deseado (latest-wins)
  queue.pendingPatch = {
    ...(queue.pendingPatch || {}),
    ...constraintPatch
  };
  queue.pendingThrottleMs = clampedMs;

  return new Promise((resolve, reject) => {
    queue.waiters.push({ resolve, reject });

    if (queue.timerId !== null) {
      return;
    }

    queue.timerId = setTimeout(() => {
      queue.timerId = null;
      drainTrackQueue(track, queue);
    }, queue.pendingThrottleMs);
  });
}

export async function syncAutoToManualConstraint(track, capabilityKey, manualModeKey, manualValue) {
  if (!track || !capabilityKey) {
    return { settings: {}, syncedValue: undefined };
  }

  const { capabilities, settings: beforeSettings } = readTrackCapabilitiesAndSettings(track);
  const modeCapKey = manualModeKey || `${capabilityKey}Mode`;
  const hasModeCap = Array.isArray(capabilities[modeCapKey]);

  const patch = {};
  if (hasModeCap && capabilities[modeCapKey].includes('manual')) {
    patch[modeCapKey] = 'manual';
  }

  // Leer valores nativos/actuales antes de aplicar valor manual para evitar saltos bruscos
  let targetValue = manualValue;
  if (typeof targetValue !== 'number' || !Number.isFinite(targetValue)) {
    const currentVal = beforeSettings[capabilityKey];
    targetValue = typeof currentVal === 'number' && Number.isFinite(currentVal) ? currentVal : undefined;
  }

  const capRange = capabilities[capabilityKey];
  if (
    typeof targetValue === 'number' &&
    Number.isFinite(targetValue) &&
    capRange &&
    typeof capRange === 'object'
  ) {
    targetValue = clampAndStepValue(targetValue, capRange.min, capRange.max, capRange.step ?? 1);
    patch[capabilityKey] = targetValue;
  } else if (typeof targetValue === 'number' && Number.isFinite(targetValue)) {
    patch[capabilityKey] = targetValue;
  }

  if (Object.keys(patch).length > 0) {
    await queueTrackConstraintUpdate(track, patch, 80);
  }

  const { settings: syncedSettings } = readTrackCapabilitiesAndSettings(track);
  const syncedValue =
    typeof syncedSettings[capabilityKey] === 'number' && Number.isFinite(syncedSettings[capabilityKey])
      ? syncedSettings[capabilityKey]
      : targetValue;

  return {
    settings: syncedSettings,
    syncedValue
  };
}

export async function reapplyCurrentTrackConstraints(track, currentSettings = {}) {
  if (!track) {
    return null;
  }

  const { capabilities, settings: liveSettings } = readTrackCapabilitiesAndSettings(track);
  const sourceValues = { ...liveSettings, ...currentSettings };
  const patch = {};

  const numericKeys = [
    'colorTemperature',
    'exposureTime',
    'iso',
    'exposureCompensation',
    'focusDistance',
    'zoom',
    'pan',
    'tilt',
    'brightness',
    'contrast',
    'saturation',
    'sharpness'
  ];

  for (const key of numericKeys) {
    const val = sourceValues[key];
    const cap = capabilities[key];
    if (typeof val === 'number' && Number.isFinite(val) && cap && typeof cap === 'object') {
      patch[key] = clampAndStepValue(val, cap.min, cap.max, cap.step ?? 1);
    }
  }

  const modePairs = [
    ['whiteBalanceMode', 'colorTemperature'],
    ['exposureMode', 'exposureTime'],
    ['focusMode', 'focusDistance']
  ];

  for (const [modeKey] of modePairs) {
    const modeVal = sourceValues[modeKey];
    const modeCap = capabilities[modeKey];
    if (typeof modeVal === 'string' && Array.isArray(modeCap) && modeCap.includes(modeVal)) {
      patch[modeKey] = modeVal;
    }
  }

  if (typeof sourceValues.torch === 'boolean' && capabilities.torch === true) {
    patch.torch = sourceValues.torch;
  }

  if (Object.keys(patch).length > 0) {
    return queueTrackConstraintUpdate(track, patch, 80);
  }

  return liveSettings;
}

export async function requestScreenWakeLock(existingSentinel = null) {
  if (existingSentinel && existingSentinel.released === false) {
    return existingSentinel;
  }

  if (
    typeof navigator === 'undefined' ||
    !navigator.wakeLock ||
    typeof navigator.wakeLock.request !== 'function'
  ) {
    return null;
  }

  try {
    return await navigator.wakeLock.request('screen');
  } catch (_err) {
    return null;
  }
}

export function stopCameraStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') {
    return;
  }

  const tracks = stream.getTracks();
  for (const track of tracks) {
    try {
      if (track && typeof track.stop === 'function') {
        track.stop();
      }
    } catch (_err) {
      // Ignorar errores al detener pistas ya finalizadas
    }
  }
}