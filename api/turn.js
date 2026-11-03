// Función serverless de Vercel: entrega la configuración ICE (STUN + TURN)
// sin exponer las credenciales en el código del frontend.
//
// Variables de entorno necesarias en Vercel:
//   TURN_URL        -> free.expressturn.com:3478
//   TURN_USERNAME   -> usuario del dashboard de ExpressTURN
//   TURN_CREDENTIAL -> contraseña del dashboard de ExpressTURN

const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
];

function normalizeTurnUrl(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .replace(/^turns?:\/\//i, '')
    .replace(/^turns?:/i, '')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '');
}

module.exports = (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  // Frena el uso desde otros dominios (no protege contra curl, pero evita
  // que otra web use tus credenciales desde el navegador).
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin) {
    try {
      if (new URL(origin).host !== host) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
    } catch (e) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
  }

  const turnUrl = normalizeTurnUrl(process.env.TURN_URL);
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;

  const iceServers = [{ urls: STUN_SERVERS }];
  let configured = false;

  if (turnUrl && username && credential) {
    configured = true;
    iceServers.push({
      urls: [
        `turn:${turnUrl}?transport=udp`,
        `turn:${turnUrl}?transport=tcp`
      ],
      username,
      credential
    });
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.status(200).json({ configured, iceServers });
};
