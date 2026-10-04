// Username + password accounts on top of a plain key-value database. The password never leaves this module. One
// salted PBKDF2 run gives a derived key, and two labelled hashes of it give:
//   verifier: stored in the public user record, it proves the password;
//   secret:   never stored remotely, it is the database path of the player's progress.
// Reading a record therefore reveals neither the password nor the way to the save. The session keeps the derived key.

import { dbGet, dbPut, NetworkError } from './firebase.js';
import { loadProgress, normaliseProgress, storage, store } from './store.js';

const SESSION_KEY = 'nix.session';
const SESSION_VERSION = 2;
const USERNAME = /^[A-Za-z0-9_-]{3,16}$/; // Firebase keys cannot contain . $ # [ ] /
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 64;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const ITERATIONS = 150000;
const MAX_ITERATIONS = 1000000; // a tampered record must not be able to freeze the client
const SLICE = 4096; // pure-JS iterations between yields to the event loop
const VERIFY_LABEL = 'nix:verify';
const SAVE_LABEL = 'nix:save';

const userPath = (key) => `users/${key}`;

// ---------------------------------------------------------------------------------------------------------------
// SHA-256 and PBKDF2-HMAC-SHA256 (32-byte output). WebCrypto needs a secure context, so plain-http LAN testing on a
// phone takes the portable path; both produce identical results.

const SHA256_IV = Int32Array.of(
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
);
const SHA256_K = Int32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

/** One SHA-256 block: `w[0..15]` holds the block (left intact), `w[16..63]` is scratch, `state` is updated. */
function compress(state, w) {
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15];
    const y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

/** Runs whole 64-byte blocks through a copy of `init` and returns the new state. */
function absorb(init, blocks) {
  const state = Int32Array.from(init);
  const view = new DataView(blocks.buffer, blocks.byteOffset, blocks.byteLength);
  const w = new Int32Array(64);
  for (let offset = 0; offset < blocks.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    compress(state, w);
  }
  return state;
}

/** SHA-256 of `message` as 8 words, optionally continuing from `init` after `absorbed` bytes (HMAC key pads). */
function sha256(message, init = SHA256_IV, absorbed = 0) {
  const padded = new Uint8Array(((message.length + 72) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, (absorbed + message.length) * 8);
  return absorb(init, padded);
}

function wordsToBytes(words) {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setInt32(i * 4, word));
  return bytes;
}

async function pbkdf2Portable(password, salt, iterations) {
  const keyBlock = new Uint8Array(64);
  keyBlock.set(password.length > 64 ? wordsToBytes(sha256(password)) : password);
  // Absorbing the two HMAC key pads once up front halves the work of every iteration.
  const inner = absorb(SHA256_IV, keyBlock.map((byte) => byte ^ 0x36));
  const outer = absorb(SHA256_IV, keyBlock.map((byte) => byte ^ 0x5c));

  const message = new Uint8Array(salt.length + 4);
  message.set(salt);
  message[salt.length + 3] = 1; // block index 1: a 32-byte key is exactly one PBKDF2 block
  const state = sha256(wordsToBytes(sha256(message, inner, 64)), outer, 64);
  const result = Int32Array.from(state);

  // Every later HMAC input is a 32-byte digest following a 64-byte pad block, so its padding never changes.
  const w = new Int32Array(64);
  w[8] = 0x80000000;
  w[15] = (64 + 32) * 8;
  for (let i = 1; i < iterations; i++) {
    w.set(state);
    state.set(inner);
    compress(state, w);
    w.set(state);
    state.set(outer);
    compress(state, w);
    for (let j = 0; j < 8; j++) result[j] ^= state[j];
    // Keep the sign-in spinner animating: never hold the main thread for the whole derivation.
    if (i % SLICE === 0) await new Promise((resolve) => setTimeout(resolve));
  }
  return wordsToBytes(result);
}

async function pbkdf2WebCrypto(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

const sha256Portable = async (bytes) => wordsToBytes(sha256(bytes));
const sha256WebCrypto = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

const useWebCrypto = (pureJs) => !pureJs && globalThis.crypto?.subtle !== undefined;
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));

/**
 * The derived key: hex PBKDF2-HMAC-SHA256 (32 bytes) of `password` for a hex-encoded salt.
 * `pureJs` forces the portable implementation; it exists so tests can prove both paths agree.
 */
export async function hashPassword(password, saltHex, iterations, { pureJs = false } = {}) {
  // NFKC so the same password typed on different keyboards / IMEs yields the same bytes.
  const passwordBytes = new TextEncoder().encode(password.normalize('NFKC'));
  const derive = useWebCrypto(pureJs) ? pbkdf2WebCrypto : pbkdf2Portable;
  return toHex(await derive(passwordBytes, fromHex(saltHex), iterations));
}

/**
 * `{ verifier, secret }` for a hex derived key: each is SHA-256 of the key followed by its own label, so neither can be
 * computed from the other. `pureJs` as for `hashPassword`.
 */
