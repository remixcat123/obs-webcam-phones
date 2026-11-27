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

  if (!stream && hasExplicitDevice) {
  for (const video of [{ deviceId: { ideal: opts.deviceId.trim() } }, true]) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      break;
    } catch (e) { lastError = e; }
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

// ===== Motor de sensores =====
export const SENSOR_GROUPS = {
  exposureMode: ['exposureTime', 'iso'],
  whiteBalanceMode: ['colorTemperature'],
  focusMode: ['focusDistance'],
};

const VALUE_TO_MODE = {};
Object.entries(SENSOR_GROUPS).forEach(([mode, keys]) =>
  keys.forEach((k) => { VALUE_TO_MODE[k] = mode; })
);

// Valores de arranque al pasar a manual si el sensor no informa los actuales.
// exposureTime va en unidades de 100 µs (167 ≈ 1/60 s). Se recortan al rango real.
const MANUAL_DEFAULTS = { exposureTime: 167, iso: 400 };

export function seedDesiredState(track, desired) { track.__desired = { ...(desired || {}) }; }
export function getDesiredState(track) { return { ...((track && track.__desired) || {}) }; }

function normalizePatch(track, patch) {
  const caps = (track.getCapabilities && track.getCapabilities()) || {};
  const out = {};
  for (const [key, val] of Object.entries(patch || {})) {
    if (val === undefined || val === null) continue;
    const cap = caps[key];
    if (cap === undefined) continue;                       // el sensor no lo soporta
    if (Array.isArray(cap)) { if (cap.includes(val)) out[key] = val; continue; }
    if (typeof cap === 'boolean') { if (typeof val === 'boolean') out[key] = val; continue; }
    if (cap && typeof cap === 'object' && typeof val === 'number') {
      out[key] = clampAndStepValue(val, cap.min, cap.max, cap.step > 0 ? cap.step : 1);
    }
  }
  return out;
}

function withManualCompanions(track, patch) {
  const caps = (track.getCapabilities && track.getCapabilities()) || {};
  const live = (track.getSettings && track.getSettings()) || {};
  const desired = track.__desired || {};
  const out = { ...patch };

  // Mover un valor manual implica poner su modo en manual
  for (const [valueKey, modeKey] of Object.entries(VALUE_TO_MODE)) {
    if (out[valueKey] !== undefined && out[modeKey] === undefined &&
        Array.isArray(caps[modeKey]) && caps[modeKey].includes('manual')) {
      out[modeKey] = 'manual';
    }
  }

  for (const [modeKey, valueKeys] of Object.entries(SENSOR_GROUPS)) {
    if (out[modeKey] !== undefined && out[modeKey] !== 'manual') {
      valueKeys.forEach((k) => delete out[k]);              // modo auto: no mandar valores
      continue;
    }
    if (out[modeKey] !== 'manual') continue;
    // Modo manual: SIEMPRE enviar sus valores en la misma petición
    for (const k of valueKeys) {
      if (out[k] !== undefined) continue;
      const cap = caps[k];
      if (!cap || typeof cap !== 'object') continue;
      let v = desired[k];
      if (typeof v !== 'number') v = live[k];
      if (typeof v !== 'number') v = MANUAL_DEFAULTS[k];
      if (typeof v !== 'number' && Number.isFinite(cap.min) && Number.isFinite(cap.max)) {
        v = (cap.min + cap.max) / 2;
      }
      if (typeof v === 'number') {
        out[k] = clampAndStepValue(v, cap.min, cap.max, cap.step > 0 ? cap.step : 1);
      }
    }
  }
  return out;
}

function splitIntoChunks(obj) {
  const chunks = [];
  const used = new Set();
  for (const [modeKey, valueKeys] of Object.entries(SENSOR_GROUPS)) {
    if (obj[modeKey] === undefined) continue;
    const chunk = { [modeKey]: obj[modeKey] };
    used.add(modeKey);
    valueKeys.forEach((k) => { if (obj[k] !== undefined) { chunk[k] = obj[k]; used.add(k); } });
    chunks.push(chunk);
  }
  for (const [k, v] of Object.entries(obj)) if (!used.has(k)) chunks.push({ [k]: v });
  return chunks;
}

export async function applySensorPatch(track, patch) {
  const clean = withManualCompanions(track, normalizePatch(track, patch));
  const accepted = {};
  const rejected = {};

  if (Object.keys(clean).length) {
    try {
      // Un solo bloque advanced con todo junto
      await track.applyConstraints({ advanced: [clean] });
      Object.assign(accepted, clean);
    } catch (_) {
      // Si algo falla, aislar qué clave es la culpable
      for (const chunk of splitIntoChunks(clean)) {
        try {
          await track.applyConstraints({ advanced: [chunk] });
          Object.assign(accepted, chunk);
        } catch (err) {
          Object.keys(chunk).forEach((k) => { rejected[k] = (err && err.message) || 'rechazado'; });
        }
      }
    }
  }

  track.__desired = { ...(track.__desired || {}), ...accepted };
  return { settings: (track.getSettings && track.getSettings()) || {}, accepted, rejected };
}

export async function restoreSensorState(track, saved) {
  if (!track) return { settings: {}, accepted: {}, rejected: {} };
  seedDesiredState(track, {});
  return applySensorPatch(track, saved || {});
}

export async function reapplyDesiredState(track) {
  if (!track) return null;
  const result = await applySensorPatch(track, getDesiredState(track));
  return result.settings;
}

// Cola: agrupa cambios rápidos (sliders) y aplica solo el último, de uno en uno
const sensorQueues = new WeakMap();

export function queueSensorPatch(track, patch, throttleMs = 100) {
  if (!track || typeof track.applyConstraints !== 'function') return Promise.resolve(null);
  let q = sensorQueues.get(track);
  if (!q) {
    q = { pending: {}, waiters: [], running: false, timer: null, last: 0, throttle: 100 };
    sensorQueues.set(track, q);
  }
  q.throttle = Math.min(Math.max(Number(throttleMs) || 100, 50), 300);
  Object.assign(q.pending, patch);
  return new Promise((resolve) => {
    q.waiters.push(resolve);
    scheduleSensorFlush(track, q);
  });
}

function scheduleSensorFlush(track, q) {
  if (q.running || q.timer !== null) return;
  const delay = Math.max(0, q.throttle - (Date.now() - q.last));
  q.timer = setTimeout(() => { q.timer = null; flushSensorQueue(track, q); }, delay);
}

async function flushSensorQueue(track, q) {
  if (q.running) return;
  const patch = q.pending;
  const waiters = q.waiters.splice(0);
  q.pending = {};
  q.running = true;
  let result;
  try {
    result = await applySensorPatch(track, patch);
  } catch (err) {
    result = { settings: (track.getSettings && track.getSettings()) || {}, accepted: {}, rejected: { error: (err && err.message) || 'error' } };
  }
  q.running = false;
  q.last = Date.now();
  waiters.forEach((w) => w(result));
  if (Object.keys(q.pending).length) scheduleSensorFlush(track, q);
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
      } catch (err) {
        throw err;
      }
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
        } catch (err) {
          throw err;
        }
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