// Signed-in user + level progress: in-memory state, a localStorage cache, and background sync with the database.
// Saves are local-first; the network copy is merged (never overwritten) so two devices cannot lose each other's wins.

import { LEVEL_COUNT } from './config.js';
import { dbGet, dbPatch, NetworkError } from './firebase.js';

const LEVELS = Array.from({ length: LEVEL_COUNT }, (_, i) => i + 1);
const bestKey = (level) => `l${level}`; // numeric keys would be turned into arrays by Firebase
const BEST_KEYS = LEVELS.map(bestKey);
const cacheKey = (userKey) => `nix.progress.${userKey}`;
// The save lives under the account's secret (auth.js), which only the password leads to.
const savePath = (secret) => `saves/${secret}`;
const roundTime = (seconds) => Math.max(0.1, Math.round(seconds * 10) / 10);

/** localStorage that never throws (private mode, blocked storage, quota, corrupt JSON). */
export const storage = {
  read(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // The value then simply lives in memory (and in the database) for this visit.
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to clean up when storage is unavailable.
    }
  },
};

/**
 * Coerces anything (the database cannot be trusted, the cache is user-editable) into a valid, frozen progress object:
 * `{ unlocked: 1..LEVEL_COUNT+1, last: level|null, best: { lN: seconds } }`, best times only for cleared levels.
 */
export function normaliseProgress(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const unlocked = Number.isFinite(source.unlocked)
    ? Math.min(LEVEL_COUNT + 1, Math.max(1, Math.floor(source.unlocked)))
    : 1;
  const last = LEVELS.includes(source.last) && source.last <= unlocked ? source.last : null;
  const times = source.best !== null && typeof source.best === 'object' ? source.best : {};
  const best = {};
  for (const level of LEVELS) {
    const time = times[bestKey(level)];
    if (level < unlocked && Number.isFinite(time) && time > 0) best[bestKey(level)] = roundTime(time);
  }
  return Object.freeze({ unlocked, last, best: Object.freeze(best) });
}

/** Furthest unlock wins, fastest time wins, `last` follows this device. Both inputs must be normalised. */
export function mergeProgress(local, remote) {
  const best = {};
  for (const key of BEST_KEYS) {
    const time = Math.min(local.best[key] ?? Infinity, remote.best[key] ?? Infinity);
    if (time !== Infinity) best[key] = time;
  }
  return Object.freeze({
    unlocked: Math.max(local.unlocked, remote.unlocked),
    last: local.last ?? remote.last,
    best: Object.freeze(best),
  });
}

/** The progress saved under an account's secret, normalised (a save never written is fresh progress). */
export async function loadProgress(secret) {
  return normaliseProgress((await dbGet(savePath(secret))).value);
}

const sameBest = (a, b) => BEST_KEYS.every((key) => a.best[key] === b.best[key]);
const sameProgress = (a, b) => a.unlocked === b.unlocked && a.last === b.last && sameBest(a, b);

/**
 * The PATCH body that lifts the saved `remote` up to `merged`, or null when the database is already current.
 * Only changed keys are sent, so a value that merely normalised oddly is never written back over the original; a save
 * that does not exist yet also gets `unlocked`, which the database rules require of every save.
 */
function progressPatch(merged, remote, exists) {
  if (sameProgress(merged, remote)) return null;
  const patch = {};
  if (!exists || merged.unlocked !== remote.unlocked) patch.unlocked = merged.unlocked;
  if (merged.last !== remote.last) patch.last = merged.last;
  if (!sameBest(merged, remote)) patch.best = merged.best;
  return patch;
}

class Store {
  #user = null;
  #secret = null;
  #progress = normaliseProgress(null);
  #listeners = new Set();
  #dirty = false;
  #syncing = null;

