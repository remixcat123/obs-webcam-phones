import { clampAndStepValue } from './config.js';

const trackQueues = new WeakMap();

function getOrCreateTrackQueue(track) {
  let queueState = trackQueues.get(track);
  if (!queueState) {
    queueState = {
      inFlight: null,
      pendingPatch: null,
      pendingWaiters: [],
      throttleTimer: null,
      lastDispatchTime: 0,
    };
    trackQueues.set(track, queueState);
  }
  return queueState;
}

function buildVideoConstraintCandidate(options = {}, tier = 0, hasExplicitDevice = false) {
  const { deviceId, width, height, fps } = options;
  const video = {};

  if (hasExplicitDevice) {
    video.deviceId = { exact: deviceId.trim() };
  } else if (tier === 0 || tier === 1) {
    video.facingMode = { ideal: 'environment' };
  }

  const hasWidth = typeof width === 'number' && Number.isFinite(width) && width > 0;
  const hasHeight = typeof height === 'number' && Number.isFinite(height) && height > 0;
  const hasFps = typeof fps === 'number' && Number.isFinite(fps) && fps > 0;

  if (tier === 0) {
    if (hasWidth) video.width = { ideal: width };
    if (hasHeight) video.height = { ideal: height };
    if (hasFps) video.frameRate = { ideal: fps };
  } else if (tier === 1) {
    if (hasWidth) video.width = { ideal: width };
    if (hasHeight) video.height = { ideal: height };
    if (hasFps) video.frameRate = { ideal: Math.min(fps, 30) };
  } else if (tier === 2) {
    if (hasWidth) video.width = { ideal: Math.min(width, 1280) };
    if (hasHeight) video.height = { ideal: Math.min(height, 720) };
    if (hasFps) video.frameRate = { ideal: Math.min(fps, 30) };
  } else if (tier === 3) {
    video.width = { ideal: 1280 };
    video.height = { ideal: 720 };
  } else if (tier === 4) {
    // Intento suave conservando deviceId exacto (si aplica) sin restricciones de resolución/FPS
  } else {
    // Respaldo final mínimo: solo permitido cuando no se solicitó un deviceId específico
    return hasExplicitDevice ? video : true;
  }

  return Object.keys(video).length > 0 ? video : true;
}

function sanitizeConstraintPatchForTrack(track, patch) {
  if (!patch || typeof patch !== 'object') {
    return {};
  }

  const caps =
    typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
  const cleaned = {};

  for (const [key, rawValue] of Object.entries(patch)) {
    if (rawValue === undefined) continue;

    if (typeof rawValue === 'number' && caps && typeof caps[key] === 'object' && caps[key] !== null) {
      const hasMin = typeof caps[key].min === 'number';
      const hasMax = typeof caps[key].max === 'number';
      const step = typeof caps[key].step === 'number' && caps[key].step > 0 ? caps[key].step : 1;

      if (hasMin || hasMax) {
        cleaned[key] = clampAndStepValue(
          rawValue,
          hasMin ? caps[key].min : -Infinity,
          hasMax ? caps[key].max : Infinity,
          step
        );
        continue;
      }
    }

    cleaned[key] = rawValue;
  }

  return cleaned;
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
        device.label && device.label.trim() !== ''
          ? device.label.trim()
          : `Cámara ${index + 1}`,
      groupId: device.groupId || '',
    }));
}

export async function openCameraStream(options = {}) {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new Error('getUserMedia no está disponible en este entorno o contexto seguro.');
  }

  const opts = options && typeof options === 'object' ? options : {};
  const hasExplicitDevice =
    typeof opts.deviceId === 'string' && opts.deviceId.trim() !== '';
  const maxTier = hasExplicitDevice ? 4 : 5;

  let lastError = null;
  let stream = null;

  for (let tier = 0; tier <= maxTier; tier += 1) {
    const videoConstraint = buildVideoConstraintCandidate(opts, tier, hasExplicitDevice);
    const constraints = {
      audio: false,
      video: videoConstraint,
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!stream) {
    const baseMsg =
      lastError && lastError.message
        ? lastError.message
        : 'No se pudo inicializar el flujo de cámara.';
    const wrappedError = new Error(
      hasExplicitDevice
        ? `No se pudo abrir la cámara solicitada (${opts.deviceId.trim()}): ${baseMsg}`
        : baseMsg
    );
    wrappedError.name = lastError && lastError.name ? lastError.name : 'OverconstrainedError';
    wrappedError.cause = lastError;
    throw wrappedError;
  }

  const [track] = stream.getVideoTracks();
  if (!track) {
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (_) {}
    });
    throw new Error('El MediaStream obtenido no contiene pista de video.');
  }

  const { capabilities, settings } = readTrackCapabilitiesAndSettings(track);

  return {
    stream,
    track,
    settings,
    capabilities,
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
  } catch (_) {
    capabilities = {};
  }

  try {
    if (typeof track.getSettings === 'function') {
      settings = track.getSettings() || {};
    }
  } catch (_) {
    settings = {};
  }

  return { capabilities, settings };
}

