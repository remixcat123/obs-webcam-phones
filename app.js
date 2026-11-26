/* ==========================================================
   Webcam P2P Persistente · OBS  v2.1  —  app.js
   Un solo archivo, sin módulos. Requiere PeerJS 1.5.4 (global `Peer`).
   Secciones: 1 Constantes/Estado · 2 Enrutamiento · 3 WebRTC/PeerJS
              4 Cámara y cola latest-wins · 5 UI dual · 6 Perfiles/OLED/Stats
   ========================================================== */
(() => {
'use strict';

/* ==========================================================
   1. CONSTANTES Y ESTADO GLOBAL
   ========================================================== */
const PEER_PREFIX = 'wcp2p-';
const LS_ROOM_KEY = 'wcp2p.roomId';            // ÚNICA clave de localStorage
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];
const THROTTLE_MS = 100;
const BITRATE_MIN = 2000;
const BITRATE_MAX = 8000;
const MAX_VIEWERS = 3;                          // cada receptor consume encoding de subida
const OLED_DOUBLE_TAP_MS = 350;

const NUMERIC_CONTROLS = [
  { key: 'colorTemperature',     id: 'color-temperature' },
  { key: 'exposureTime',         id: 'exposure-time' },
  { key: 'iso',                  id: 'iso' },
  { key: 'exposureCompensation', id: 'exposure-compensation' },
  { key: 'focusDistance',        id: 'focus-distance' },
  { key: 'zoom',                 id: 'zoom' },
  { key: 'pan',                  id: 'pan' },
  { key: 'tilt',                 id: 'tilt' },
  { key: 'brightness',           id: 'brightness' },
  { key: 'contrast',             id: 'contrast' },
  { key: 'saturation',           id: 'saturation' },
  { key: 'sharpness',            id: 'sharpness' }
];
const ENUM_CONTROLS = [
  { key: 'whiteBalanceMode', id: 'white-balance-mode', dependents: ['colorTemperature'] },
  { key: 'exposureMode',     id: 'exposure-mode',      dependents: ['exposureTime', 'iso'] },
  { key: 'focusMode',        id: 'focus-mode',         dependents: ['focusDistance'] }
];
const BOOL_CONTROLS = [{ key: 'torch', id: 'torch' }];

const RESOLUTIONS = { '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], '4k': [3840, 2160] };

const state = {
  mode: 'emitter',
  roomId: null,
  roomPassword: '',
  peer: null,
  connections: new Map(),     // emisor: receptores autenticados · receptor: 'emitter' -> DataConnection
  calls: new Map(),           // emisor: viewerId -> MediaConnection · receptor: 'emitter' -> MediaConnection
  stream: null,
  track: null,
  capabilities: {},
  nativeSettings: null,
  currentConstraints: {},     // constraints acumuladas del sensor (solo memoria)
  orientation: '16:9',
  bitrateKbps: 4000,
  profiles: [],               // solo memoria de sesión
  wakeLock: null,
  oled: false,
  statsTimer: null,
  lastStats: null,
  applyQueue: null,           // cola latest-wins del sensor
  bitrateQueue: null,         // cola latest-wins del bitrate
  hasError: false,
  reconnectTimer: null,
  reconnectAttempt: 0,
  watchdogTimer: null
};

const dom = {};               // caché de elementos por id
let registry = {};            // key -> { kind, wrapper, range, number, select, toggle }
let toastTimer = null;
let lastOledTap = 0;
let cameraRetryDone = false;

/* ==========================================================
   2. ENRUTAMIENTO Y UTILIDADES
   ========================================================== */

/** Lee URLSearchParams -> { mode, roomId, password }. */
function parseRoute() {
  const p = new URLSearchParams(location.search);
  return {
    mode: p.has('view') ? 'receiver' : 'emitter',
    roomId: p.get('id'),
    password: p.get('password')
  };
}

function sanitizeRoomId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
}

function generateRoomId() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

/** Sala: URL > localStorage > aleatoria. Persiste SOLO el roomId. */
function loadRoomId(urlId) {
  let id = sanitizeRoomId(urlId);
  if (!id) { try { id = sanitizeRoomId(localStorage.getItem(LS_ROOM_KEY)); } catch (e) { /* storage bloqueado */ } }
  if (!id) id = generateRoomId();
  try { localStorage.setItem(LS_ROOM_KEY, id); } catch (e) { /* ignorar */ }
  return id;
}

/** Resuelve todos los ids una vez; falla con mensaje claro si falta alguno. */
function cacheDom() {
  const ids = [
    'emitter-app', 'obs-app', 'oled-saver', 'toast', 'copy-fallback-dialog', 'copy-fallback-input',
    'btn-copy-fallback-close', 'obs-video', 'obs-status', 'obs-auth-modal', 'obs-password-input',
    'obs-auth-submit', 'obs-auth-error', 'status-indicator', 'status-text', 'viewers-count',
    'room-id-input', 'room-password-input', 'btn-apply-room', 'btn-copy-url', 'btn-oled',
    'preview-wrapper', 'local-video', 'camera-select', 'resolution-select', 'fps-select',
    'orientation-select', 'bitrate-range', 'bitrate-number', 'sensor-controls', 'no-controls-msg',
    'btn-reapply', 'btn-reset-native', 'profile-name-input', 'btn-save-profile', 'profile-list-select',
    'btn-apply-profile', 'btn-delete-profile', 'btn-export-profile', 'btn-import-profile',
    'profile-import-file', 'stats-details', 'stats-resolution', 'stats-fps', 'stats-bitrate', 'stats-rtt'
  ];
  NUMERIC_CONTROLS.forEach(c => ids.push('ctrl-' + c.id, c.id + '-range', c.id + '-number'));
  ENUM_CONTROLS.forEach(c => ids.push('ctrl-' + c.id, c.id + '-select'));
  BOOL_CONTROLS.forEach(c => ids.push('ctrl-' + c.id, c.id + '-toggle'));
  const missing = [];
  ids.forEach(id => { const el = document.getElementById(id); if (el) dom[id] = el; else missing.push(id); });
  if (missing.length) throw new Error('index.html: faltan ids -> ' + missing.join(', '));
}

function showMode(mode) {
  dom['emitter-app'].classList.toggle('hidden', mode !== 'emitter');
  dom['obs-app'].classList.toggle('hidden', mode !== 'receiver');
}

function buildObsUrl() {
  let url = `${location.origin}${location.pathname}?view&id=${encodeURIComponent(state.roomId)}`;
  if (state.roomPassword) url += `&password=${encodeURIComponent(state.roomPassword)}`;
  return url;
}

async function copyObsUrl() {
  const url = buildObsUrl();
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard no disponible');
    await navigator.clipboard.writeText(url);
    showToast('URL para OBS copiada', 'ok');
  } catch (e) {
    showCopyFallback(url);
  }
}