export async function deriveKeys(derivedHex, { pureJs = false } = {}) {
  const digest = useWebCrypto(pureJs) ? sha256WebCrypto : sha256Portable;
  const key = fromHex(derivedHex);
  const labelled = async (label) => toHex(await digest(new Uint8Array([...key, ...new TextEncoder().encode(label)])));
  const [verifier, secret] = await Promise.all([labelled(VERIFY_LABEL), labelled(SAVE_LABEL)]);
  return { verifier, secret };
}

/** Compares without an early exit so timing does not reveal how many leading characters matched. */
function constantTimeEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Accounts. Nothing read from the database is trusted: every record is validated before use.

const isHex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);

const isCredentialRecord = (record) =>
  isHex(record?.salt, SALT_BYTES * 2) &&
  isHex(record.verifier, KEY_BYTES * 2) &&
  Number.isInteger(record.iter) &&
  record.iter >= 1 &&
  record.iter <= MAX_ITERATIONS;

/** The stored session, or null. Anything else in its place, such as a v1 session, is discarded. */
function readSession() {
  const session = storage.read(SESSION_KEY);
  const valid =
    session?.v === SESSION_VERSION &&
    typeof session.name === 'string' &&
    USERNAME.test(session.name) &&
    session.key === session.name.toLowerCase() &&
    isHex(session.derived, KEY_BYTES * 2);
  if (!valid) storage.remove(SESSION_KEY);
  return valid ? session : null;
}

function startSession(user, derived, secret, remote) {
  storage.write(SESSION_KEY, { v: SESSION_VERSION, key: user.key, name: user.name, derived });
  store.open(user, secret, remote);
  return { ...user, progress: store.progress };
}

async function authenticate(name, password, mayCreate) {
  const key = name.toLowerCase();
  const { value: record, etag } = await dbGet(userPath(key), { etag: true });

  if (record === null) {
    // Without an ETag the write could not be made conditional and might clobber a concurrent sign-up.
    if (!mayCreate || !etag) throw new NetworkError('cannot create account');
    const salt = toHex(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
    const derived = await hashPassword(password, salt, ITERATIONS);
    const { verifier, secret } = await deriveKeys(derived);
    const fresh = { name, salt, iter: ITERATIONS, verifier, created: Date.now() };
    // Not written (412, the rules' 401 once the name exists, or no answer): whoever won a race for the name owns it,
    // so this attempt becomes an ordinary login, once. Its GET tells a taken name from a network failure.
    const written = await dbPut(userPath(key), fresh, { ifMatch: etag }).catch(() => false);
    if (!written) return authenticate(name, password, false);
    // A cache left behind by a deleted account of the same name must not leak into the new one.
    store.forget(key);
    // A new account's save does not exist yet: fresh progress, nothing to fetch or write.
    return { ok: true, created: true, user: startSession({ key, name }, derived, secret, normaliseProgress(null)) };
  }

  if (!isCredentialRecord(record)) return { ok: false, error: 'username' };
  const derived = await hashPassword(password, record.salt, record.iter);
  const { verifier, secret } = await deriveKeys(derived);
  if (!constantTimeEqual(verifier, record.verifier)) return { ok: false, error: 'password' };
  // The display name keeps the casing of whoever registered it.
  const stored = typeof record.name === 'string' && record.name.toLowerCase() === key ? record.name : name;
  const remote = await loadProgress(secret);
  return { ok: true, created: false, user: startSession({ key, name: stored }, derived, secret, remote) };
}

/**
 * Logs in, or creates the account when the username is free. Never rejects.
 * Resolves to `{ ok: true, created, user: { key, name, progress } }`
 * or `{ ok: false, error: 'username' | 'password-format' | 'password' | 'network' }`.
 */
export async function signIn(username, password) {
  const name = typeof username === 'string' ? username.trim() : '';
  if (!USERNAME.test(name)) return { ok: false, error: 'username' };
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return { ok: false, error: 'password-format' };
  }
  try {
    return await authenticate(name, password, true);
  } catch (error) {
    if (!(error instanceof NetworkError)) console.error(error);
    return { ok: false, error: 'network' };
  }
}

/**
 * Resumes the stored session. Resolves to whether a user is signed in; never rejects.
 * Unreachable database ⇒ carry on offline with cached progress; account gone, re-created or the session forged ⇒
 * signed out.
 */
export async function restoreSession() {
  const session = readSession();
  if (!session) return false;
  const user = { key: session.key, name: session.name };
  const { verifier, secret } = await deriveKeys(session.derived);
  let record;
  try {
    ({ value: record } = await dbGet(userPath(user.key)));
  } catch {
    store.open(user, secret, null);
    return true;
  }
  if (!isCredentialRecord(record) || !constantTimeEqual(verifier, record.verifier)) {
    signOut();
    store.forget(user.key);
    return false;
  }
  store.open(user, secret, await loadProgress(secret).catch(() => null));
  return true;
}

export function signOut() {
  storage.remove(SESSION_KEY);
  store.close();
}
