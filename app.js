// Prefijo interno: el usuario escribe "juan", en el servidor público queda "llamarada-juan".
// Así es menos probable que choque con el nombre de otra persona que use PeerJS.
const ID_PREFIX = 'llamarada-';

const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
];

// Esperas entre reintentos cuando el servidor dice que el nombre está ocupado.
const NAME_RETRY_DELAYS = [1000, 2000, 3000, 5000, 8000, 10000];
const CALL_TIMEOUT_MS = 30000;
const TURN_PROBE_TIMEOUT_MS = 10000;

let localStream;
let remoteStream;
let peer;
let currentCall;
let myName = '';

let iceServers = [{ urls: STUN_SERVERS }];
let turnConfigured = false;
let connectingName = '';
let peerRetryAttempt = 0;
let peerRetryTimer = null;
let reconnectTimer = null;
let callTimeoutTimer = null;
let intentionalDestroy = false;

// Estado de grabación
let recorder;
let recordedChunks = [];
let drawTimer;
let recTimer;
let recStartedAt;
let audioCtx;
let lastDownloadUrl;

const $ = (id) => document.getElementById(id);
const myNameInput = $('my-name-input');
const connectBtn = $('connect-btn');
const myIdSpan = $('my-id');
const peerIdInput = $('peer-id-input');
const callBtn = $('call-btn');
const hangupBtn = $('hangup-btn');
const recBtn = $('rec-btn');
const statusEl = $('status');
const connInfoEl = $('conn-info');
const downloadArea = $('download-area');
const downloadLink = $('download-link');
const localVideo = $('local-video');
const remoteVideo = $('remote-video');
const turnStateEl = $('turn-state');
const probeBtn = $('probe-btn');
const customTurnUrl = $('custom-turn-url');
const customTurnUser = $('custom-turn-user');
const customTurnCred = $('custom-turn-cred');
const saveTurnBtn = $('save-turn-btn');
const clearTurnBtn = $('clear-turn-btn');

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.classList.remove('error', 'ok');
  if (kind) statusEl.classList.add(kind);
}

function setTurnState(msg, kind) {
  if (!turnStateEl) return;
  turnStateEl.textContent = msg;
  turnStateEl.classList.remove('error', 'ok');
  if (kind) turnStateEl.classList.add(kind);
}

// Deja solo letras, números, guion y guion bajo (requisito de PeerJS)
function cleanName(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 20)
    .replace(/^[-_]+|[-_]+$/g, '');
}

function updateUI() {
  const inCall = !!currentCall;
  const connected = !!peer && !peer.destroyed && !!myName;
  callBtn.disabled = !connected || inCall;
  hangupBtn.disabled = !inCall;
  recBtn.disabled = !remoteStream;
}

// 1. Cámara y micrófono
let mediaPromise = null;

function initMedia() {
  if (localStream) return Promise.resolve(true);
  if (mediaPromise) return mediaPromise;

  mediaPromise = navigator.mediaDevices
    .getUserMedia({ video: true, audio: true })
    .then((stream) => {
      localStream = stream;
      localVideo.srcObject = stream;
      return true;
    })
    .catch((error) => {
      setStatus('Error al acceder a la cámara o micrófono: ' + error.message, 'error');
      return false;
    })
    .finally(() => {
      mediaPromise = null;
    });

  return mediaPromise;
}

// 2. Configuración ICE: STUN siempre, TURN si está disponible
function normalizeTurnUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(/^turns?:\/\//i, '')
    .replace(/^turns?:/i, '')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '');
}

function buildIceServers(turn) {
  const servers = [{ urls: STUN_SERVERS }];
  const url = normalizeTurnUrl(turn && turn.url);
  if (url && turn.username && turn.credential) {
    servers.push({
      urls: [
        'turn:' + url + '?transport=udp',
        'turn:' + url + '?transport=tcp'
      ],
      username: turn.username,
      credential: turn.credential
    });
  }
  return servers;
}

function readCustomTurn() {
  try {
    const raw = localStorage.getItem('llamarada-turn');
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (value && value.url && value.username && value.credential) return value;
  } catch (e) {}
  return null;
}

