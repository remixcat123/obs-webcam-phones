// webrtc.js — Señalización PeerJS (1.5.4), validación de clave, replaceTrack en caliente, parámetros RTP, Auto-Healing y métricas getStats().

import { getPeerConfig } from './config.js';

function extractPeerConnection(callOrPeer) {
  if (!callOrPeer) {
    return null;
  }
  if (callOrPeer.peerConnection) {
    return callOrPeer.peerConnection;
  }
  if (callOrPeer._pc) {
    return callOrPeer._pc;
  }
  return null;
}

function getVideoSenders(peerConnection) {
  if (!peerConnection || typeof peerConnection.getSenders !== 'function') {
    return [];
  }
  return peerConnection.getSenders().filter((sender) => sender && sender.track && sender.track.kind === 'video');
}

function isAuthErrorLike(err) {
  if (!err) {
    return false;
  }
  const message = typeof err === 'string' ? err : String(err.message || err.type || '');
  const normalized = message.toLowerCase();
  return (
    normalized.includes('auth') ||
    normalized.includes('password') ||
    normalized.includes('clave') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  );
}

export async function applySenderEncodingParams(peerConnection, bitrateKbps) {
  if (!peerConnection || typeof peerConnection.getSenders !== 'function') {
    return;
  }

  const numericKbps = Number(bitrateKbps);
  const hasBitrate = Number.isFinite(numericKbps) && numericKbps > 0;
  const maxBitrateBps = hasBitrate ? Math.round(numericKbps * 1000) : undefined;

  const senders = getVideoSenders(peerConnection);
  for (const sender of senders) {
    if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') {
      continue;
    }

    try {
      const params = sender.getParameters();
      if (!params || typeof params !== 'object') {
        continue;
      }

      if (!Array.isArray(params.encodings) || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      params.encodings = params.encodings.map((encoding) => {
        const nextEncoding = { ...(encoding || {}) };
        if (typeof maxBitrateBps === 'number') {
          nextEncoding.maxBitrate = maxBitrateBps;
        }
        return nextEncoding;
      });

      params.degradationPreference = 'maintain-resolution';

      await sender.setParameters(params);
    } catch (_err) {
      // Algunos navegadores pueden rechazar o limitar ciertos campos de RTCRtpSendParameters
    }
  }
}

export async function replaceActiveVideoTrack(peerConnection, newTrack) {
  if (!peerConnection || typeof peerConnection.getSenders !== 'function') {
    return false;
  }

  const senders = getVideoSenders(peerConnection);
  if (senders.length === 0) {
    return false;
  }

  let replacedAny = false;
  for (const sender of senders) {
    if (typeof sender.replaceTrack === 'function') {
      await sender.replaceTrack(newTrack || null);
      replacedAny = true;
    }
  }

  return replacedAny;
}

