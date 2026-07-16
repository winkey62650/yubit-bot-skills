import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = 1;

export function parseEncryptionKey(value) {
  const input = String(value || "").trim();
  if (/^[a-fA-F0-9]{64}$/.test(input)) return Buffer.from(input, "hex");

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    const decoded = Buffer.from(input, "base64");
    const normalizedInput = input.replace(/=+$/, "");
    const normalizedDecoded = decoded.toString("base64").replace(/=+$/, "");
    if (decoded.length === 32 && normalizedInput === normalizedDecoded) return decoded;
  }
  throw new Error("INVALID_ENCRYPTION_KEY");
}

function associatedData(payload) {
  return Buffer.from(
    JSON.stringify({
      version: payload.version,
      keyVersion: payload.keyVersion,
      algorithm: payload.algorithm,
    }),
    "utf8",
  );
}

export function encryptCredential(value, encryptionKey, options = {}) {
  if (typeof value !== "string" || value.length === 0) throw new Error("INVALID_CREDENTIAL_VALUE");
  const key = parseEncryptionKey(encryptionKey);
  const iv = options.iv ? Buffer.from(options.iv) : randomBytes(12);
  if (iv.length !== 12) throw new Error("INVALID_CREDENTIAL_IV");

  const payload = {
    version: FORMAT_VERSION,
    keyVersion: String(options.keyVersion || "v1"),
    algorithm: ALGORITHM,
  };
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  cipher.setAAD(associatedData(payload));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

  return {
    ...payload,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptCredential(payload, encryptionKey) {
  try {
    if (
      !payload ||
      Number(payload.version) !== FORMAT_VERSION ||
      payload.algorithm !== ALGORITHM ||
      typeof payload.keyVersion !== "string"
    ) {
      throw new Error("invalid payload");
    }
    const key = parseEncryptionKey(encryptionKey);
    const iv = Buffer.from(String(payload.iv || ""), "base64");
    const ciphertext = Buffer.from(String(payload.ciphertext || ""), "base64");
    const authTag = Buffer.from(String(payload.authTag || ""), "base64");
    if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
      throw new Error("invalid payload");
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
    decipher.setAAD(associatedData(payload));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("CREDENTIAL_DECRYPTION_FAILED");
  }
}

export function maskApiKey(apiKey) {
  const value = String(apiKey || "");
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 1)}***${value.slice(-1)}`;
  return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}