function showCopyFallback(url) {
  dom['copy-fallback-input'].value = url;
  if (typeof dom['copy-fallback-dialog'].showModal === 'function') dom['copy-fallback-dialog'].showModal();
  else dom['copy-fallback-dialog'].setAttribute('open', '');
  dom['copy-fallback-input'].focus();
  dom['copy-fallback-input'].select();
}

function showToast(msg, type) {
  const t = dom['toast'];
  t.textContent = msg;
  t.classList.remove('toast-error', 'toast-ok');
  if (type === 'error') t.classList.add('toast-error');
  if (type === 'ok') t.classList.add('toast-ok');
  t.classList.add('toast-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('toast-visible'), 2500);
}

function initApp() {
  try { cacheDom(); } catch (e) { document.body.textContent = e.message; throw e; }
  const route = parseRoute();
  state.mode = route.mode;
  showMode(route.mode);
  if (typeof Peer === 'undefined') {
    const msg = 'No se pudo cargar PeerJS (revisa la conexión).';
    if (route.mode === 'receiver') { document.documentElement.classList.add('receiver'); setObsStatus(msg, true); }
    else setStatus('error', msg);
    return;
  }
  if (route.mode === 'receiver') {
    document.documentElement.classList.add('receiver');
    document.title = 'OBS · Receptor';
    bindReceiverEvents();
    initReceiver(sanitizeRoomId(route.roomId), route.password);
  } else {
    initEmitter(route.roomId);
  }
}

/* ==========================================================
   3. WEBRTC / PEERJS
   ========================================================== */

/* ---------- 3.1 Emisor ---------- */

function initEmitterPeer(roomId) {
  destroyEmitterPeer();
  state.hasError = false;
  setStatus('waiting', 'Conectando al servidor de señalización…');
  const peer = new Peer(PEER_PREFIX + roomId, { config: { iceServers: ICE_SERVERS } });
  state.peer = peer;
  peer.on('open', () => { state.hasError = false; updateConnectionStatus(); });
  peer.on('connection', handleDataConnection);
  peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 2000); });
  peer.on('error', err => {
    if (err.type === 'unavailable-id') {
      state.hasError = true;
      setStatus('error', 'La sala ya está en uso en otro dispositivo');
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      setStatus('waiting', 'Sin red de señalización, reintentando…');
      setTimeout(() => { if (state.peer === peer && !peer.destroyed) peer.reconnect(); }, 4000);
    } else {
      console.warn('[peer emisor]', err);
    }
  });
}

function destroyEmitterPeer() {
  state.calls.forEach(c => { try { c.close(); } catch (e) { /* ignorar */ } });
  state.connections.forEach(c => { try { c.close(); } catch (e) { /* ignorar */ } });
  state.calls.clear();
  state.connections.clear();
  if (state.peer) { try { state.peer.destroy(); } catch (e) { /* ignorar */ } }
  state.peer = null;
  updateConnectionStatus();
}

/** Escucha el `hello` del receptor, valida y, si procede, lo llama. */
function handleDataConnection(conn) {
  conn.on('data', msg => {
    if (!msg || msg.type !== 'hello') return;
    if (!validatePassword(msg.password)) {
      conn.send({ type: 'auth-fail', reason: msg.password ? 'wrong' : 'required' });
      return;
    }
    if (!state.connections.has(conn.peer) && state.connections.size >= MAX_VIEWERS) {
      conn.send({ type: 'busy' });
      return;
    }
    const old = state.connections.get(conn.peer);
    if (old && old !== conn) { try { old.close(); } catch (e) { /* ignorar */ } }
    state.connections.set(conn.peer, conn);
    conn.send({ type: 'auth-ok' });
    callViewer(conn.peer);
  });
  const drop = () => {
    if (state.connections.get(conn.peer) === conn) {
      state.connections.delete(conn.peer);
      onCallClosed(conn.peer);
    }
  };
  conn.on('close', drop);
  conn.on('error', drop);
}

function validatePassword(received) {
  return !state.roomPassword || received === state.roomPassword;
}

/** Llama al receptor con el stream actual y vigila el estado de la conexión. */
function callViewer(viewerPeerId) {
  if (!state.peer || !state.stream) return;       // se reintenta al iniciar la cámara
  const prev = state.calls.get(viewerPeerId);
  if (prev) { state.calls.delete(viewerPeerId); try { prev.close(); } catch (e) { /* ignorar */ } }
  const call = state.peer.call(viewerPeerId, state.stream);
  if (!call) return;
  state.calls.set(viewerPeerId, call);
  call.on('close', () => { if (state.calls.get(viewerPeerId) === call) onCallClosed(viewerPeerId); });
  call.on('error', () => { if (state.calls.get(viewerPeerId) === call) onCallClosed(viewerPeerId); });
  watchCall(viewerPeerId, call, 0);
  updateConnectionStatus();
}

