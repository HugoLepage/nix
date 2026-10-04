// Tiny REST client for the Firebase Realtime Database (no SDK: the site is static and must stay dependency-free).

import { FIREBASE_URL } from './config.js';

const TIMEOUT_MS = 8000;

/** The only error this module throws: offline, timeout, unexpected HTTP status or an unreadable body. */
export class NetworkError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

const urlFor = (path) => `${FIREBASE_URL}/${path.split('/').map(encodeURIComponent).join('/')}.json`;

async function request(method, path, { body, etag = false, ifMatch } = {}) {
  const headers = {};
  if (etag) headers['X-Firebase-ETag'] = 'true';
  if (ifMatch) headers['if-match'] = ifMatch;
  const controller = new AbortController();
  // The timer also covers reading the body, so a stalled response cannot hang the caller.
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(urlFor(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (ifMatch && response.status === 412) return { conflict: true };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { conflict: false, value: await response.json(), etag: response.headers.get('ETag') };
  } catch (cause) {
    throw new NetworkError(`${method} ${path} failed`, { cause });
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a path. With `etag: true` the result carries the ETag needed for a conditional `dbPut`. */
export async function dbGet(path, { etag = false } = {}) {
  const { value, etag: tag } = await request('GET', path, { etag });
  return { value, etag: etag ? tag : null };
}

/** Writes a path. With `ifMatch` the write is conditional and resolves to false if the data changed meanwhile. */
export async function dbPut(path, value, { ifMatch } = {}) {
  const { conflict } = await request('PUT', path, { body: value, ifMatch });
  return !conflict;
}

/** Shallow-merges `value` into the object at `path`. */
export async function dbPatch(path, value) {
  await request('PATCH', path, { body: value });
}