async function loadIceServers() {
  // Un TURN propio guardado en este navegador tiene prioridad.
  const custom = readCustomTurn();
  if (custom) {
    iceServers = buildIceServers(custom);
    turnConfigured = true;
    setTurnState('Usando TURN manual configurado en este navegador.', 'ok');
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('/api/turn', { cache: 'no-store', signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length) {
      iceServers = data.iceServers;
    }
    turnConfigured = !!data.configured;
    setTurnState(
      turnConfigured
        ? 'TURN activo (ExpressTURN).'
        : 'Sin TURN: solo funciona en la misma red o con NAT simple.',
      turnConfigured ? 'ok' : 'error'
    );
  } catch (e) {
    iceServers = [{ urls: STUN_SERVERS }];
    turnConfigured = false;
    setTurnState('No se pudo leer la configuración de TURN. Solo STUN.', 'error');
  }
}

function peerOptions() {
  return {
    config: {
      iceServers,
      iceCandidatePoolSize: 10,
      sdpSemantics: 'unified-plan'
    }
  };
}

// 3. Conectarse con el nombre elegido (con reintentos si el ID quedó ocupado)
async function connectWithName() {
  const name = cleanName(myNameInput.value);
  if (!name) {
    setStatus('Escribí un nombre con letras o números.', 'error');
    return;
  }

  if (!localStream) {
    const ok = await initMedia();
    if (!ok) return;
  }

  if (currentCall) hangUp();

  if (peer && !peer.destroyed && myName === name) {
    setStatus('Ya estás conectado como «' + name + '».');
    updateUI();
    return;
  }
  if (peer && !peer.destroyed && connectingName === name) {
    setStatus('Conectando con «' + name + '»…');
    return;
  }

  destroyPeer();
  myNameInput.value = name;
  peerRetryAttempt = 0;
  createPeer(name);
}

function createPeer(name) {
  clearTimeout(peerRetryTimer);
  clearTimeout(reconnectTimer);

  intentionalDestroy = false;
  connectingName = name;
  setStatus('Conectando…');
  updateUI();

  const current = new Peer(ID_PREFIX + name, peerOptions());
  peer = current;

  current.on('open', () => {
    if (peer !== current) return;
    myName = name;
    connectingName = '';
    peerRetryAttempt = 0;
    myIdSpan.textContent = name;
    try { localStorage.setItem('llamarada-name', name); } catch (e) {}
    setStatus('Listo. Pasale tu nombre a la otra persona o escribí el suyo y tocá Llamar.', 'ok');
    updateUI();
  });

  current.on('call', (call) => {
    if (currentCall) {
      call.close();
      return;
    }
    if (!localStream) {
      call.close();
      setStatus('Llamada entrante rechazada: falta permiso de cámara.', 'error');
      return;
    }
    call.answer(localStream);
    setupCall(call);
    setStatus('Llamada entrante…');
  });

  current.on('disconnected', () => {
    if (peer !== current || intentionalDestroy) return;
    setStatus('Se cortó la conexión con el servidor. Reconectando…', 'error');
    updateUI();

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (peer !== current || current.destroyed) return;
      try { current.reconnect(); } catch (e) {}

      reconnectTimer = setTimeout(() => {
        if (peer !== current || current.destroyed || !current.disconnected) return;
        const retryName = myName || connectingName || name;
        destroyPeer();
        if (retryName) createPeer(retryName);
      }, 5000);
    }, 1000);
  });

  current.on('close', () => {
    if (peer !== current || intentionalDestroy) return;
    myName = '';
    connectingName = '';
    myIdSpan.textContent = 'sin conectar';
    updateUI();
    setStatus('Desconectado del servidor.', 'error');
  });

  current.on('error', (err) => handlePeerError(err, name, current));
}