function watchCall(viewerPeerId, call, attempt) {
  const pc = call.peerConnection;
  if (!pc) { if (attempt < 5) setTimeout(() => watchCall(viewerPeerId, call, attempt + 1), 300); return; }
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') {
      pc.getSenders().filter(s => s.track && s.track.kind === 'video')
        .forEach(s => applyBitrateToSender(s, state.bitrateKbps));
    }
    if (['failed', 'closed'].includes(pc.connectionState) && state.calls.get(viewerPeerId) === call) {
      onCallClosed(viewerPeerId);
    }
    updateConnectionStatus();
  });
}

function onCallClosed(viewerPeerId) {
  const call = state.calls.get(viewerPeerId);
  state.calls.delete(viewerPeerId);
  if (call && call.open) { try { call.close(); } catch (e) { /* ignorar */ } }
  updateConnectionStatus();
}

function getVideoSenders() {
  const senders = [];
  state.calls.forEach(call => {
    const pc = call.peerConnection;
    if (pc) pc.getSenders().forEach(s => { if (s.track && s.track.kind === 'video') senders.push(s); });
  });
  return senders;
}

async function replaceTrackOnSenders(newTrack) {
  await Promise.all(getVideoSenders().map(s => s.replaceTrack(newTrack).catch(e => console.warn('[replaceTrack]', e))));
}

/** Clamp 2000–8000 kbps y aplica a todos los senders. */
async function setBitrate(kbps) {
  const v = Math.round(Math.min(BITRATE_MAX, Math.max(BITRATE_MIN, Number(kbps) || state.bitrateKbps)));
  state.bitrateKbps = v;
  dom['bitrate-range'].value = v;
  dom['bitrate-number'].value = v;
  await Promise.all(getVideoSenders().map(s => applyBitrateToSender(s, v)));
}

async function applyBitrateToSender(sender, kbps) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = kbps * 1000;
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  } catch (e) {
    console.warn('[setParameters]', e);
  }
}

function setStatus(kind, text) {
  const dot = dom['status-indicator'];
  dot.className = 'status-dot status-' + kind;
  dom['status-text'].textContent = text;
}

function updateConnectionStatus() {
  if (state.mode !== 'emitter' || !dom['status-indicator']) return;
  let viewers = 0;
  state.calls.forEach(c => { const pc = c.peerConnection; if (!pc || pc.connectionState !== 'failed') viewers++; });
  dom['viewers-count'].textContent = String(viewers);
  if (state.hasError) return;
  if (!state.peer || !state.peer.open) setStatus('waiting', 'Conectando…');
  else if (viewers === 0) setStatus('waiting', `Esperando receptor · sala ${state.roomId}`);
  else setStatus('live', 'En vivo');
  if (dom['stats-details'].open) startStatsPolling();
}

/* ---------- 3.2 Receptor (Auto-Healing) ---------- */

function initReceiver(roomId, password) {
  state.roomId = roomId;
  state.roomPassword = password || '';
  if (!roomId) { setObsStatus('Falta el parámetro ?id=SALA', true); return; }
  // Limpia la contraseña de la barra de direcciones (queda solo en memoria).
  try { history.replaceState(null, '', `${location.pathname}?view&id=${encodeURIComponent(roomId)}`); } catch (e) { /* ignorar */ }
  createReceiverPeer();
}

function createReceiverPeer() {
  if (state.peer) { try { state.peer.destroy(); } catch (e) { /* ignorar */ } }
  setObsStatus('Conectando…', true);
  const peer = new Peer({ config: { iceServers: ICE_SERVERS } });
  state.peer = peer;
  peer.on('open', () => connectToEmitter());
  peer.on('call', handleIncomingCall);
  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on('error', err => scheduleReconnect(err.type || 'error'));
}

function connectToEmitter() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (!state.peer || state.peer.destroyed || !state.peer.open) { scheduleReconnect('peer-cerrado'); return; }
  const old = state.connections.get('emitter');
  if (old) { try { old.close(); } catch (e) { /* ignorar */ } }
  setObsStatus('Buscando emisor…', true);
  const conn = state.peer.connect(PEER_PREFIX + state.roomId, { reliable: true });
  state.connections.set('emitter', conn);
  conn.on('open', () => conn.send({ type: 'hello', password: state.roomPassword || null }));
  conn.on('data', handleAuthResponse);
  conn.on('close', () => { if (state.connections.get('emitter') === conn) scheduleReconnect('conexión cerrada'); });
  conn.on('error', () => { if (state.connections.get('emitter') === conn) scheduleReconnect('error de datos'); });
  // Vigilante: si en 10 s no llega vídeo ni petición de contraseña, reintenta.
  clearTimeout(state.watchdogTimer);
  state.watchdogTimer = setTimeout(() => {
    if (!dom['obs-video'].srcObject && dom['obs-auth-modal'].classList.contains('hidden')) scheduleReconnect('sin respuesta');
  }, 10000);
}

function handleIncomingCall(call) {
  call.answer();
  state.calls.set('emitter', call);
  call.on('stream', stream => {
    if (dom['obs-video'].srcObject !== stream) dom['obs-video'].srcObject = stream;
    dom['obs-video'].play().catch(() => { /* autoplay silenciado por política */ });
    state.reconnectAttempt = 0;
    clearTimeout(state.watchdogTimer);
    setObsStatus('', false);
    try { call.peerConnection.getReceivers().forEach(r => { if ('playoutDelayHint' in r) r.playoutDelayHint = 0; }); } catch (e) { /* ignorar */ }
  });
  call.on('close', () => { if (state.calls.get('emitter') === call) scheduleReconnect('llamada cerrada'); });
  call.on('error', () => { if (state.calls.get('emitter') === call) scheduleReconnect('error de llamada'); });
  const pc = call.peerConnection;
  if (pc) pc.addEventListener('connectionstatechange', () => {
    if (['failed', 'closed'].includes(pc.connectionState)) scheduleReconnect('ice ' + pc.connectionState);
    if (pc.connectionState === 'disconnected') {
      setTimeout(() => { if (pc.connectionState !== 'connected' && state.calls.get('emitter') === call) scheduleReconnect('ice desconectado'); }, 5000);
    }
  });
}

