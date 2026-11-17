const SALT = new TextEncoder().encode("wl-position-checker");
const INFO = new TextEncoder().encode("wl-session-bootstrap");
const AAD_REQUEST = new TextEncoder().encode("session-request");
const AAD_RESPONSE = new TextEncoder().encode("session-response");

export function readSub(jwt) {
  const part = String(jwt || "").split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(new TextDecoder().decode(bytesFromBase64(padded)));
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function sealSessionRequest(publicKeyB64, jwt) {
  const server = await crypto.subtle.importKey(
    "spki",
    bytesFromBase64(publicKeyB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: server }, eph.privateKey, 256);
  const aes = await handshakeKey(shared);
  const ephPublic = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("spki", eph.publicKey)));
  const sealed = await encryptJson(aes, AAD_REQUEST, { jwt });
  return { ephPublic, n: sealed.n, c: sealed.c, aes };
}

export async function openSessionResponse(aes, envelope) {
  return decryptJson(aes, AAD_RESPONSE, envelope);
}

export async function sealChannel(keyB64, sessionId, payload) {
  const aes = await importSessionKey(keyB64);
  return encryptJson(aes, new TextEncoder().encode(sessionId), payload);
}

export async function openChannel(keyB64, sessionId, envelope) {
  const aes = await importSessionKey(keyB64);
  return decryptJson(aes, new TextEncoder().encode(sessionId), envelope);
}

async function handshakeKey(shared) {
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: INFO },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function importSessionKey(keyB64) {
  return crypto.subtle.importKey("raw", bytesFromBase64(keyB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptJson(key, aad, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      new TextEncoder().encode(JSON.stringify(payload))
    )
  );
  return { n: bytesToBase64(iv), c: bytesToBase64(cipher) };
}

async function decryptJson(key, aad, envelope) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesFromBase64(envelope.n), additionalData: aad },
    key,
    bytesFromBase64(envelope.c)
  );
  const payload = JSON.parse(new TextDecoder().decode(plain));
  if (!payload || typeof payload !== "object") {
    throw new Error("Стенд вернул пустой ответ");
  }
  return payload;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesFromBase64(value) {
  const mod = value.length % 4;
  const padded = mod === 0 ? value : value + "=".repeat(4 - mod);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