function handlePeerError(err, name, source) {
  if (peer !== source) return;

  if (err.type === 'unavailable-id') {
    if (peerRetryAttempt < NAME_RETRY_DELAYS.length) {
      const delay = NAME_RETRY_DELAYS[peerRetryAttempt];
      peerRetryAttempt += 1;
      setStatus('Reconectando con «' + name + '»… (intento ' + peerRetryAttempt + ')');
      destroyPeer();
      peerRetryTimer = setTimeout(() => createPeer(name), delay);
    } else {
      myName = '';
      connectingName = '';
      myIdSpan.textContent = 'sin conectar';
      updateUI();
      setStatus(
        'Ese nombre sigue en uso. Cerrá otras pestañas o dispositivos con la app abierta y tocá Conectar de nuevo.',
        'error'
      );
    }
    return;
  }

  if (err.type === 'peer-unavailable') {
    endCall();
    setStatus('Esa persona no está conectada con ese nombre.', 'error');
    return;
  }

  if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
    setStatus('Problema de red con el servidor. Reintentando…', 'error');
    clearTimeout(peerRetryTimer);
    peerRetryTimer = setTimeout(() => {
      const retryName = myName || name;
      destroyPeer();
      if (retryName) createPeer(retryName);
    }, 3000);
    return;
  }

  if (err.type === 'browser-incompatible') {
    setStatus('Este navegador no soporta las llamadas.', 'error');
    return;
  }

  setStatus('Error: ' + (err.type || err.message || 'desconocido'), 'error');
  updateUI();
}

function destroyPeer() {
  clearTimeout(peerRetryTimer);
  clearTimeout(reconnectTimer);
  peerRetryTimer = null;
  reconnectTimer = null;

  const old = peer;
  peer = null;

  if (old && !old.destroyed) {
    intentionalDestroy = true;
    try { old.destroy(); } catch (e) {}
  }

  myName = '';
  connectingName = '';
  myIdSpan.textContent = 'sin conectar';
  updateUI();
}

// 4. Manejo común de una llamada (entrante o saliente)
function setupCall(call) {
  currentCall = call;
  updateUI();
  clearTimeout(callTimeoutTimer);

  call.on('stream', (stream) => {
    remoteStream = stream;
    remoteVideo.srcObject = stream;
    clearTimeout(callTimeoutTimer);
    setStatus('En llamada.', 'ok');
    updateUI();
    watchConnection(call);
  });

  call.on('close', endCall);
  call.on('error', () => {
    endCall();
    setStatus('La llamada falló.', 'error');
  });

  callTimeoutTimer = setTimeout(() => {
    if (remoteStream) return;
    const pc = call.peerConnection;
    const state = pc ? pc.iceConnectionState : 'desconocido';
    endCall();
    setStatus(
      'No se pudo establecer la conexión (ICE: ' + state + '). ' +
        (turnConfigured
          ? 'Probá desde otra red o tocá "Probar TURN" en Avanzado.'
          : 'No hay TURN configurado, así que solo funciona en la misma red.'),
      'error'
    );
  }, CALL_TIMEOUT_MS);
}

function watchConnection(call) {
  const pc = call.peerConnection;
  if (!pc) return;

  const onChange = () => {
    const state = pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      showConnectionType(pc);
    } else if (state === 'disconnected') {
      setStatus('Conexión inestable, reintentando…', 'error');
      if (typeof pc.restartIce === 'function') {
        try { pc.restartIce(); } catch (e) {}
      }
    } else if (state === 'failed') {
      setStatus('La conexión se cortó.', 'error');
      endCall();
    }
  };

  pc.addEventListener('iceconnectionstatechange', onChange);
  call.on('close', () => pc.removeEventListener('iceconnectionstatechange', onChange));
  onChange();
}

async function showConnectionType(pc) {
  if (!connInfoEl) return;
  try {
    const stats = await pc.getStats();
    const candidates = {};
    let pair = null;

    stats.forEach((report) => {
      if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
        candidates[report.id] = report;
      }
    });

    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        const selected = stats.get(report.selectedCandidatePairId);
        if (selected) pair = selected;
      }
    });

    if (!pair) {
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.selected || report.nominated)) {
          pair = report;
        }
      });
    }

    if (!pair) return;

    const local = candidates[pair.localCandidateId];
    const remote = candidates[pair.remoteCandidateId];
    const types = [local && local.candidateType, remote && remote.candidateType].filter(Boolean);
    const relayed = types.indexOf('relay') !== -1;

    connInfoEl.textContent = relayed ? 'Conexión por relay (TURN).' : 'Conexión directa P2P.';
    connInfoEl.className = 'status small ' + (relayed ? 'conn-relay' : 'conn-direct');
  } catch (e) {}
}