function handleAuthResponse(msg) {
  if (!msg) return;
  if (msg.type === 'auth-ok') {
    dom['obs-auth-modal'].classList.add('hidden');
    dom['obs-auth-error'].classList.add('hidden');
    setObsStatus('Esperando vídeo…', true);
  } else if (msg.type === 'auth-fail') {
    clearTimeout(state.reconnectTimer); state.reconnectTimer = null;
    clearTimeout(state.watchdogTimer);
    const err = dom['obs-auth-error'];
    if (msg.reason === 'wrong') { err.textContent = 'Contraseña incorrecta'; err.classList.remove('hidden'); }
    else err.classList.add('hidden');
    dom['obs-auth-modal'].classList.remove('hidden');
    dom['obs-password-input'].value = '';
    dom['obs-password-input'].focus();
    setObsStatus('', false);
  } else if (msg.type === 'busy') {
    scheduleReconnect('sala llena');
  }
}

function submitObsPassword() {
  const pw = dom['obs-password-input'].value;
  if (!pw) return;
  state.roomPassword = pw;
  dom['obs-auth-error'].classList.add('hidden');
  connectToEmitter();
}

/** Backoff 3 s -> 10 s. */
function scheduleReconnect(reason) {
  if (state.mode !== 'receiver' || state.reconnectTimer) return;
  if (!dom['obs-auth-modal'].classList.contains('hidden')) return;   // esperando contraseña
  const delay = Math.min(3000 * Math.pow(1.5, state.reconnectAttempt), 10000);
  state.reconnectAttempt++;
  setObsStatus(`Reconectando… (${reason})`, true);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    const call = state.calls.get('emitter');
    if (call) { state.calls.delete('emitter'); try { call.close(); } catch (e) { /* ignorar */ } }
    if (state.peer && !state.peer.destroyed && state.peer.open) connectToEmitter();
    else createReceiverPeer();
  }, delay);
}

function teardownReceiver() {
  clearTimeout(state.reconnectTimer); clearTimeout(state.watchdogTimer);
  state.reconnectTimer = null;
  state.calls.forEach(c => { try { c.close(); } catch (e) { /* ignorar */ } });
  state.connections.forEach(c => { try { c.close(); } catch (e) { /* ignorar */ } });
  state.calls.clear(); state.connections.clear();
  if (state.peer) { try { state.peer.destroy(); } catch (e) { /* ignorar */ } state.peer = null; }
  dom['obs-video'].srcObject = null;
}

function setObsStatus(text, visible) {
  dom['obs-status'].textContent = text;
  dom['obs-status'].classList.toggle('hidden', !visible);
}

function bindReceiverEvents() {
  dom['obs-auth-submit'].addEventListener('click', submitObsPassword);
  dom['obs-password-input'].addEventListener('keydown', e => { if (e.key === 'Enter') submitObsPassword(); });
  window.addEventListener('online', () => { state.reconnectAttempt = 0; scheduleReconnect('red restaurada'); });
  window.addEventListener('pagehide', teardownReceiver);
}

/* ==========================================================
   4. CÁMARA Y COLA LATEST-WINS
   ========================================================== */

