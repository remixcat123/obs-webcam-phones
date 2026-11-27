import { getPeerConfig } from './config.js';

function getPeerConstructor() {
  if (typeof Peer === 'function') {
    return Peer;
  }
  if (typeof globalThis !== 'undefined' && typeof globalThis.Peer === 'function') {
    return globalThis.Peer;
  }
  return null;
}

function hasValidVideoStream(stream) {
  if (!stream || typeof stream.getVideoTracks !== 'function') {
    return false;
  }
  return stream.getVideoTracks().some((t) => t && t.readyState === 'live');
}

export async function applySenderEncodingParams(peerConnection, bitrateKbps) {
  if (!peerConnection || typeof peerConnection.getSenders !== 'function') {
    return;
  }

  const numericBitrate = Number(bitrateKbps);
  const maxBitrateBps =
    Number.isFinite(numericBitrate) && numericBitrate > 0
      ? Math.round(numericBitrate * 1000)
      : undefined;

  const senders = peerConnection.getSenders();
  for (const sender of senders) {
    if (!sender || !sender.track || sender.track.kind !== 'video') {
      continue;
    }
    if (
      typeof sender.getParameters !== 'function' ||
      typeof sender.setParameters !== 'function'
    ) {
      continue;
    }

    const params = sender.getParameters() || {};
    const encodings =
      Array.isArray(params.encodings) && params.encodings.length > 0
        ? params.encodings.map((enc) => ({ ...enc }))
        : [{}];

    for (const enc of encodings) {
      if (maxBitrateBps !== undefined) {
        enc.maxBitrate = maxBitrateBps;
      }
    }

    const updatedParams = {
      ...params,
      encodings,
      degradationPreference: 'maintain-resolution',
    };

    try {
      await sender.setParameters(updatedParams);
    } catch (_) {
      try {
        await sender.setParameters({
          ...params,
          encodings,
        });
      } catch (_) {}
    }
  }
}

