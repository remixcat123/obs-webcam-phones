const ROOM_ID_STORAGE_KEY = 'obs_p2p_webcam_room_id_v2_1';

const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const RESOLUTION_PRESETS = [
  { id: '480p-16x9', label: '854x480 (16:9)', width: 854, height: 480, orientation: '16:9' },
  { id: '480p-9x16', label: '480x854 (9:16)', width: 480, height: 854, orientation: '9:16' },
  { id: '720p-16x9', label: '1280x720 (16:9)', width: 1280, height: 720, orientation: '16:9' },
  { id: '720p-9x16', label: '720x1280 (9:16)', width: 720, height: 1280, orientation: '9:16' },
  { id: '1080p-16x9', label: '1920x1080 (16:9)', width: 1920, height: 1080, orientation: '16:9' },
  { id: '1080p-9x16', label: '1080x1920 (9:16)', width: 1080, height: 1920, orientation: '9:16' },
  { id: '1440p-16x9', label: '2560x1440 (16:9)', width: 2560, height: 1440, orientation: '16:9' },
  { id: '1440p-9x16', label: '1440x2560 (9:16)', width: 1440, height: 2560, orientation: '9:16' },
  { id: '2160p-16x9', label: '3840x2160 (16:9)', width: 3840, height: 2160, orientation: '16:9' },
  { id: '2160p-9x16', label: '2160x3840 (9:16)', width: 2160, height: 3840, orientation: '9:16' },
];

const FPS_PRESETS = [24, 30, 60];

const BITRATE_PRESETS = [2000, 3000, 4000, 5000, 6000, 8000];

function generateRoomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().split('-')[0] + '-' + Math.random().toString(36).slice(2, 6);
  }
  return 'sala-' + Math.random().toString(36).slice(2, 10);
}

function readPersistedRoomId() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }
    const stored = window.localStorage.getItem(ROOM_ID_STORAGE_KEY);
    if (typeof stored === 'string' && stored.trim() !== '') {
      return stored.trim();
    }
  } catch (_) {
    // Acceso a localStorage bloqueado o no disponible
  }
  return null;
}

export function parseRouteParams(searchString = window.location.search) {
  const params = new URLSearchParams(typeof searchString === 'string' ? searchString : '');
  const hasView = params.has('view');
  const rawId = params.get('id');
  const rawPassword = params.get('password');

  const roomId = rawId !== null && rawId.trim() !== '' ? rawId.trim() : null;
  const password = rawPassword !== null ? rawPassword : null;

  return {
    mode: hasView ? 'viewer' : 'emitter',
    roomId,
    password,
  };
}

export function resolveRoomId(urlRoomId, generateIfMissing = true) {
  if (typeof urlRoomId === 'string' && urlRoomId.trim() !== '') {
    return urlRoomId.trim();
  }

  const storedRoomId = readPersistedRoomId();
  if (storedRoomId) {
    return storedRoomId;
  }

  if (generateIfMissing) {
    return generateRoomId();
  }

  return '';
}

export function persistRoomId(roomId) {
  const normalized = typeof roomId === 'string' ? roomId.trim() : '';
  try {
    if (typeof window !== 'undefined' && window.localStorage && normalized !== '') {
      window.localStorage.setItem(ROOM_ID_STORAGE_KEY, normalized);
    }
  } catch (_) {
    // Ignorar errores de cuota o privacidad en localStorage
  }
  return normalized;
}

export function buildObsViewerUrl(roomId, password = '', baseHref = window.location.href) {
  const url = new URL(baseHref);
  const searchParams = new URLSearchParams();

  searchParams.set('view', '');
  if (typeof roomId === 'string' && roomId.trim() !== '') {
    searchParams.set('id', roomId.trim());
  }
  if (typeof password === 'string' && password.length > 0) {
    searchParams.set('password', password);
  }

  const queryString = searchParams
    .toString()
    .replace(/(^|&)view=(&|$)/, '$1view$2');

  url.search = queryString ? `?${queryString}` : '?view';
  url.hash = '';
  return url.toString();
}

export function getPeerConfig(overrides = {}) {
  const opts = overrides && typeof overrides === 'object' ? overrides : {};
  const customIceServers =
    opts.config && Array.isArray(opts.config.iceServers) && opts.config.iceServers.length > 0
      ? opts.config.iceServers
      : DEFAULT_STUN_SERVERS;

  const peerConfig = {
    config: {
      ...(opts.config && typeof opts.config === 'object' ? opts.config : {}),
      iceServers: customIceServers,
    },
  };

  if (typeof opts.host === 'string' && opts.host.trim() !== '') {
    peerConfig.host = opts.host.trim();
  }
  if (typeof opts.port === 'number' && Number.isFinite(opts.port) && opts.port > 0) {
    peerConfig.port = opts.port;
  }
  if (typeof opts.path === 'string' && opts.path.trim() !== '') {
    peerConfig.path = opts.path.trim();
  }
  if (typeof opts.secure === 'boolean') {
    peerConfig.secure = opts.secure;
  }

  return peerConfig;
}

export function getMediaPresets() {
  return {
    resolutions: RESOLUTION_PRESETS.map((preset) => ({ ...preset })),
    fpsList: [...FPS_PRESETS],
    bitrateList: [...BITRATE_PRESETS],
  };
}

export function clampAndStepValue(value, min, max, step = 1) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return Number.isFinite(Number(min)) ? Number(min) : 0;
  }

  const hasMin = Number.isFinite(Number(min));
  const hasMax = Number.isFinite(Number(max));
  const minVal = hasMin ? Number(min) : -Infinity;
  const maxVal = hasMax ? Number(max) : Infinity;

  let clamped = Math.min(Math.max(numericValue, minVal), maxVal);

  const numericStep = Number(step);
  if (Number.isFinite(numericStep) && numericStep > 0) {
    const anchor = hasMin ? minVal : 0;
    const stepped = anchor + Math.round((clamped - anchor) / numericStep) * numericStep;
    const stepStr = String(numericStep);
    const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
    const rounded = decimals > 0 ? Number(stepped.toFixed(decimals)) : stepped;
    clamped = Math.min(Math.max(rounded, minVal), maxVal);
  }

  return clamped;
}

const SESSION_KEY = 'obs_p2p_session_v1';
let sessionTimer = null;
let pendingPatch = {};

export function loadSession() {
  try {
    const o = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return o && typeof o === 'object' ? o : {};
  } catch (_) { return {}; }
}

export function saveSession(patch) {
  pendingPatch = { ...pendingPatch, ...patch };
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(flushSession, 250);
}

export function flushSession() {
  clearTimeout(sessionTimer);
  if (!Object.keys(pendingPatch).length) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...loadSession(), ...pendingPatch }));
  } catch (_) {}
  pendingPatch = {};
}

window.addEventListener('pagehide', flushSession);