async function enumerateCameras() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const sel = dom['camera-select'];
    const current = currentDeviceId();
    sel.innerHTML = '';
    devices.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Cámara ${i + 1}`;
      sel.appendChild(o);
    });
    if (current) sel.value = current;
  } catch (e) {
    console.warn('[enumerateDevices]', e);
  }
}

function currentDeviceId() {
  const s = state.track ? state.track.getSettings() : null;
  return (s && s.deviceId) || dom['camera-select'].value || null;
}

/** Constraints de getUserMedia / applyConstraints (D6: 9:16 intercambia ancho y alto). */
function buildVideoConstraints(deviceId) {
  let [w, h] = RESOLUTIONS[dom['resolution-select'].value] || RESOLUTIONS['1080p'];
  if (state.orientation === '9:16') [w, h] = [h, w];
  const c = {
    width: { ideal: w },
    height: { ideal: h },
    frameRate: { ideal: Number(dom['fps-select'].value) || 30 }
  };
  if (deviceId) c.deviceId = { exact: deviceId };
  return c;
}

function stopCurrentTrack() {
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  state.stream = null;
  state.track = null;
}

/** Libera la cámara previa ANTES de abrir otra (estabilidad del driver móvil). */
async function startCamera(deviceId) {
  stopCurrentTrack();
  const stream = await navigator.mediaDevices.getUserMedia({ video: buildVideoConstraints(deviceId), audio: false });
  attachStream(stream);
  await enumerateCameras();
}

function attachStream(stream) {
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  state.currentConstraints = {};
  dom['local-video'].srcObject = stream;
  readCapabilities();
  readNativeSettings();
  refreshControlsVisibility();
  syncControlsFromSettings(state.nativeSettings);
  ENUM_CONTROLS.forEach(c => updateDependentState(c.key, dom[c.id + '-select'].value));
  state.lastStats = null;
  const track = state.track;
  track.addEventListener('ended', () => {
    if (track !== state.track) return;
    showToast('La cámara se detuvo', 'error');
    if (!cameraRetryDone) { cameraRetryDone = true; setTimeout(() => restartCapture(null), 1000); }
  });
  // Receptores ya conectados: hot swap del track o llamada pendiente.
  if (state.calls.size) replaceTrackOnSenders(track);
  state.connections.forEach((_, id) => { if (!state.calls.has(id)) callViewer(id); });
}

/** Reinicia captura; si falla, intenta recuperar la cámara anterior. */
async function restartCapture(deviceId) {
  const prev = currentDeviceId();
  try {
    await startCamera(deviceId);
    cameraRetryDone = false;
  } catch (e) {
    showToast('No se pudo abrir la cámara: ' + (e.name || e.message), 'error');
    if (deviceId && deviceId !== prev) { try { await startCamera(prev); } catch (e2) { /* ignorar */ } }
  }
}

async function switchCamera(deviceId) {
  if (!deviceId) return;
  await restartCapture(deviceId);
}

/** Cambia resolución/fps en caliente sobre el mismo track; si falla, reinicia. */
async function applyResolution() {
  if (!state.track) return;
  try {
    await state.track.applyConstraints(buildVideoConstraints(null));
    state.lastStats = null;
    await reapplyAll(true);
  } catch (e) {
    await restartCapture(currentDeviceId());
  }
}

function setOrientation(value) {
  state.orientation = value === '9:16' ? '9:16' : '16:9';
  const w = dom['preview-wrapper'];
  w.classList.toggle('ratio-16-9', state.orientation === '16:9');
  w.classList.toggle('ratio-9-16', state.orientation === '9:16');
  applyResolution();
}

function readCapabilities() {
  state.capabilities = (state.track && state.track.getCapabilities) ? state.track.getCapabilities() : {};
}

function readNativeSettings() {
  state.nativeSettings = state.track ? Object.assign({}, state.track.getSettings()) : null;
}

function isSupported(key) {
  const c = state.capabilities[key];
  if (c === undefined || c === null || c === false) return false;
  if (Array.isArray(c)) return c.length > 0;
  return true;
}

/**
 * Cola latest-wins: throttling + una sola promesa en vuelo + gana el último valor.
 * Con merge=true los objetos pendientes se fusionan (varias claves, último valor de cada una).
 */
function createLatestWinsQueue(applyFn, delayMs, merge) {
  let pending = null, hasPending = false, inFlight = false;
  let timer = null, lastRun = 0, inFlightPromise = Promise.resolve();

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const run = () => {
    timer = null;
    if (inFlight || !hasPending) return Promise.resolve();
    const value = pending;
    pending = null; hasPending = false; inFlight = true; lastRun = Date.now();
    inFlightPromise = (async () => {
      try { await applyFn(value); }
      catch (e) { console.warn('[cola latest-wins]', e); }
      finally { inFlight = false; if (hasPending) schedule(); }
    })();
    return inFlightPromise;
  };

  const schedule = () => {
    if (timer || inFlight) return;                 // si hay promesa en vuelo, se reprograma al resolver
    timer = setTimeout(run, Math.max(0, delayMs - (Date.now() - lastRun)));
  };

  return {
    push(value) {
      pending = (merge && hasPending) ? Object.assign({}, pending, value) : value;
      hasPending = true;
      schedule();
    },
    async flush() {                                 // espera a que todo lo pendiente se aplique
      while (inFlight || hasPending) { clearTimer(); await (inFlight ? inFlightPromise : run()); }
    },
    cancel() { clearTimer(); pending = null; hasPending = false; }
  };
}

function queueConstraint(key, value) {
  state.applyQueue.push({ [key]: value });
}

/** Aplica el parche acumulado al sensor (envía el conjunto completo: evita reversiones del driver). */
async function applyConstraintNow(patch) {
  if (!state.track || state.track.readyState !== 'live') return;
  Object.assign(state.currentConstraints, patch);
  await state.track.applyConstraints({ advanced: [Object.assign({}, state.currentConstraints)] });
}

async function pushAndFlush(obj) {
  if (!Object.keys(obj).length) return;
  state.applyQueue.push(obj);
  await state.applyQueue.flush();
}

/** Transición Auto -> Manual: aplica el modo y re-lee getSettings() para evitar saltos. */
async function onModeChange(key, value) {
  const entry = ENUM_CONTROLS.find(c => c.key === key);
  if (!entry || !state.track) return;
  updateDependentState(key, value);
  await pushAndFlush({ [key]: value });
  if (value === 'manual') syncControlsFromSettings(state.track.getSettings(), entry.dependents);
}

/** Reaplica el estado actual de la UI (botón Reaplicar y visibilitychange). */
async function reapplyAll(silent) {
  if (!state.track || state.track.readyState !== 'live') return;
  await pushAndFlush(collectCurrentSettings());
  if (!silent) showToast('Ajustes reaplicados', 'ok');
}

function onVisibilityChange() {
  if (document.visibilityState !== 'visible' || state.mode !== 'emitter') return;
  requestWakeLock();
  if (state.track && state.track.readyState === 'ended') restartCapture(null);
  else reapplyAll(true);
}

/* ==========================================================
   5. UI Y SINCRONIZACIÓN DUAL
   ========================================================== */

function buildControlRegistry() {
  registry = {};
  NUMERIC_CONTROLS.forEach(c => {
    registry[c.key] = { kind: 'num', key: c.key, wrapper: dom['ctrl-' + c.id], range: dom[c.id + '-range'], number: dom[c.id + '-number'] };
  });
  ENUM_CONTROLS.forEach(c => {
    registry[c.key] = { kind: 'enum', key: c.key, wrapper: dom['ctrl-' + c.id], select: dom[c.id + '-select'], dependents: c.dependents };
  });
  BOOL_CONTROLS.forEach(c => {
    registry[c.key] = { kind: 'bool', key: c.key, wrapper: dom['ctrl-' + c.id], toggle: dom[c.id + '-toggle'] };
  });
}

/** Muestra solo lo que soporta el lente y fija min/max/step reales. */
function refreshControlsVisibility() {
  let visible = 0;
  Object.values(registry).forEach(r => {
    const cap = state.capabilities[r.key];
    let show = false;
    if (r.kind === 'num') {
      if (isSupported(r.key) && typeof cap === 'object' && cap.max > cap.min) {
        show = true;
        const range = cap.max - cap.min;
        const step = cap.step > 0 ? cap.step : (range >= 100 ? 1 : range / 100);
        [r.range, r.number].forEach(el => { el.min = cap.min; el.max = cap.max; el.step = step; });
      }
    } else if (r.kind === 'enum') {
      if (Array.isArray(cap) && cap.length) {
        show = true;
        r.select.innerHTML = '';
        cap.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; r.select.appendChild(o); });
      }
    } else if (r.kind === 'bool') {
      show = cap === true;
    }
    r.wrapper.classList.toggle('hidden', !show);
    if (show) visible++;
  });
  dom['sensor-controls'].classList.toggle('hidden', !state.track);
  dom['no-controls-msg'].classList.toggle('hidden', visible > 0);
}

/** Vuelca valores reales a sliders, números, selects y toggle (opcionalmente solo `onlyKeys`). */
function syncControlsFromSettings(settings, onlyKeys) {
  if (!settings) return;
  Object.values(registry).forEach(r => {
    if (onlyKeys && !onlyKeys.includes(r.key)) return;
    const v = settings[r.key];
    if (v === undefined) return;
    if (r.kind === 'num') { r.range.value = v; r.number.value = String(Number(Number(v).toFixed(6))); }
    else if (r.kind === 'enum') {
      if ([...r.select.options].some(o => o.value === v)) { r.select.value = v; updateDependentState(r.key, v); }
    } else if (r.kind === 'bool') r.toggle.checked = !!v;
  });
}

function bindNumericControl(entry) {
  const { key, range, number } = entry;
  // Slider: actualiza el número al instante y encola (throttle 100 ms, latest-wins).
  range.addEventListener('input', () => {
    number.value = range.value;
    queueConstraint(key, Number(range.value));
  });
  // Número: durante la escritura NO se aplica; solo se mueve el slider si el valor ya es válido.
  number.addEventListener('input', () => {
    const v = parseFloat(String(number.value).replace(',', '.'));
    if (Number.isFinite(v)) range.value = v;
  });
  const commit = () => commitNumber(key, number.value);
  number.addEventListener('change', commit);
  number.addEventListener('blur', commit);
  number.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
}

function commitNumber(key, rawValue) {
  const r = registry[key];
  const v = parseFloat(String(rawValue).replace(',', '.'));
  if (!Number.isFinite(v)) { r.number.value = r.range.value; return; }   // entrada inválida: restaura
  const clamped = clampToCapability(key, v);
  r.number.value = String(clamped);
  r.range.value = clamped;
  queueConstraint(key, clamped);
}

function clampToCapability(key, value) {
  const cap = state.capabilities[key];
  if (!cap || typeof cap !== 'object' || cap.min === undefined) return value;
  let v = value;
  if (cap.step > 0) v = cap.min + Math.round((v - cap.min) / cap.step) * cap.step;
  v = Math.min(cap.max, Math.max(cap.min, v));
  const dec = Math.min(6, ((String(cap.step || '').split('.')[1]) || '').length);
  return Number(v.toFixed(dec));
}

function bindEnumControl(entry) {
  entry.select.addEventListener('change', () => onModeChange(entry.key, entry.select.value));
}

function bindBitrateControls() {
  state.bitrateQueue = createLatestWinsQueue(v => setBitrate(v), THROTTLE_MS, false);
  dom['bitrate-range'].addEventListener('input', () => {
    dom['bitrate-number'].value = dom['bitrate-range'].value;
    state.bitrateQueue.push(Number(dom['bitrate-range'].value));
  });
  const commit = () => {
    const v = parseFloat(String(dom['bitrate-number'].value).replace(',', '.'));
    setBitrate(Number.isFinite(v) ? v : state.bitrateKbps);
  };
  dom['bitrate-number'].addEventListener('change', commit);
  dom['bitrate-number'].addEventListener('blur', commit);
  dom['bitrate-number'].addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
}

/** Habilita/deshabilita dependientes (ISO/tiempo/temperatura/distancia) según el modo. */
function updateDependentState(modeKey, value) {
  const entry = ENUM_CONTROLS.find(c => c.key === modeKey);
  if (!entry) return;
  const manual = value === 'manual';
  entry.dependents.forEach(dep => {
    const r = registry[dep];
    r.wrapper.classList.toggle('control-disabled', !manual);
    r.range.disabled = !manual;
    r.number.disabled = !manual;
    if (!manual) delete state.currentConstraints[dep];
  });
}

function bindStaticEvents() {
  dom['btn-apply-room'].addEventListener('click', applyRoom);
  dom['room-id-input'].addEventListener('change', applyRoom);
  dom['room-id-input'].addEventListener('keydown', e => { if (e.key === 'Enter') applyRoom(); });
  dom['room-password-input'].addEventListener('input', () => { state.roomPassword = dom['room-password-input'].value; });
  dom['btn-copy-url'].addEventListener('click', copyObsUrl);
  dom['btn-copy-fallback-close'].addEventListener('click', () => dom['copy-fallback-dialog'].close());
  dom['btn-oled'].addEventListener('click', enterOledMode);
  dom['camera-select'].addEventListener('change', () => switchCamera(dom['camera-select'].value));
  dom['resolution-select'].addEventListener('change', applyResolution);
  dom['fps-select'].addEventListener('change', applyResolution);
  dom['orientation-select'].addEventListener('change', () => setOrientation(dom['orientation-select'].value));
  dom['btn-reapply'].addEventListener('click', () => reapplyAll(false));
  dom['btn-reset-native'].addEventListener('click', resetToNative);
  dom['btn-save-profile'].addEventListener('click', saveProfile);
  dom['btn-apply-profile'].addEventListener('click', applyProfile);
  dom['btn-delete-profile'].addEventListener('click', deleteProfile);
  dom['btn-export-profile'].addEventListener('click', exportProfile);
  dom['btn-import-profile'].addEventListener('click', () => dom['profile-import-file'].click());
  dom['profile-import-file'].addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) importProfile(f);
    e.target.value = '';
  });
  dom['stats-details'].addEventListener('toggle', () => {
    if (dom['stats-details'].open) startStatsPolling(); else stopStatsPolling();
  });
  dom['oled-saver'].addEventListener('touchend', onOledTap, { passive: false });
  dom['oled-saver'].addEventListener('dblclick', exitOledMode);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', () => { destroyEmitterPeer(); releaseWakeLock(); stopCurrentTrack(); });
  window.addEventListener('online', () => { if (state.peer && state.peer.disconnected && !state.peer.destroyed) state.peer.reconnect(); });
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', enumerateCameras);
}

/** Cambia de sala: reinicia el peer con el nuevo ID. */
function applyRoom() {
  const id = loadRoomId(dom['room-id-input'].value);
  dom['room-id-input'].value = id;
  if (id === state.roomId && state.peer && !state.hasError) return;
  state.roomId = id;
  initEmitterPeer(id);
}

async function initEmitter(urlRoomId) {
  buildControlRegistry();
  NUMERIC_CONTROLS.forEach(c => bindNumericControl(registry[c.key]));
  ENUM_CONTROLS.forEach(c => bindEnumControl(registry[c.key]));
  dom['torch-toggle'].addEventListener('change', () => queueConstraint('torch', dom['torch-toggle'].checked));
  bindBitrateControls();
  state.applyQueue = createLatestWinsQueue(applyConstraintNow, THROTTLE_MS, true);
  bindStaticEvents();
  renderProfileList();
  state.roomId = loadRoomId(urlRoomId);
  dom['room-id-input'].value = state.roomId;
  initEmitterPeer(state.roomId);
  requestWakeLock();
  try {
    await startCamera(null);
  } catch (e) {
    state.hasError = true;
    setStatus('error', 'Cámara no disponible: ' + (e.name || e.message));
    showToast('Permite el acceso a la cámara (se requiere HTTPS)', 'error');
  }
}

/* ==========================================================
   6. PERFILES, OLED, WAKE LOCK Y MÉTRICAS
   ========================================================== */

/** Valores actuales de la UI, solo claves soportadas y activas (dependientes solo en manual). */
function collectCurrentSettings() {
  const out = {};
  Object.values(registry).forEach(r => {
    if (!isSupported(r.key) || r.wrapper.classList.contains('hidden')) return;
    if (r.kind === 'enum') out[r.key] = r.select.value;
    else if (r.kind === 'bool') out[r.key] = r.toggle.checked;
    else if (r.kind === 'num') {
      if (r.wrapper.classList.contains('control-disabled')) return;
      const v = Number(r.range.value);
      if (Number.isFinite(v)) out[r.key] = v;
    }
  });
  return out;
}

/** Acepta solo claves conocidas con el tipo correcto (perfiles importados). */
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  NUMERIC_CONTROLS.forEach(c => { const v = raw[c.key]; if (typeof v === 'number' && Number.isFinite(v)) out[c.key] = v; });
  ENUM_CONTROLS.forEach(c => { const v = raw[c.key]; if (typeof v === 'string' && v.length <= 32) out[c.key] = v; });
  BOOL_CONTROLS.forEach(c => { if (typeof raw[c.key] === 'boolean') out[c.key] = raw[c.key]; });
  return Object.keys(out).length ? out : null;
}

function saveProfile() {
  if (!state.track) { showToast('No hay cámara activa', 'error'); return; }
  const settings = collectCurrentSettings();
  const name = dom['profile-name-input'].value.trim().slice(0, 40) || `Perfil ${state.profiles.length + 1}`;
  const profile = { name, createdAt: new Date().toISOString(), settings };
  const i = state.profiles.findIndex(p => p.name === name);
  if (i >= 0) state.profiles[i] = profile; else state.profiles.push(profile);
  renderProfileList(name);
  dom['profile-name-input'].value = '';
  showToast(`Perfil «${name}» guardado (solo en esta sesión)`, 'ok');
}

function renderProfileList(selectName) {
  const sel = dom['profile-list-select'];
  sel.innerHTML = '';
  if (!state.profiles.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'Sin perfiles guardados'; o.disabled = true;
    sel.appendChild(o);
    return;
  }
  state.profiles.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = p.name;
    sel.appendChild(o);
  });
  const idx = state.profiles.findIndex(p => p.name === selectName);
  sel.value = String(idx >= 0 ? idx : state.profiles.length - 1);
}

function selectedProfile() {
  const i = parseInt(dom['profile-list-select'].value, 10);
  return Number.isInteger(i) ? state.profiles[i] : null;
}

async function applyProfile() {
  const p = selectedProfile();
  if (!p) { showToast('Selecciona un perfil', 'error'); return; }
  await applySettingsObject(p.settings);
  showToast(`Perfil «${p.name}» aplicado`, 'ok');
}

/** Filtra por capacidades, aplica clamp (Math.min/max) y envía modos primero, valores después. */
async function applySettingsObject(settings) {
  if (!state.track || !settings) return;
  const modes = {}, values = {};
  ENUM_CONTROLS.forEach(c => {
    const cap = state.capabilities[c.key], v = settings[c.key];
    if (Array.isArray(cap) && typeof v === 'string' && cap.includes(v)) modes[c.key] = v;
  });
  // 1) Modos (auto/manual) y estado de dependientes
  ENUM_CONTROLS.forEach(c => { if (modes[c.key]) { registry[c.key].select.value = modes[c.key]; updateDependentState(c.key, modes[c.key]); } });
  await pushAndFlush(modes);
  // 2) Valores numéricos/torch; los dependientes solo si su modo efectivo es manual
  NUMERIC_CONTROLS.forEach(c => {
    const v = Number(settings[c.key]);
    if (settings[c.key] === undefined || !Number.isFinite(v) || !isSupported(c.key) || typeof state.capabilities[c.key] !== 'object') return;
    const owner = ENUM_CONTROLS.find(e => e.dependents.includes(c.key));
    if (owner && registry[owner.key].select.value !== 'manual') return;
    const lo = state.capabilities[c.key].min, hi = state.capabilities[c.key].max;
    values[c.key] = clampToCapability(c.key, Math.min(hi, Math.max(lo, v)));
  });
  if (isSupported('torch') && typeof settings.torch === 'boolean') values.torch = settings.torch;
  await pushAndFlush(values);
  syncControlsFromSettings(Object.assign({}, modes, values));
}

function deleteProfile() {
  const p = selectedProfile();
  if (!p) return;
  state.profiles.splice(state.profiles.indexOf(p), 1);
  renderProfileList();
  showToast(`Perfil «${p.name}» eliminado`);
}

function exportProfile() {
  const p = selectedProfile() || { name: 'actual', createdAt: new Date().toISOString(), settings: collectCurrentSettings() };
  const payload = { app: 'webcam-p2p-obs', version: '2.1', name: p.name, createdAt: p.createdAt, settings: p.settings };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (p.name.replace(/[^\w-]+/g, '_').slice(0, 40) || 'perfil') + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importProfile(file) {
  if (file.size > 100 * 1024) { showToast('Archivo demasiado grande', 'error'); return; }
  const reader = new FileReader();
  reader.onerror = () => showToast('No se pudo leer el archivo', 'error');
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const settings = sanitizeSettings(data && data.settings);
      if (!settings) throw new Error('esquema inválido');
      const name = String(data.name || file.name.replace(/\.json$/i, '')).trim().slice(0, 40) || 'Importado';
      const profile = { name, createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(), settings };
      const i = state.profiles.findIndex(p => p.name === name);
      if (i >= 0) state.profiles[i] = profile; else state.profiles.push(profile);
      renderProfileList(name);
      showToast(`Perfil «${name}» importado`, 'ok');
    } catch (e) {
      showToast('JSON de perfil no válido', 'error');
    }
  };
  reader.readAsText(file);
}

/** Vuelve a los valores nativos del sensor leídos al abrir la cámara. */
async function resetToNative() {
  if (!state.track) return;
  if (!state.nativeSettings) readNativeSettings();
  await applySettingsObject(state.nativeSettings);
  syncControlsFromSettings(state.track.getSettings());
  showToast('Valores nativos restablecidos', 'ok');
}

/* ---------- Wake Lock ---------- */
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock || document.visibilityState !== 'visible') return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (e) { /* denegado o sin soporte */ }
}

function releaseWakeLock() {
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
}

/* ---------- Modo OLED (no corta la transmisión) ---------- */
function enterOledMode() {
  state.oled = true;
  dom['oled-saver'].classList.add('oled-active');
  dom['oled-saver'].setAttribute('aria-hidden', 'false');
  document.body.classList.add('oled-on');
  requestWakeLock();
}

function exitOledMode() {
  state.oled = false;
  dom['oled-saver'].classList.remove('oled-active');
  dom['oled-saver'].setAttribute('aria-hidden', 'true');
  document.body.classList.remove('oled-on');
}

/** Doble toque (ventana de 350 ms). preventDefault evita el clic fantasma sobre #btn-oled. */
function onOledTap(event) {
  event.preventDefault();
  const now = Date.now();
  if (now - lastOledTap < OLED_DOUBLE_TAP_MS) { lastOledTap = 0; exitOledMode(); }
  else lastOledTap = now;
}

/* ---------- Métricas bajo demanda ---------- */
function startStatsPolling() {
  if (!dom['stats-details'].open || state.statsTimer) return;
  state.lastStats = null;
  state.statsTimer = setInterval(pollStats, 1000);
  pollStats();
}

function stopStatsPolling() {
  clearInterval(state.statsTimer);
  state.statsTimer = null;
  state.lastStats = null;
}

async function pollStats() {
  if (!dom['stats-details'].open || document.hidden) return;
  let pc = null;
  state.calls.forEach(c => { if (!pc && c.peerConnection && c.peerConnection.connectionState === 'connected') pc = c.peerConnection; });
  if (!pc) { renderStats(null); return; }
  try {
    const report = await pc.getStats();
    let width = null, height = null, fps = null, bytes = null, ts = null, rtt = null;
    report.forEach(s => {
      if (s.type === 'outbound-rtp' && (s.kind || s.mediaType) === 'video') {
        width = s.frameWidth; height = s.frameHeight; fps = s.framesPerSecond; bytes = s.bytesSent; ts = s.timestamp;
      } else if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected) && s.currentRoundTripTime !== undefined) {
        rtt = s.currentRoundTripTime * 1000;
      }
    });
    let kbps = null;
    if (state.lastStats && bytes !== null && ts > state.lastStats.ts) {
      kbps = ((bytes - state.lastStats.bytes) * 8) / (ts - state.lastStats.ts);   // bits/ms = kbps
    }
    if (bytes !== null) state.lastStats = { bytes, ts };
    renderStats({ width, height, fps, kbps, rtt });
  } catch (e) {
    renderStats(null);
  }
}

function renderStats(data) {
  const dash = '–';
  dom['stats-resolution'].textContent = data && data.width ? `${data.width}×${data.height}` : dash;
  dom['stats-fps'].textContent = data && data.fps != null ? Math.round(data.fps) + ' fps' : dash;
  dom['stats-bitrate'].textContent = data && data.kbps != null ? Math.round(data.kbps) + ' kbps' : dash;
  dom['stats-rtt'].textContent = data && data.rtt != null ? Math.round(data.rtt) + ' ms' : dash;
}

/* ==========================================================
   ARRANQUE
   ========================================================== */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
else initApp();

})();
