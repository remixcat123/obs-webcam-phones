// config.js — Constantes, presets, configuración PeerJS/STUN y utilidades de URL/almacenamiento/clamping.

const ROOM_ID_STORAGE_KEY = 'obs_p2p_webcam_v2_1_room_id';

const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

const MEDIA_PRESETS = Object.freeze({
  resolutions: [
    // Horizontal 16:9
    { id: '854x480_16x9', label: '854×480 (480p 16:9)', width: 854, height: 480, orientation: '16:9' },
    { id: '1280x720_16x9', label: '1280×720 (720p HD 16:9)', width: 1280, height: 720, orientation: '16:9' },
    { id: '1920x1080_16x9', label: '1920×1080 (1080p FHD 16:9)', width: 1920, height: 1080, orientation: '16:9' },
    { id: '2560x1440_16x9', label: '2560×1440 (1440p QHD 16:9)', width: 2560, height: 1440, orientation: '16:9' },
    { id: '3840x2160_16x9', label: '3840×2160 (2160p 4K 16:9)', width: 3840, height: 2160, orientation: '16:9' },
    // Vertical 9:16
    { id: '480x854_9x16', label: '480×854 (480p 9:16)', width: 480, height: 854, orientation: '9:16' },
    { id: '720x1280_9x16', label: '720×1280 (720p HD 9:16)', width: 720, height: 1280, orientation: '9:16' },
    { id: '1080x1920_9x16', label: '1080×1920 (1080p FHD 9:16)', width: 1080, height: 1920, orientation: '9:16' },
    { id: '1440x2560_9x16', label: '1440×2560 (1440p QHD 9:16)', width: 1440, height: 2560, orientation: '9:16' },
    { id: '2160x3840_9x16', label: '2160×3840 (2160p 4K 9:16)', width: 2160, height: 3840, orientation: '9:16' }
  ],
  fpsList: [24, 30, 60],
  bitrateList: [2000, 3000, 4000, 5000, 6000, 8000]
});

function generateRandomRoomId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let suffix = '';

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length; i += 1) {
      suffix += alphabet[bytes[i] % alphabet.length];
    }
  } else {
    for (let i = 0; i < 8; i += 1) {
      suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  }

  return `obs-${suffix}`;
}

export function parseRouteParams(searchString = window.location.search) {
  const params = new URLSearchParams(searchString || '');
  const hasView = params.has('view');
  const rawId = params.get('id');
  const rawPassword = params.get('password');

  const roomId = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : null;
  const password = typeof rawPassword === 'string' && rawPassword.length > 0 ? rawPassword : null;

  return {
    mode: hasView ? 'viewer' : 'emitter',
    roomId,
    password
  };
}

export function persistRoomId(roomId) {
  const normalized = typeof roomId === 'string' ? roomId.trim() : '';
  const finalId = normalized.length > 0 ? normalized : generateRandomRoomId();

  try {
    window.localStorage.setItem(ROOM_ID_STORAGE_KEY, finalId);
  } catch (_err) {
    // Ignorar errores de acceso a localStorage (modo privado o restricciones del navegador)
  }

  return finalId;
}

export function resolveRoomId(urlRoomId, generateIfMissing = true) {
  if (typeof urlRoomId === 'string' && urlRoomId.trim().length > 0) {
    return persistRoomId(urlRoomId.trim());
  }

  try {
    const stored = window.localStorage.getItem(ROOM_ID_STORAGE_KEY);
    if (typeof stored === 'string' && stored.trim().length > 0) {
      return stored.trim();
    }
  } catch (_err) {
    // Ignorar errores de acceso a localStorage
  }

  if (!generateIfMissing) {
    return '';
  }

  return persistRoomId(generateRandomRoomId());
}

export function buildObsViewerUrl(roomId, password = '', baseHref = window.location.href) {
  const url = new URL(baseHref);
  url.search = '';
  url.hash = '';

  const params = new URLSearchParams();
  params.set('view', '');

  if (typeof roomId === 'string' && roomId.trim().length > 0) {
    params.set('id', roomId.trim());
  }

  if (typeof password === 'string' && password.length > 0) {
    params.set('password', password);
  }

  // Asegurar formato limpio `?view&id=...` manteniendo compatibilidad total con URLSearchParams
  const queryString = params
    .toString()
    .replace(/(^|&)view=(&|$)/, (_match, prefix, suffix) => {
      if (prefix && suffix) return '&';
      return prefix || (suffix ? '' : '');
    });

  url.search = queryString ? `?view${queryString.startsWith('&') ? '' : '&'}${queryString}` : '?view';
  return url.toString();
}

export function getPeerConfig(overrides = {}) {
  const customIceServers =
    overrides &&
    overrides.config &&
    Array.isArray(overrides.config.iceServers) &&
    overrides.config.iceServers.length > 0
      ? overrides.config.iceServers
      : DEFAULT_STUN_SERVERS;

  const peerConfig = {
    config: {
      ...(overrides && overrides.config ? overrides.config : {}),
      iceServers: customIceServers
    }
  };

  if (typeof overrides.host === 'string' && overrides.host.trim().length > 0) {
    peerConfig.host = overrides.host.trim();
  }

  if (typeof overrides.port === 'number' && Number.isFinite(overrides.port) && overrides.port > 0) {
    peerConfig.port = overrides.port;
  }

  if (typeof overrides.path === 'string' && overrides.path.trim().length > 0) {
    peerConfig.path = overrides.path.trim();
  }

  if (typeof overrides.secure === 'boolean') {
    peerConfig.secure = overrides.secure;
  }

  return peerConfig;
}

export function getMediaPresets() {
  return {
    resolutions: MEDIA_PRESETS.resolutions.map((item) => ({ ...item })),
    fpsList: [...MEDIA_PRESETS.fpsList],
    bitrateList: [...MEDIA_PRESETS.bitrateList]
  };
}

export function clampAndStepValue(value, min, max, step = 1) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return Number.isFinite(Number(min)) ? Number(min) : 0;
  }

  const hasMin = typeof min === 'number' && Number.isFinite(min);
  const hasMax = typeof max === 'number' && Number.isFinite(max);
  const validStep = typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : null;

  let candidate = numericValue;

  if (validStep !== null) {
    const anchor = hasMin ? min : 0;
    const stepsFromAnchor = Math.round((candidate - anchor) / validStep);
    candidate = anchor + stepsFromAnchor * validStep;

    // Evitar artefactos de coma flotante como 1.0000000000000002
    const stepDecimals = String(validStep).split('.')[1]?.length || 0;
    const anchorDecimals = String(anchor).split('.')[1]?.length || 0;
    const precision = Math.min(10, Math.max(stepDecimals, anchorDecimals));
    candidate = Number(candidate.toFixed(precision));
  }

  if (hasMin && candidate < min) {
    candidate = min;
  }

  if (hasMax && candidate > max) {
    candidate = max;
  }

  return candidate;
}