export function queueTrackConstraintUpdate(track, constraintPatch, throttleMs = 100) {
  if (!track || typeof track.applyConstraints !== 'function') {
    return Promise.resolve(null);
  }

  const clampedThrottle = Math.min(Math.max(Number(throttleMs) || 100, 80), 120);
  const queueState = getOrCreateTrackQueue(track);

  return new Promise((resolve, reject) => {
    const sanitizedPatch = sanitizeConstraintPatchForTrack(track, constraintPatch);
    queueState.pendingPatch = {
      ...(queueState.pendingPatch || {}),
      ...sanitizedPatch,
    };
    queueState.pendingWaiters.push({ resolve, reject });

    const flushLatest = async () => {
      if (queueState.inFlight) {
        return;
      }

      const patchToApply = queueState.pendingPatch;
      const waiters = queueState.pendingWaiters.splice(0, queueState.pendingWaiters.length);
      queueState.pendingPatch = null;

      if (!patchToApply || Object.keys(patchToApply).length === 0) {
        const latestSettings =
          typeof track.getSettings === 'function' ? track.getSettings() : null;
        waiters.forEach((w) => w.resolve(latestSettings));
        return;
      }

      queueState.lastDispatchTime = Date.now();
      queueState.inFlight = (async () => {
        try {
          await track.applyConstraints({ advanced: [patchToApply] });
        } catch (_) {
          await track.applyConstraints(patchToApply);
        }
        return typeof track.getSettings === 'function' ? track.getSettings() : null;
      })();

      try {
        const updatedSettings = await queueState.inFlight;
        waiters.forEach((w) => w.resolve(updatedSettings));
      } catch (err) {
        waiters.forEach((w) => w.reject(err));
      } finally {
        queueState.inFlight = null;
        if (queueState.pendingPatch && Object.keys(queueState.pendingPatch).length > 0) {
          scheduleFlush();
        }
      }
    };

    const scheduleFlush = () => {
      if (queueState.throttleTimer !== null || queueState.inFlight) {
        return;
      }
      const elapsed = Date.now() - queueState.lastDispatchTime;
      const delay = Math.max(0, clampedThrottle - elapsed);

      queueState.throttleTimer = setTimeout(() => {
        queueState.throttleTimer = null;
        flushLatest();
      }, delay);
    };

    scheduleFlush();
  });
}

export async function syncAutoToManualConstraint(
  track,
  capabilityKey,
  manualModeKey,
  manualValue
) {
  if (!track) {
    return { settings: {}, syncedValue: undefined };
  }

  if (manualModeKey && typeof track.applyConstraints === 'function') {
    const modePatch = { [manualModeKey]: 'manual' };
    try {
      await track.applyConstraints({ advanced: [modePatch] });
    } catch (_) {
      try {
        await track.applyConstraints(modePatch);
      } catch (_) {}
    }
  }

  let { settings } = readTrackCapabilitiesAndSettings(track);
  let syncedValue =
    capabilityKey && typeof settings[capabilityKey] === 'number'
      ? settings[capabilityKey]
      : undefined;

  if (syncedValue === undefined && typeof manualValue === 'number' && Number.isFinite(manualValue)) {
    const targetPatch = {};
    if (manualModeKey) {
      targetPatch[manualModeKey] = 'manual';
    }
    if (capabilityKey) {
      targetPatch[capabilityKey] = manualValue;
    }

    if (Object.keys(targetPatch).length > 0 && typeof track.applyConstraints === 'function') {
      try {
        await track.applyConstraints({ advanced: [targetPatch] });
      } catch (_) {
        try {
          await track.applyConstraints(targetPatch);
        } catch (_) {}
      }
      ({ settings } = readTrackCapabilitiesAndSettings(track));
      syncedValue =
        capabilityKey && typeof settings[capabilityKey] === 'number'
          ? settings[capabilityKey]
          : manualValue;
    }
  }

  return {
    settings,
    syncedValue,
  };
}

export async function reapplyCurrentTrackConstraints(track, currentSettings = {}) {
  if (!track) {
    return null;
  }

  const { capabilities, settings: liveSettings } = readTrackCapabilitiesAndSettings(track);
  const sourceSettings =
    currentSettings && typeof currentSettings === 'object' && Object.keys(currentSettings).length > 0
      ? currentSettings
      : liveSettings;

  const candidatePatch = {};
  for (const [key, value] of Object.entries(sourceSettings)) {
    if (value === undefined || value === null) continue;
    if (
      key === 'deviceId' ||
      key === 'groupId' ||
      key === 'width' ||
      key === 'height' ||
      key === 'frameRate' ||
      key === 'aspectRatio' ||
      key === 'facingMode' ||
      key === 'resizeMode'
    ) {
      continue;
    }
    if (capabilities && Object.prototype.hasOwnProperty.call(capabilities, key)) {
      candidatePatch[key] = value;
    }
  }

  const sanitized = sanitizeConstraintPatchForTrack(track, candidatePatch);
  if (Object.keys(sanitized).length > 0 && typeof track.applyConstraints === 'function') {
    try {
      await track.applyConstraints({ advanced: [sanitized] });
    } catch (_) {
      try {
        await track.applyConstraints(sanitized);
      } catch (_) {}
    }
  }

  return typeof track.getSettings === 'function' ? track.getSettings() : liveSettings;
}

export async function requestScreenWakeLock(existingSentinel = null) {
  if (
    existingSentinel &&
    typeof existingSentinel.released === 'boolean' &&
    !existingSentinel.released
  ) {
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
  } catch (_) {
    return null;
  }
}

export function stopCameraStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') {
    return;
  }

  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch (_) {}
  });
}