export function createEmitterPeer(options = {}) {
  const {
    roomId,
    getPassword = () => '',
    getStream = () => null,
    bitrateKbps = 4000,
    peerConfig = {},
    onIncomingCall = null,
    onStatusChange = null,
    onError = null
  } = options;

  if (typeof Peer === 'undefined') {
    const err = new Error('PeerJS (1.5.4) no está cargado en el entorno global.');
    if (typeof onError === 'function') {
      onError(err);
    }
    throw err;
  }

  let currentBitrateKbps = Number.isFinite(Number(bitrateKbps)) && Number(bitrateKbps) > 0 ? Number(bitrateKbps) : 4000;
  const activeCalls = new Set();
  let destroyed = false;

  const resolvedPeerConfig = getPeerConfig(peerConfig);
  const peer = roomId ? new Peer(roomId, resolvedPeerConfig) : new Peer(resolvedPeerConfig);

  const emitStatus = (status, detail) => {
    if (!destroyed && typeof onStatusChange === 'function') {
      onStatusChange(status, detail);
    }
  };

  const emitError = (err) => {
    if (!destroyed && typeof onError === 'function') {
      onError(err);
    }
  };

  const syncActiveCallParams = async (call) => {
    const pc = extractPeerConnection(call);
    if (pc) {
      await applySenderEncodingParams(pc, currentBitrateKbps);
    }
  };

  const cleanupCall = (call) => {
    activeCalls.delete(call);
    if (!destroyed && activeCalls.size === 0 && peer && !peer.destroyed) {
      emitStatus('ready', { roomId: peer.id || roomId });
    }
  };

  emitStatus('initializing', { roomId });

  peer.on('open', (id) => {
    if (destroyed) {
      return;
    }
    emitStatus('ready', { roomId: id || roomId });
  });

  peer.on('call', async (call) => {
    if (destroyed) {
      try {
        call.close();
      } catch (_err) {
        // Ignorar cierre en peer destruido
      }
      return;
    }

    const expectedPassword = typeof getPassword === 'function' ? String(getPassword() || '') : '';
    const incomingPassword =
      call && call.metadata && typeof call.metadata.password === 'string'
        ? call.metadata.password
        : '';

    if (expectedPassword.length > 0 && incomingPassword !== expectedPassword) {
      try {
        call.close();
      } catch (_err) {
        // Ignorar cierre tras rechazo
      }
      emitError(new Error('Contraseña de sala inválida en llamada entrante.'));
      return;
    }

    const stream = typeof getStream === 'function' ? getStream() : null;
    if (!stream) {
      try {
        call.close();
      } catch (_err) {
        // Ignorar cierre si no hay flujo disponible
      }
      emitError(new Error('No hay flujo de video disponible para responder la llamada.'));
      return;
    }

    activeCalls.add(call);
    if (typeof onIncomingCall === 'function') {
      onIncomingCall(call);
    }

    call.on('stream', () => {
      // El receptor puede enviar un flujo de retorno vacío; el emisor transmite su MediaStream local
    });

    call.on('close', () => {
      cleanupCall(call);
    });

    call.on('error', (callErr) => {
      cleanupCall(call);
      emitError(callErr);
    });

    const pc = extractPeerConnection(call);
    if (pc) {
      pc.addEventListener('connectionstatechange', () => {
        if (destroyed) {
          return;
        }
        if (pc.connectionState === 'connected') {
          emitStatus('streaming', { roomId: peer.id || roomId, activeCalls: activeCalls.size });
          syncActiveCallParams(call);
        } else if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected' ||
          pc.connectionState === 'closed'
        ) {
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            cleanupCall(call);
          }
        }
      });
    }

    try {
      call.answer(stream);
      emitStatus('streaming', { roomId: peer.id || roomId, activeCalls: activeCalls.size });
      await syncActiveCallParams(call);
    } catch (answerErr) {
      cleanupCall(call);
      emitError(answerErr);
    }
  });

  peer.on('disconnected', () => {
    if (destroyed) {
      return;
    }
    emitStatus('initializing', { roomId, disconnected: true });
    if (peer && !peer.destroyed && typeof peer.reconnect === 'function') {
      try {
        peer.reconnect();
      } catch (reconnectErr) {
        emitError(reconnectErr);
      }
    }
  });

  peer.on('close', () => {
    activeCalls.clear();
    if (!destroyed) {
      emitStatus('initializing', { roomId, closed: true });
    }
  });

  peer.on('error', (err) => {
    if (destroyed) {
      return;
    }
    emitError(err);
  });

  const setMaxBitrate = async (kbps) => {
    const parsed = Number(kbps);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }
    currentBitrateKbps = parsed;
    const updates = [];
    for (const call of activeCalls) {
      const pc = extractPeerConnection(call);
      if (pc) {
        updates.push(applySenderEncodingParams(pc, currentBitrateKbps));
      }
    }
    await Promise.all(updates);
  };

  const destroy = () => {
    destroyed = true;
    for (const call of Array.from(activeCalls)) {
      try {
        call.close();
      } catch (_err) {
        // Ignorar cierre durante destrucción
      }
    }
    activeCalls.clear();

    if (peer && !peer.destroyed && typeof peer.destroy === 'function') {
      try {
        peer.destroy();
      } catch (_err) {
        // Ignorar errores al destruir peer
      }
    }
  };

  return {
    peer,
    destroy,
    setMaxBitrate
  };
}

