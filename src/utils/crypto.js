'use strict';

const crypto = require('crypto');

/**
 * Symmetric encryption helpers used to keep session ids and proxy credentials
 * encrypted at rest. Uses AES-256-GCM (authenticated encryption).
 *
 * The 32-byte key is derived (SHA-256) from the ENCRYPTION_KEY env var so any
 * passphrase length works. In production ENCRYPTION_KEY MUST be set; in
 * development we fall back to a fixed dev key and warn once.
 */

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1'; // format tag: v1:<ivHex>:<tagHex>:<cipherHex>

let warned = false;

/** Derive a stable 32-byte key from the configured secret. */
function getKey() {
  let secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    if (!warned) {
      // eslint-disable-next-line no-console
      console.warn(
        '[crypto] ENCRYPTION_KEY is not set — using an insecure dev key. ' +
          'Set ENCRYPTION_KEY in your environment before storing real secrets.'
      );
      warned = true;
    }
    secret = 'getuserfeed-insecure-dev-key';
  }
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest();
}

/**
 * Encrypt a UTF-8 string.
 * @param {string} plaintext
 * @returns {string} "v1:<ivHex>:<tagHex>:<cipherHex>"
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString(
    'hex'
  )}`;
}

/**
 * Decrypt a payload produced by {@link encrypt}.
 * @param {string} payload
 * @returns {string} the original plaintext
 */
function decrypt(payload) {
  if (typeof payload !== 'string') {
    throw new Error('decrypt: payload must be a string');
  }
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('decrypt: unrecognized payload format');
  }
  const [, ivHex, tagHex, cipherHex] = parts;
  const decipher = crypto.createDecipheriv(
    ALGO,
    getKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, 'hex')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

/** Encrypt a JSON-serializable value. */
const encryptJson = (value) => encrypt(JSON.stringify(value));

/** Decrypt back to the original JSON value. */
const decryptJson = (payload) => JSON.parse(decrypt(payload));

module.exports = { encrypt, decrypt, encryptJson, decryptJson };