export async function replaceActiveVideoTrack(peerConnection, newTrack) {
  if (!peerConnection || typeof peerConnection.getSenders !== 'function') {
    return false;
  }

  if (newTrack) {
    newTrack.enabled = true;
  }

  const senders = peerConnection.getSenders();
  let replaced = false;

  for (const sender of senders) {
    if (!sender) continue;
    const isVideoSender =
      (sender.track && sender.track.kind === 'video') ||
      (!sender.track && newTrack && newTrack.kind === 'video');

    if (!isVideoSender) continue;

    if (typeof sender.replaceTrack === 'function') {
      try {
        await sender.replaceTrack(newTrack || null);
        replaced = true;
      } catch (_) {
        // Evita dejar colgada la llamada si un sender no admite replaceTrack directamente
      }
    }
  }

  return replaced;
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
    onError = null,
  } = options || {};

  const PeerCtor = getPeerConstructor();
  if (!PeerCtor) {
    const err = new Error('PeerJS no está cargado en el entorno global.');
    if (typeof onError === 'function') onError(err);
    throw err;
  }

  let currentBitrateKbps = Number(bitrateKbps) > 0 ? Number(bitrateKbps) : 4000;
  let destroyed = false;
  const activeCalls = new Set();

  const notifyStatus = (status, detail) => {
    if (!destroyed && typeof onStatusChange === 'function') {
      onStatusChange(status, detail);
    }
  };

  const notifyError = (err) => {
    if (!destroyed && typeof onError === 'function') {
      onError(err);
    }
  };

  notifyStatus('init', { roomId });

  const resolvedPeerConfig = getPeerConfig(peerConfig);
  const peer = roomId
    ? new PeerCtor(String(roomId), resolvedPeerConfig)
    : new PeerCtor(resolvedPeerConfig);

  const attachPeerConnectionHandlers = (call, pc) => {
    if (!pc || pc.__obsP2pBound) return;
    pc.__obsP2pBound = true;
    applySenderEncodingParams(pc, currentBitrateKbps);

    pc.addEventListener('connectionstatechange', () => {
      if (destroyed) return;
      if (pc.connectionState === 'connected') {
        notifyStatus('streaming', { activeCalls: activeCalls.size });
      } else if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        if (call) activeCalls.delete(call);
        notifyStatus(activeCalls.size > 0 ? 'streaming' : 'ready', {
          activeCalls: activeCalls.size,
        });
      }
    });
  };

  const bindCallLifecycle = (call) => {
    if (!call) return;
    activeCalls.add(call);

    if (call.peerConnection) {
      attachPeerConnectionHandlers(call, call.peerConnection);
    }

    const cleanupCall = () => {
      activeCalls.delete(call);
      if (!destroyed) {
        notifyStatus(activeCalls.size > 0 ? 'streaming' : 'ready', {
          activeCalls: activeCalls.size,
        });
      }
    };

    call.on('stream', () => {
      if (call.peerConnection) {
        attachPeerConnectionHandlers(call, call.peerConnection);
      }
      if (!destroyed) {
        notifyStatus('streaming', { activeCalls: activeCalls.size });
      }
    });
    call.on('close', cleanupCall);
    call.on('error', (callErr) => {
      cleanupCall();
      notifyError(callErr);
    });
  };

  peer.on('open', (id) => {
    if (destroyed) return;
    notifyStatus('ready', { peerId: id, activeCalls: activeCalls.size });
  });

  peer.on('call', (call) => {
    if (destroyed) {
      try {
        call.close();
      } catch (_) {}
      return;
    }

    if (typeof onIncomingCall === 'function') {
      try {
        onIncomingCall(call);
      } catch (_) {}
    }

    const expectedPassword =
      typeof getPassword === 'function' ? String(getPassword() || '') : '';
    const providedPassword =
      call && call.metadata && typeof call.metadata.password === 'string'
        ? call.metadata.password
        : '';

    if (expectedPassword.length > 0 && providedPassword !== expectedPassword) {
      const authError = new Error('Contraseña de sala inválida o faltante.');
      authError.code = 'INVALID_PASSWORD';
      try {
        if (call.peerConnection && typeof call.peerConnection.close === 'function') {
          call.peerConnection.close();
        }
        call.close();
      } catch (_) {}
      notifyError(authError);
      return;
    }

    const stream = typeof getStream === 'function' ? getStream() : null;
    if (!hasValidVideoStream(stream)) {
      const streamError = new Error(
        'No hay MediaStream de video activo disponible para responder la llamada.'
      );
      try {
        if (call.peerConnection && typeof call.peerConnection.close === 'function') {
          call.peerConnection.close();
        }
        call.close();
      } catch (_) {}
      notifyError(streamError);
      return;
    }

    stream.getVideoTracks().forEach((t) => {
      if (t) t.enabled = true;
    });

    bindCallLifecycle(call);

    try {
      call.answer(stream);
      if (call.peerConnection) {
        attachPeerConnectionHandlers(call, call.peerConnection);
      }
      if (typeof onIncomingCall === 'function') {
        try {
          onIncomingCall(call);
        } catch (_) {}
      }
      notifyStatus('streaming', { activeCalls: activeCalls.size });
    } catch (answerErr) {
      activeCalls.delete(call);
      notifyError(answerErr);
    }
  });

  peer.on('disconnected', () => {
    if (destroyed) return;
    notifyStatus('init', { reconnecting: true });
    if (!peer.destroyed && typeof peer.reconnect === 'function') {
      try {
        peer.reconnect();
      } catch (err) {
        notifyError(err);
      }
    }
  });

  peer.on('close', () => {
    activeCalls.clear();
    if (!destroyed) {
      notifyStatus('init', { closed: true });
    }
  });

  peer.on('error', (err) => {
    notifyError(err);
  });

  const setMaxBitrate = async (kbps) => {
    const numeric = Number(kbps);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    currentBitrateKbps = numeric;

    const tasks = [];
    for (const call of activeCalls) {
      if (call && call.peerConnection) {
        tasks.push(applySenderEncodingParams(call.peerConnection, currentBitrateKbps));
      }
    }
    await Promise.allSettled(tasks);
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;

    for (const call of activeCalls) {
      try {
        call.close();
      } catch (_) {}
    }
    activeCalls.clear();

    try {
      peer.destroy();
    } catch (_) {}
  };

  return {
    peer,
    destroy,
    setMaxBitrate,
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
    onStateChange = null,
  } = options || {};

  const PeerCtor = getPeerConstructor();
  if (!PeerCtor) {
    throw new Error('PeerJS no está cargado en el entorno global.');
  }

  let stopped = false;
  let retryTimer = null;
  let noStreamWatchdogTimer = null;
  let peer = null;
  let activeCall = null;
  let hasActiveStream = false;
  let isCalling = false;
  let authNotified = false;
  let currentPasswordOverride;

  const interval = Math.max(500, Number(retryIntervalMs) || 2500);

  const emitState = (state) => {
    if (!stopped && typeof onStateChange === 'function') {
      onStateChange(state);
    }
  };

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const clearNoStreamWatchdog = () => {
    if (noStreamWatchdogTimer !== null) {
      clearTimeout(noStreamWatchdogTimer);
      noStreamWatchdogTimer = null;
    }
  };

  const cleanupCall = () => {
    clearNoStreamWatchdog();
    isCalling = false;
    hasActiveStream = false;
    if (activeCall) {
      try {
        activeCall.close();
      } catch (_) {}
      activeCall = null;
    }
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!stopped) {
        attemptCall();
      }
    }, interval);
  };

  const getEffectivePassword = () => {
    if (currentPasswordOverride !== undefined) {
      return currentPasswordOverride;
    }
    return typeof getPassword === 'function' ? getPassword() : null;
  };

  const createSilentDummyStream = () => {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      if (typeof canvas.captureStream === 'function') {
        const s = canvas.captureStream(1);
        if (s && s.getVideoTracks().length > 0) {
          return s;
        }
      }
    }
    return new MediaStream();
  };

  const attemptCall = () => {
    if (stopped || !targetPeerId) return;
    if (!peer || peer.destroyed || !peer.open) {
      emitState('connecting');
      scheduleReconnect();
      return;
    }
    if (isCalling || hasActiveStream) {
      return;
    }

    isCalling = true;
    emitState('calling');

    const pw = getEffectivePassword();
    const metadata = {
      password: pw !== null && pw !== undefined ? String(pw) : '',
    };

    let call = null;
    let streamReceived = false;

    try {
      call = peer.call(String(targetPeerId), createSilentDummyStream(), { metadata });
    } catch (_) {
      isCalling = false;
      emitState('retrying');
      scheduleReconnect();
      return;
    }

    if (!call) {
      isCalling = false;
      emitState('retrying');
      scheduleReconnect();
      return;
    }

    activeCall = call;

    const handleStreamLoss = (isAuthSuspect) => {
      if (stopped) return;
      const wasStreaming = streamReceived || hasActiveStream;
      cleanupCall();
      emitState('retrying');

      if (!wasStreaming && isAuthSuspect && !authNotified && typeof onAuthRequired === 'function') {
        authNotified = true;
        onAuthRequired('La sala requiere contraseña o la clave proporcionada no es válida.');
      }

      scheduleReconnect();
    };

    clearNoStreamWatchdog();
    noStreamWatchdogTimer = setTimeout(() => {
      if (!stopped && activeCall === call && !streamReceived) {
        handleStreamLoss(false);
      }
    }, Math.max(5000, interval * 2.5));

    call.on('stream', (remoteStream) => {
      if (stopped || activeCall !== call) return;
      clearNoStreamWatchdog();
      streamReceived = true;
      hasActiveStream = true;
      isCalling = false;
      authNotified = false;
      clearRetryTimer();
      emitState('streaming');

      if (remoteStream && typeof remoteStream.getVideoTracks === 'function') {
        remoteStream.getVideoTracks().forEach((track) => {
          track.addEventListener('ended', () => {
            if (!stopped && activeCall === call) {
              handleStreamLoss(false);
            }
          });
        });
      }

      if (typeof onStream === 'function' && remoteStream) {
        onStream(remoteStream);
      }
    });

    call.on('iceStateChanged', (iceState) => {
      if (stopped || activeCall !== call) return;
      if (iceState === 'failed' || iceState === 'disconnected') {
        handleStreamLoss(!streamReceived);
      }
    });

    call.on('close', () => {
      if (!stopped && activeCall === call) {
        handleStreamLoss(!streamReceived);
      }
    });

    call.on('error', () => {
      if (!stopped && activeCall === call) {
        handleStreamLoss(!streamReceived);
      }
    });

    const bindPcIceHandlers = (pc) => {
      if (!pc || pc.__viewerIceBound) return;
      pc.__viewerIceBound = true;

      pc.oniceconnectionstatechange = () => {
        if (stopped || activeCall !== call) return;
        const iceState = pc.iceConnectionState;
        if (iceState === 'failed' || iceState === 'disconnected') {
          handleStreamLoss(!streamReceived);
        }
      };

      pc.addEventListener('iceconnectionstatechange', () => {
        if (stopped || activeCall !== call) return;
        const iceState = pc.iceConnectionState;
        if (iceState === 'failed' || iceState === 'disconnected') {
          handleStreamLoss(!streamReceived);
        }
      });

      pc.addEventListener('connectionstatechange', () => {
        if (stopped || activeCall !== call) return;
        const state = pc.connectionState;
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          handleStreamLoss(!streamReceived);
        }
      });
    };

    if (call.peerConnection) {
      bindPcIceHandlers(call.peerConnection);
    }
    call.on('stream', () => {
      if (call.peerConnection) {
        bindPcIceHandlers(call.peerConnection);
      }
    });
  };

  const initPeer = () => {
    if (stopped) return;
    emitState('connecting');

    const resolvedConfig = getPeerConfig(peerConfig);
    peer = new PeerCtor(resolvedConfig);

    peer.on('open', () => {
      if (stopped) return;
      emitState('connected');
      attemptCall();
    });

    peer.on('disconnected', () => {
      if (stopped) return;
      cleanupCall();
      emitState('reconnecting');
      if (peer && !peer.destroyed && typeof peer.reconnect === 'function') {
        try {
          peer.reconnect();
        } catch (_) {
          scheduleReconnect();
        }
      } else {
        scheduleReconnect();
      }
    });

    peer.on('close', () => {
      if (stopped) return;
      cleanupCall();
      emitState('retrying');
      scheduleReconnect();
    });

    peer.on('error', (err) => {
      if (stopped) return;
      const errType = err && err.type ? String(err.type) : '';
      const errMsg = err && err.message ? String(err.message).toLowerCase() : '';
      const isAuthError =
        errType.includes('auth') ||
        errMsg.includes('password') ||
        errMsg.includes('auth');

      cleanupCall();
      emitState('retrying');

      if (!hasActiveStream && isAuthError && !authNotified && typeof onAuthRequired === 'function') {
        authNotified = true;
        onAuthRequired(err.message || 'Autenticación requerida.');
      }

      scheduleReconnect();
    });
  };

  initPeer();

  const retryNow = (newPassword) => {
    if (stopped) return;
    if (newPassword !== undefined) {
      currentPasswordOverride = newPassword;
    }
    authNotified = false;
    clearRetryTimer();
    cleanupCall();

    if (!peer || peer.destroyed) {
      initPeer();
      return;
    }

    if (!peer.open && typeof peer.reconnect === 'function') {
      try {
        peer.reconnect();
      } catch (_) {}
    }

    attemptCall();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearRetryTimer();
    cleanupCall();
    if (peer) {
      try {
        peer.destroy();
      } catch (_) {}
      peer = null;
    }
    emitState('stopped');
  };

  return {
    stop,
    retryNow,
  };
}

