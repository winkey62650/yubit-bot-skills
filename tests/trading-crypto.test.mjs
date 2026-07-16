import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  decryptCredential,
  encryptCredential,
  maskApiKey,
  parseEncryptionKey,
} from "../lib/trading-crypto.mjs";

test("AES-256-GCM credentials round trip and preserve key version", () => {
  const key = randomBytes(32).toString("base64");
  const encrypted = encryptCredential("super-secret-value", key, { keyVersion: "2026-07" });

  assert.equal(encrypted.algorithm, "aes-256-gcm");
  assert.equal(encrypted.keyVersion, "2026-07");
  assert.notEqual(encrypted.ciphertext, "super-secret-value");
  assert.equal(decryptCredential(encrypted, key), "super-secret-value");
});

test("credential decryption rejects a wrong key without exposing plaintext", () => {
  const encrypted = encryptCredential("never-log-me", randomBytes(32).toString("hex"));
  assert.throws(
    () => decryptCredential(encrypted, randomBytes(32).toString("hex")),
    (error) => error.message === "CREDENTIAL_DECRYPTION_FAILED" && !error.message.includes("never-log-me"),
  );
});

test("encryption keys must be exactly 32 bytes as base64 or 64 hex characters", () => {
  assert.equal(parseEncryptionKey("ab".repeat(32)).length, 32);
  assert.equal(parseEncryptionKey(Buffer.alloc(32, 7).toString("base64")).length, 32);
  assert.throws(() => parseEncryptionKey("too-short"), /INVALID_ENCRYPTION_KEY/);
  assert.throws(() => parseEncryptionKey("z".repeat(64)), /INVALID_ENCRYPTION_KEY/);
});

test("API key masks are recognizable but never reveal the complete key", () => {
  assert.equal(maskApiKey("abcd1234wxyz5678"), "abcd********5678");
  assert.equal(maskApiKey("short"), "s***t");
  assert.equal(maskApiKey(""), "");
});