  constructor() {
    globalThis.addEventListener?.('online', () => {
      if (this.#dirty) this.#sync();
    });
  }

  /** `{ key, name }` of the signed-in user, or null. */
  get user() {
    return this.#user;
  }

  /** Frozen `{ unlocked, last, best }`; replaced (never mutated) on change. */
  get progress() {
    return this.#progress;
  }

  isUnlocked(level) {
    return LEVELS.includes(level) && level <= this.#progress.unlocked;
  }

  continueLevel() {
    return Math.min(this.#progress.unlocked, LEVEL_COUNT);
  }

  hasProgress() {
    return this.#progress.unlocked > 1 || this.#progress.last !== null;
  }

  markStarted(level) {
    if (!this.#user || !this.isUnlocked(level)) return;
    if (this.#commit({ ...this.#progress, last: level })) this.#sync();
  }

  recordWin(level, seconds) {
    if (!this.#user || !this.isUnlocked(level)) return;
    const { unlocked, best } = this.#progress;
    const next = { ...this.#progress, unlocked: Math.max(unlocked, level + 1) };
    if (Number.isFinite(seconds) && seconds > 0) {
      const key = bestKey(level);
      next.best = { ...best, [key]: Math.min(best[key] ?? Infinity, roundTime(seconds)) };
    }
    if (this.#commit(next)) this.#sync();
  }

  /** `fn(store)` runs after every user or progress change. Returns the unsubscribe function. */
  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Starts a session (auth.js only). `secret` names the account's save; `remote` is the normalised progress from the
   * database, or null when the database could not be reached and the visit continues on the cached copy.
   */
  open(user, secret, remote) {
    this.#user = Object.freeze({ key: user.key, name: user.name });
    this.#secret = secret;
    const cached = normaliseProgress(storage.read(cacheKey(user.key)));
    this.#progress = remote ? mergeProgress(cached, remote) : cached;
    storage.write(cacheKey(user.key), this.#progress);
    // Offline boot: whether the cache holds unsaved wins is unknown until the next successful sync.
    this.#dirty = !remote;
    this.#notify();
    if (remote && !sameProgress(this.#progress, remote)) this.#sync();
  }

  /** Ends the session (auth.js only). The cache stays so wins that never reached the database survive a sign-out. */
  close() {
    this.#user = null;
    this.#secret = null;
    this.#progress = normaliseProgress(null);
    this.#dirty = false;
    this.#notify();
  }

  /** Drops the cached progress of an account that no longer exists (auth.js only). */
  forget(userKey) {
    storage.remove(cacheKey(userKey));
  }

  #commit(next) {
    // Another tab on this account may have cached a win this one never saw (its sync can still be pending):
    // never write the cache backwards.
    const stored = normaliseProgress(storage.read(cacheKey(this.#user.key)));
    const progress = mergeProgress(normaliseProgress(next), stored);
    if (sameProgress(progress, this.#progress)) return false;
    this.#progress = progress;
    storage.write(cacheKey(this.#user.key), progress);
    this.#notify();
    return true;
  }

  #notify() {
    for (const fn of [...this.#listeners]) {
      try {
        fn(this);
      } catch (error) {
        // A broken listener must not block saving or the other listeners; still surface it.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  /** Fire-and-forget push; at most one runs at a time and changes made meanwhile trigger another pass. */
  #sync() {
    this.#dirty = true;
    this.#syncing ??= this.#drain().finally(() => {
      this.#syncing = null;
    });
  }

  async #drain() {
    while (this.#dirty && this.#user) {
      this.#dirty = false;
      const secret = this.#secret;
      try {
        const { value } = await dbGet(savePath(secret));
        // Signed out or into another account meanwhile: this save and that account's progress must not mix.
        if (this.#secret !== secret) continue;
        const remote = normaliseProgress(value);
        this.#commit(mergeProgress(this.#progress, remote));
        const patch = progressPatch(this.#progress, remote, value !== null);
        if (patch) await dbPatch(savePath(secret), patch);
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
        if (this.#secret !== secret) continue;
        // Offline or refused: the cache keeps the change; the next save, `online` event or boot retries.
        this.#dirty = true;
        return;
      }
    }
  }
}

export const store = new Store();