function startCall() {
  if (!peer || peer.destroyed || !myName) {
    setStatus('Primero tocá Conectar con tu nombre.', 'error');
    return;
  }

  const remoteName = cleanName(peerIdInput.value);
  if (!remoteName) {
    setStatus('Escribí el nombre de la otra persona.', 'error');
    return;
  }
  if (remoteName === myName) {
    setStatus('Ese es tu propio nombre.', 'error');
    return;
  }

  const call = peer.call(ID_PREFIX + remoteName, localStream);
  if (!call) {
    setStatus('No se pudo iniciar la llamada.', 'error');
    return;
  }
  setupCall(call);
  setStatus('Llamando a ' + remoteName + '…');
}

function hangUp() {
  if (currentCall) {
    try { currentCall.close(); } catch (e) {}
  }
  endCall();
}

// Limpia todo al terminar la llamada (la corte uno u otro)
function endCall() {
  clearTimeout(callTimeoutTimer);
  if (recorder && recorder.state !== 'inactive') stopRecording();
  currentCall = null;
  remoteStream = null;
  remoteVideo.srcObject = null;
  if (connInfoEl) {
    connInfoEl.textContent = '';
    connInfoEl.className = 'status small';
  }
  if (peer && myName) setStatus('Llamada terminada.');
  updateUI();
}

// 5. Probar el TURN sin hacer una llamada
async function probeTurn() {
  if (!turnConfigured) {
    setTurnState('No hay TURN configurado para probar.', 'error');
    return;
  }

  setTurnState('Probando TURN…');
  if (probeBtn) probeBtn.disabled = true;

  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
  pc.createDataChannel('probe');

  const result = new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), TURN_PROBE_TIMEOUT_MS);

    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate) return;
      const isRelay =
        candidate.type === 'relay' ||
        (candidate.candidate && candidate.candidate.indexOf(' typ relay') !== -1);
      if (isRelay) {
        clearTimeout(timer);
        finish(true);
      }
    };

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        finish(false);
      }
    };
  });

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
  } catch (error) {
    pc.close();
    if (probeBtn) probeBtn.disabled = false;
    setTurnState('Error al probar TURN: ' + error.message, 'error');
    return;
  }

  const ok = await result;
  pc.close();
  if (probeBtn) probeBtn.disabled = false;

  setTurnState(
    ok
      ? '✅ TURN funciona: el relay respondió.'
      : '❌ TURN no respondió. Revisá usuario/contraseña o probá desde otra red.',
    ok ? 'ok' : 'error'
  );
}

function reconnectIfNeeded() {
  if (peer && !peer.destroyed && peer.disconnected) {
    setStatus('Reconectando…');
    try { peer.reconnect(); } catch (e) {}
    return;
  }
  if ((!peer || peer.destroyed) && cleanName(myNameInput.value)) {
    connectWithName();
  }
}

function saveCustomTurn() {
  const url = customTurnUrl.value.trim();
  const username = customTurnUser.value.trim();
  const credential = customTurnCred.value.trim();

  if (!url || !username || !credential) {
    setTurnState('Completá URL, usuario y contraseña.', 'error');
    return;
  }

  try {
    localStorage.setItem('llamarada-turn', JSON.stringify({ url, username, credential }));
  } catch (e) {}

  iceServers = buildIceServers({ url, username, credential });
  turnConfigured = true;
  setTurnState('TURN manual guardado.', 'ok');

  if (peer && !peer.destroyed) {
    const name = myName;
    if (currentCall) hangUp();
    destroyPeer();
    if (name) createPeer(name);
  }
}

async function clearCustomTurn() {
  try { localStorage.removeItem('llamarada-turn'); } catch (e) {}
  customTurnUrl.value = '';
  customTurnUser.value = '';
  customTurnCred.value = '';

  await loadIceServers();

  if (peer && !peer.destroyed) {
    const name = myName;
    if (currentCall) hangUp();
    destroyPeer();
    if (name) createPeer(name);
  }
}

