let localStream;
let peer;

const myIdSpan = document.getElementById('my-id');
const peerIdInput = document.getElementById('peer-id-input');
const callBtn = document.getElementById('call-btn');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');

// 1. Inicializar la cámara y micrófono del celular
async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    localVideo.srcObject = localStream;
    initPeer();
  } catch (error) {
    alert('Error al acceder a la cámara o micrófono: ' + error.message);
  }
}

// 2. Conectar al servidor de IDs de PeerJS
function initPeer() {
  peer = new Peer();

  peer.on('open', (id) => {
    myIdSpan.innerText = id;
  });

  // Escuchar cuando entra una llamada
  peer.on('call', (call) => {
    call.answer(localStream); // Responder enviando nuestro audio/video
    call.on('stream', (remoteStream) => {
      remoteVideo.srcObject = remoteStream;
    });
  });
}

// 3. Realizar una llamada manual al presionar el botón
callBtn.addEventListener('click', () => {
  const remotePeerId = peerIdInput.value.trim();
  if (!remotePeerId) {
    alert('Por favor ingresá un ID de destino');
    return;
  }

  const call = peer.call(remotePeerId, localStream);
  call.on('stream', (remoteStream) => {
    remoteVideo.srcObject = remoteStream;
  });
});

// Arrancar el proceso al cargar
initMedia();