export function startViewerAutoHealing(options = {}) {
  const {
    targetPeerId,
    getPassword = () => null,
    peerConfig = {},
    retryIntervalMs = 2500,
    onStream,
    onAuthRequired,
    onStateChange = null
  } = options;

  const intervalMs = Math.max(800, Number.isFinite(Number(retryIntervalMs)) ? Number(retryIntervalMs) : 2500);
  const resolvedPeerConfig = getPeerConfig(peerConfig);

  let stopped = false;
  let peer = null;
  let activeCall = null;
  let retryTimerId = null;
  let streamWatchdogId = null;
  let hasReceivedStream = false;
  let authPrompted = false;

  const notifyState = (state) => {
    if (!stopped && typeof onStateChange === 'function') {
      onStateChange(state);
    }
  };

  const clearTimers = () => {
    if (retryTimerId !== null) {
      clearInterval(retryTimerId);
      retryTimerId = null;
    }
    if (streamWatchdogId !== null) {
      clearTimeout(streamWatchdogId);
      streamWatchdogId = null;
    }
  };

  const closeCurrentCall = () => {
    if (activeCall) {
      try {
        activeCall.close();
      } catch (_err) {
        // Ignorar error al cerrar llamada previa
      }
      activeCall = null;
    }
  };

  const placeCallToEmitter = () => {
    if (stopped || !targetPeerId || !peer || peer.destroyed || !peer.open) {
      return;
    }

    // Evitar solapar llamadas si ya existe una en curso o activa
    if (activeCall && activeCall.open) {
      return;
    }

    closeCurrentCall();
    hasReceivedStream = false;
    notifyState('calling');

    const password = typeof getPassword === 'function' ? getPassword() : null;
    const callOptions = {
      metadata: {
        password: typeof password === 'string' ? password : ''
      }
    };

    try {
      const call = peer.call(targetPeerId, null, callOptions);
      if (!call) {
        return;
      }

      activeCall = call;

      if (streamWatchdogId !== null) {
        clearTimeout(streamWatchdogId);
      }

      streamWatchdogId = setTimeout(() => {
        if (stopped || hasReceivedStream) {
          return;
        }
        // Si tras el ciclo de espera no llegó flujo y la llamada quedó cerrada/rechazada
        if (!activeCall || !activeCall.open) {
          if (!authPrompted && typeof onAuthRequired === 'function') {
            authPrompted = true;
            onAuthRequired('No se recibió transmisión. Verifica el ID de sala o la contraseña.');
          }
          notifyState('retrying');
        }
      }, Math.max(intervalMs * 2, 4000));

      call.on('stream', (remoteStream) => {
        if (stopped || !remoteStream) {
          return;
        }
        hasReceivedStream = true;
        authPrompted = false;
        if (streamWatchdogId !== null) {
          clearTimeout(streamWatchdogId);
          streamWatchdogId = null;
        }
        notifyState('streaming');
        if (typeof onStream === 'function') {
          onStream(remoteStream);
        }

        const videoTracks = remoteStream.getVideoTracks();
        for (const track of videoTracks) {
          track.addEventListener('ended', () => {
            if (!stopped) {
              hasReceivedStream = false;
              notifyState('retrying');
              closeCurrentCall();
            }
          });
        }
      });

      call.on('close', () => {
        if (stopped) {
          return;
        }
        const wasStreaming = hasReceivedStream;
        hasReceivedStream = false;
        if (activeCall === call) {
          activeCall = null;
        }
        if (!wasStreaming && !authPrompted && typeof onAuthRequired === 'function') {
          authPrompted = true;
          onAuthRequired('Conexión cerrada por el emisor o contraseña requerida.');
        }
        notifyState('retrying');
      });

      call.on('error', (callErr) => {
        if (stopped) {
          return;
        }
        hasReceivedStream = false;
        if (activeCall === call) {
          activeCall = null;
        }
        if (isAuthErrorLike(callErr) && typeof onAuthRequired === 'function') {
          authPrompted = true;
          onAuthRequired('Contraseña incorrecta o requerida.');
        }
        notifyState('retrying');
      });

      const pc = extractPeerConnection(call);
      if (pc) {
        pc.addEventListener('connectionstatechange', () => {
          if (stopped) {
            return;
          }
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            hasReceivedStream = false;
            notifyState('retrying');
            if (pc.connectionState === 'failed') {
              closeCurrentCall();
            }
          } else if (pc.connectionState === 'connected' && hasReceivedStream) {
            notifyState('streaming');
          }
        });
      }
    } catch (_callErr) {
      notifyState('retrying');
    }
  };

  const ensurePeerInstance = () => {
    if (stopped) {
      return;
    }

    if (!peer || peer.destroyed) {
      notifyState('connecting');
      peer = new Peer(resolvedPeerConfig);

      peer.on('open', () => {
        if (stopped) {
          return;
        }
        notifyState('connected');
        placeCallToEmitter();
      });

      peer.on('disconnected', () => {
        if (stopped) {
          return;
        }
        hasReceivedStream = false;
        notifyState('retrying');
        if (peer && !peer.destroyed && typeof peer.reconnect === 'function') {
          try {
            peer.reconnect();
          } catch (_err) {
            // Reintento gestionado por el ciclo periódico
          }
        }
      });

      peer.on('close', () => {
        if (stopped) {
          return;
        }
        hasReceivedStream = false;
        closeCurrentCall();
        notifyState('retrying');
      });

      peer.on('error', (err) => {
        if (stopped) {
          return;
        }
        hasReceivedStream = false;
        if (isAuthErrorLike(err) && typeof onAuthRequired === 'function') {
          authPrompted = true;
          onAuthRequired('Contraseña requerida o inválida.');
        }
        notifyState('retrying');
      });
    } else if (peer.open) {
      placeCallToEmitter();
    } else if (typeof peer.reconnect === 'function') {
      try {
        peer.reconnect();
      } catch (_err) {
        // Ignorar error de reconexión temporal
      }
    }
  };

  ensurePeerInstance();

  retryTimerId = setInterval(() => {
    if (stopped) {
      return;
    }
    ensurePeerInstance();
    if (peer && peer.open && (!activeCall || !activeCall.open)) {
      placeCallToEmitter();
    }
  }, intervalMs);

  const retryNow = (_newPassword) => {
    if (stopped) {
      return;
    }
    authPrompted = false;
    hasReceivedStream = false;
    closeCurrentCall();
    ensurePeerInstance();
    placeCallToEmitter();
  };

  const stop = () => {
    stopped = true;
    clearTimers();
    closeCurrentCall();
    if (peer && !peer.destroyed && typeof peer.destroy === 'function') {
      try {
        peer.destroy();
      } catch (_err) {
        // Ignorar error al destruir peer del receptor
      }
    }
    peer = null;
  };

  return {
    stop,
    retryNow
  };
}