// 6. Grabación: mezcla video remoto + mi cámara (en un rincón) y el audio de los dos
function pickMimeType() {
  const options = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  return options.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function drawCover(ctx, video, x, y, w, h) {
  if (!video.videoWidth) return;
  const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (video.videoWidth - sw) / 2;
  const sy = (video.videoHeight - sh) / 2;
  ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
}

function startRecording() {
  if (!remoteStream || !window.MediaRecorder) {
    setStatus('Este navegador no permite grabar.');
    return;
  }

  const W = 960;
  const H = 540;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const pipW = 240;
  const pipH = 135;
  const draw = () => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawCover(ctx, remoteVideo, 0, 0, W, H);
    drawCover(ctx, localVideo, W - pipW - 16, H - pipH - 16, pipW, pipH);
  };
  draw();
  drawTimer = setInterval(draw, 1000 / 30);

  // Audio de ambos mezclado en una sola pista
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();
  const dest = audioCtx.createMediaStreamDestination();
  [localStream, remoteStream].forEach((s) => {
    if (s.getAudioTracks().length) audioCtx.createMediaStreamSource(s).connect(dest);
  });

  const mixed = new MediaStream([
    ...canvas.captureStream(30).getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  const mimeType = pickMimeType();
  recordedChunks = [];
  recorder = new MediaRecorder(mixed, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recordedChunks.push(e.data);
  };
  recorder.onstop = () => saveRecording(recorder.mimeType || mimeType);
  recorder.start(1000);

  recStartedAt = Date.now();
  recTimer = setInterval(updateRecLabel, 500);
  updateRecLabel();
  recBtn.classList.add('recording');
  downloadArea.classList.add('hidden');
}

function updateRecLabel() {
  const s = Math.floor((Date.now() - recStartedAt) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  recBtn.textContent = 'Detener ' + mm + ':' + ss;
}

function stopRecording() {
  clearInterval(drawTimer);
  clearInterval(recTimer);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  recBtn.classList.remove('recording');
  recBtn.textContent = 'Grabar';
}

function saveRecording(mimeType) {
  if (!recordedChunks.length) return;
  const blob = new Blob(recordedChunks, { type: mimeType || 'video/webm' });
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  lastDownloadUrl = URL.createObjectURL(blob);

  const ext = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const filename = 'llamada-' + stamp + '.' + ext;

  downloadLink.href = lastDownloadUrl;
  downloadLink.download = filename;
  downloadArea.classList.remove('hidden');
  downloadLink.click(); // descarga automática; el enlace queda por si el navegador la bloquea
  recordedChunks = [];
}

// Eventos
connectBtn.addEventListener('click', connectWithName);
myNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectWithName(); });
callBtn.addEventListener('click', startCall);
peerIdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !callBtn.disabled) startCall(); });
hangupBtn.addEventListener('click', hangUp);
recBtn.addEventListener('click', () => {
  if (recorder && recorder.state === 'recording') stopRecording();
  else startRecording();
});
probeBtn.addEventListener('click', probeTurn);
saveTurnBtn.addEventListener('click', saveCustomTurn);
clearTurnBtn.addEventListener('click', clearCustomTurn);

window.addEventListener('online', reconnectIfNeeded);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) reconnectIfNeeded();
});

// Libera el nombre en el servidor al recargar o cerrar la pestaña.
window.addEventListener('pagehide', () => {
  clearTimeout(peerRetryTimer);
  clearTimeout(reconnectTimer);
  clearTimeout(callTimeoutTimer);
  if (currentCall) {
    try { currentCall.close(); } catch (e) {}
  }
  if (peer && !peer.destroyed) {
    try { peer.destroy(); } catch (e) {}
  }
});

// Arrancar
async function boot() {
  try { myNameInput.value = localStorage.getItem('llamarada-name') || ''; } catch (e) {}

  const custom = readCustomTurn();
  if (custom) {
    customTurnUrl.value = custom.url;
    customTurnUser.value = custom.username;
    customTurnCred.value = custom.credential;
  }

  await loadIceServers();
  updateUI();

  const mediaOk = await initMedia();
  updateUI();

  // Reconecta solo con el nombre guardado, sin que haya que tocar "Conectar".
  const saved = cleanName(myNameInput.value);
  if (saved && mediaOk) connectWithName();
}

boot();