export async function collectWebRtcStats(peerConnection, prevSample = null) {
  const emptyResult = {
    resolution: 'N/A',
    fps: 0,
    bitrateKbps: 0,
    rttMs: null,
    sample: prevSample || null,
  };

  if (!peerConnection || typeof peerConnection.getStats !== 'function') {
    return emptyResult;
  }

  let report;
  try {
    report = await peerConnection.getStats();
  } catch (_) {
    return emptyResult;
  }

  if (!report || typeof report.forEach !== 'function') {
    return emptyResult;
  }

  let resolution = 'N/A';
  let fps = 0;
  let totalBytesSent = 0;
  let totalFramesEncoded = 0;
  let sampleTimestamp = null;
  let rttMs = null;
  const trackMap = new Map();
  const candidatePairs = [];

  report.forEach((stat) => {
    if (!stat || typeof stat !== 'object') return;
    if (stat.type === 'track' || stat.type === 'media-source') {
      if (stat.id) {
        trackMap.set(stat.id, stat);
      }
    }
    if (stat.type === 'candidate-pair') {
      candidatePairs.push(stat);
    }
  });

  report.forEach((stat) => {
    if (!stat || typeof stat !== 'object') return;

    if (stat.type === 'outbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video')) {
      if (typeof stat.bytesSent === 'number') {
        totalBytesSent += stat.bytesSent;
      }
      if (typeof stat.framesEncoded === 'number') {
        totalFramesEncoded += stat.framesEncoded;
      }
      if (
        typeof stat.timestamp === 'number' &&
        (sampleTimestamp === null || stat.timestamp > sampleTimestamp)
      ) {
        sampleTimestamp = stat.timestamp;
      }

      if (typeof stat.framesPerSecond === 'number' && stat.framesPerSecond > 0) {
        fps = Math.round(stat.framesPerSecond);
      }

      if (
        typeof stat.frameWidth === 'number' &&
        typeof stat.frameHeight === 'number' &&
        stat.frameWidth > 0 &&
        stat.frameHeight > 0
      ) {
        resolution = `${stat.frameWidth}x${stat.frameHeight}`;
      } else if (stat.trackId && trackMap.has(stat.trackId)) {
        const trackStat = trackMap.get(stat.trackId);
        if (
          typeof trackStat.frameWidth === 'number' &&
          typeof trackStat.frameHeight === 'number' &&
          trackStat.frameWidth > 0 &&
          trackStat.frameHeight > 0
        ) {
          resolution = `${trackStat.frameWidth}x${trackStat.frameHeight}`;
        }
      }
    }

    if (
      rttMs === null &&
      stat.type === 'remote-inbound-rtp' &&
      (stat.kind === 'video' || stat.mediaType === 'video') &&
      typeof stat.roundTripTime === 'number' &&
      stat.roundTripTime >= 0
    ) {
      rttMs = Math.round(stat.roundTripTime * 1000);
    }
  });

  if (resolution === 'N/A' && typeof peerConnection.getSenders === 'function') {
    const videoSender = peerConnection
      .getSenders()
      .find((s) => s && s.track && s.track.kind === 'video');
    if (videoSender && videoSender.track && typeof videoSender.track.getSettings === 'function') {
      const trackSettings = videoSender.track.getSettings();
      if (
        trackSettings &&
        typeof trackSettings.width === 'number' &&
        typeof trackSettings.height === 'number' &&
        trackSettings.width > 0 &&
        trackSettings.height > 0
      ) {
        resolution = `${trackSettings.width}x${trackSettings.height}`;
      }
    }
  }

  const preferredPair =
    candidatePairs.find(
      (p) => (p.nominated || p.selected) && typeof p.currentRoundTripTime === 'number' && p.currentRoundTripTime >= 0
    ) ||
    candidatePairs.find(
      (p) =>
        (p.state === 'succeeded' || p.nominated || p.selected) &&
        typeof p.currentRoundTripTime === 'number' &&
        p.currentRoundTripTime >= 0
    ) ||
    candidatePairs.find(
      (p) => typeof p.currentRoundTripTime === 'number' && p.currentRoundTripTime >= 0
    );

  if (preferredPair) {
    rttMs = Math.round(preferredPair.currentRoundTripTime * 1000);
  }

  if (sampleTimestamp === null) {
    sampleTimestamp = performance.now();
  }

  let bitrateKbps = 0;
  if (
    prevSample &&
    typeof prevSample.timestamp === 'number' &&
    typeof prevSample.bytesSent === 'number' &&
    sampleTimestamp > prevSample.timestamp &&
    totalBytesSent >= prevSample.bytesSent
  ) {
    const deltaSeconds = (sampleTimestamp - prevSample.timestamp) / 1000;
    const deltaBytes = totalBytesSent - prevSample.bytesSent;
    if (deltaSeconds > 0) {
      bitrateKbps = Math.round((deltaBytes * 8) / deltaSeconds / 1000);
    }
  }

  if (
    fps === 0 &&
    prevSample &&
    typeof prevSample.timestamp === 'number' &&
    typeof prevSample.framesEncoded === 'number' &&
    sampleTimestamp > prevSample.timestamp &&
    totalFramesEncoded >= prevSample.framesEncoded
  ) {
    const deltaSeconds = (sampleTimestamp - prevSample.timestamp) / 1000;
    const deltaFrames = totalFramesEncoded - prevSample.framesEncoded;
    if (deltaSeconds > 0) {
      fps = Math.max(0, Math.round(deltaFrames / deltaSeconds));
    }
  }

  return {
    resolution,
    fps,
    bitrateKbps,
    rttMs,
    sample: {
      timestamp: sampleTimestamp,
      bytesSent: totalBytesSent,
      framesEncoded: totalFramesEncoded,
    },
  };
}