export async function collectWebRtcStats(peerConnection, prevSample = null) {
  const emptyResult = {
    resolution: '—',
    fps: 0,
    bitrateKbps: 0,
    rttMs: null,
    sample: prevSample || null
  };

  if (!peerConnection || typeof peerConnection.getStats !== 'function') {
    return emptyResult;
  }

  let report;
  try {
    report = await peerConnection.getStats();
  } catch (_err) {
    return emptyResult;
  }

  if (!report || typeof report.forEach !== 'function') {
    return emptyResult;
  }

  let width = null;
  let height = null;
  let fps = 0;
  let bytesSent = null;
  let timestamp = null;
  let rttMs = null;

  report.forEach((stat) => {
    if (!stat || typeof stat !== 'object') {
      return;
    }

    if (stat.type === 'outbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video')) {
      if (typeof stat.frameWidth === 'number' && typeof stat.frameHeight === 'number') {
        width = stat.frameWidth;
        height = stat.frameHeight;
      }
      if (typeof stat.framesPerSecond === 'number' && Number.isFinite(stat.framesPerSecond)) {
        fps = Math.round(stat.framesPerSecond);
      }
      if (typeof stat.bytesSent === 'number' && Number.isFinite(stat.bytesSent)) {
        bytesSent = stat.bytesSent;
        timestamp = typeof stat.timestamp === 'number' ? stat.timestamp : performance.now();
      }
    }

    if (
      rttMs === null &&
      stat.type === 'candidate-pair' &&
      stat.state === 'succeeded' &&
      typeof stat.currentRoundTripTime === 'number' &&
      Number.isFinite(stat.currentRoundTripTime)
    ) {
      rttMs = Math.round(stat.currentRoundTripTime * 1000);
    }

    if (
      rttMs === null &&
      stat.type === 'remote-inbound-rtp' &&
      (stat.kind === 'video' || stat.mediaType === 'video') &&
      typeof stat.roundTripTime === 'number' &&
      Number.isFinite(stat.roundTripTime)
    ) {
      rttMs = Math.round(stat.roundTripTime * 1000);
    }
  });

  // Respaldo de resolución desde el sender si outbound-rtp aún no reporta dimensiones
  if ((width === null || height === null) && typeof peerConnection.getSenders === 'function') {
    const videoSender = getVideoSenders(peerConnection)[0];
    const trackSettings =
      videoSender && videoSender.track && typeof videoSender.track.getSettings === 'function'
        ? videoSender.track.getSettings()
        : null;
    if (trackSettings && trackSettings.width && trackSettings.height) {
      width = trackSettings.width;
      height = trackSettings.height;
    }
  }

  let bitrateKbps = 0;
  let nextSample = prevSample || null;

  if (typeof bytesSent === 'number' && typeof timestamp === 'number') {
    if (
      prevSample &&
      typeof prevSample.bytesSent === 'number' &&
      typeof prevSample.timestamp === 'number' &&
      timestamp > prevSample.timestamp
    ) {
      const deltaBytes = bytesSent - prevSample.bytesSent;
      const deltaSeconds = (timestamp - prevSample.timestamp) / 1000;
      if (deltaBytes >= 0 && deltaSeconds > 0) {
        bitrateKbps = Math.round((deltaBytes * 8) / 1000 / deltaSeconds);
      }
    }
    nextSample = { timestamp, bytesSent };
  }

  const resolution =
    typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
      ? `${width}×${height}`
      : '—';

  return {
    resolution,
    fps,
    bitrateKbps,
    rttMs,
    sample: nextSample
  };
}