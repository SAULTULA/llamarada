// Prefijo interno: el usuario escribe "juan", en el servidor público queda "llamarada-juan".
// Así es menos probable que choque con el nombre de otra persona que use PeerJS.
const ID_PREFIX = 'llamarada-';

let localStream;
let remoteStream;
let peer;
let currentCall;
let myName = '';

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
const downloadArea = $('download-area');
const downloadLink = $('download-link');
const localVideo = $('local-video');
const remoteVideo = $('remote-video');

function setStatus(msg) {
  statusEl.textContent = msg;
}

// Deja solo letras, números, guion y guion bajo (requisito de PeerJS)
function cleanName(raw) {
  return raw
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
async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (error) {
    alert('Error al acceder a la cámara o micrófono: ' + error.message);
  }
}

// 2. Conectarse con el nombre elegido
function connectWithName() {
  const name = cleanName(myNameInput.value);
  if (!name) {
    setStatus('Escribí un nombre con letras o números.');
    return;
  }
  if (!localStream) {
    setStatus('Falta dar permiso a la cámara y el micrófono.');
    initMedia();
    return;
  }

  if (currentCall) hangUp();
  if (peer) peer.destroy();
  myName = '';
  updateUI();
  setStatus('Conectando…');

  peer = new Peer(ID_PREFIX + name);

  peer.on('open', () => {
    myName = name;
    myNameInput.value = name;
    myIdSpan.textContent = name;
    try { localStorage.setItem('llamarada-name', name); } catch (e) {}
    setStatus('Listo. Pasale tu nombre a la otra persona o escribí el suyo y tocá Llamar.');
    updateUI();
  });

  peer.on('call', (call) => {
    if (currentCall) {          // ya estamos en una llamada
      call.close();
      return;
    }
    call.answer(localStream);
    setupCall(call);
    setStatus('Llamada entrante…');
  });

  peer.on('disconnected', () => {
    if (peer && !peer.destroyed) peer.reconnect();
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      myName = '';
      myIdSpan.textContent = 'sin conectar';
      setStatus('Ese nombre ya está en uso. Probá con otro.');
    } else if (err.type === 'peer-unavailable') {
      endCall();
      setStatus('Esa persona no está conectada con ese nombre.');
    } else {
      setStatus('Error: ' + err.type);
    }
    updateUI();
  });
}

// 3. Manejo común de una llamada (entrante o saliente)
function setupCall(call) {
  currentCall = call;
  updateUI();

  call.on('stream', (stream) => {
    remoteStream = stream;
    remoteVideo.srcObject = stream;
    setStatus('En llamada.');
    updateUI();
  });
  call.on('close', endCall);
  call.on('error', endCall);
}

function startCall() {
  const remoteName = cleanName(peerIdInput.value);
  if (!remoteName) {
    setStatus('Escribí el nombre de la otra persona.');
    return;
  }
  if (remoteName === myName) {
    setStatus('Ese es tu propio nombre.');
    return;
  }
  const call = peer.call(ID_PREFIX + remoteName, localStream);
  if (!call) {
    setStatus('No se pudo iniciar la llamada.');
    return;
  }
  setupCall(call);
  setStatus('Llamando a ' + remoteName + '…');
}

function hangUp() {
  if (currentCall) currentCall.close();
  endCall();
}

// Limpia todo al terminar la llamada (la corte uno u otro)
function endCall() {
  if (recorder && recorder.state !== 'inactive') stopRecording();
  currentCall = null;
  remoteStream = null;
  remoteVideo.srcObject = null;
  if (peer && myName) setStatus('Llamada terminada.');
  updateUI();
}

// 4. Grabación: mezcla video remoto + mi cámara (en un rincón) y el audio de los dos
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

// Arrancar
try { myNameInput.value = localStorage.getItem('llamarada-name') || ''; } catch (e) {}
initMedia();
updateUI();
