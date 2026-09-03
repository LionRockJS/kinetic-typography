// The local media cache: how a saved project finds its files again.
//
// A .ktc.json holds references — a name, a size, a duration — never the bytes,
// so opening a project would otherwise leave every audio and video clip waiting
// for a manual re-import. Two independent recovery paths live here:
//
//   1. the imported file's bytes, kept in IndexedDB. Works in any browser that
//      can run the app, needs no permission, and is bounded by a byte budget;
//   2. a File System Access handle pointing at the file where it actually
//      lives. It outlives a cleared cache and picks up later edits to the file,
//      but needs the user's permission and exists only in Chromium browsers.
//
// Everything here degrades quietly. With no usable IndexedDB — a private
// window, blocked storage, a page opened over file:// — the app behaves exactly
// as it did before: the clip stays pending until the user re-imports it.

import { round } from '../util.js';

const DB_NAME = 'ktc-media';
const DB_VERSION = 1;
const BLOBS = 'blobs';
const HANDLES = 'handles';
const MAX_CACHED_BYTES = 1_200_000_000;   // whole cache; the oldest go first
const MAX_CACHED_FILE = 300_000_000;      // above this only the handle is kept

let dbPromise = null;
let unavailable = false;

const asPromise = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function openDb() {
  if (unavailable || !globalThis.indexedDB) return Promise.resolve(null);
  dbPromise ??= new Promise(resolve => {
    let req;
    // An opaque origin (file://) throws here rather than failing the request.
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch { unavailable = true; resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [BLOBS, HANDLES]) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: 'key' });
        store.createIndex('name', 'name');
        store.createIndex('savedAt', 'savedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { unavailable = true; resolve(null); };
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

export const mediaCacheAvailable = () => !!globalThis.indexedDB && !unavailable;

/** The part of a clip that identifies its source file across sessions. */
export const mediaRef = clip => ({
  name: typeof clip?.name === 'string' ? clip.name : '',
  size: Math.max(0, Number(clip?.size) || 0),
  duration: Math.max(0, Number(clip?.duration) || 0)
});

const keyOf = ref => `${ref.name}::${ref.size || '?'}`;

/** Ask the browser to keep this origin's storage out of the eviction pool. */
let persistenceAsked = false;
function requestPersistence() {
  if (persistenceAsked || !navigator.storage?.persist) return;
  persistenceAsked = true;
  Promise.resolve(navigator.storage.persisted?.())
    .then(already => (already ? null : navigator.storage.persist()))
    .catch(() => {});
}

async function findEntry(storeName, ref) {
  const db = await openDb();
  if (!db || !ref.name) return null;
  try {
    const store = db.transaction(storeName, 'readonly').objectStore(storeName);
    if (ref.size) {
      const exact = await asPromise(store.get(keyOf(ref)));
      if (exact) return exact;
    }
    // Projects saved before the cache existed carry no byte size. Match on the
    // name and prefer whichever entry has the duration the project recorded.
    const byName = await asPromise(store.index('name').getAll(ref.name));
    if (!byName.length) return null;
    return byName.sort((a, b) =>
      (ref.duration
        ? Math.abs(a.duration - ref.duration) - Math.abs(b.duration - ref.duration)
        : 0) || b.savedAt - a.savedAt)[0];
  } catch (err) {
    console.warn('Media cache read failed', err);
    return null;
  }
}

/** Drop the least recently saved bytes until `headroom` more would still fit. */
async function prune(db, headroom = 0) {
  try {
    const store = db.transaction(BLOBS, 'readwrite').objectStore(BLOBS);
    const entries = await asPromise(store.getAll());
    entries.sort((a, b) => a.savedAt - b.savedAt);
    let total = entries.reduce((sum, entry) => sum + (entry.size || 0), 0) + headroom;
    for (const entry of entries) {
      if (total <= MAX_CACHED_BYTES) break;
      store.delete(entry.key);
      total -= entry.size || 0;
    }
  } catch (err) {
    console.warn('Media cache prune failed', err);
  }
}

async function put(db, storeName, record) {
  try {
    const store = db.transaction(storeName, 'readwrite').objectStore(storeName);
    await asPromise(store.put(record));
    return true;
  } catch (err) {
    return err;
  }
}

/** Remember an imported file so the next Open can attach it without a click. */
export async function rememberMedia(file, { duration = 0, handle = null } = {}) {
  const db = await openDb();
  if (!db || !file?.name) return false;
  const meta = {
    key: keyOf({ name: file.name, size: file.size }),
    name: file.name, size: file.size, type: file.type || '',
    duration: round(Math.max(0, Number(duration) || 0), 3),
    savedAt: Date.now()
  };

  // The handle is the cheaper and longer-lived of the two records; keep it even
  // when the bytes are too big to cache.
  if (handle) await put(db, HANDLES, { ...meta, handle });

  if (file.size <= MAX_CACHED_FILE) {
    let stored = await put(db, BLOBS, { ...meta, blob: file });
    if (stored !== true) {
      // Out of quota, most likely. Make room and give it one more go.
      await prune(db, file.size);
      stored = await put(db, BLOBS, { ...meta, blob: file });
    }
    if (stored === true) await prune(db);
    else console.warn('Media cache write failed', stored);
  }
  requestPersistence();
  return true;
}

/**
 * Find the file behind a saved clip. Returns the file when it can be read
 * without asking, `{ file: null, needsPermission: true }` when only a handle
 * survives and the user has to allow it, or null when nothing is known.
 */
export async function recallMedia(clip) {
  const ref = mediaRef(clip);
  if (!ref.name) return null;

  const handleEntry = await findEntry(HANDLES, ref);
  if (handleEntry?.handle) {
    const granted = await handleEntry.handle.queryPermission?.({ mode: 'read' })
      .catch(() => 'denied');
    if (granted === 'granted') {
      const file = await handleEntry.handle.getFile().catch(() => null);
      if (file) return { file, source: 'handle', needsPermission: false };
    }
  }

  const cached = await findEntry(BLOBS, ref);
  if (cached?.blob) {
    return {
      file: new File([cached.blob], cached.name || ref.name, { type: cached.type || cached.blob.type }),
      source: 'cache',
      needsPermission: false
    };
  }

  // A handle we may not read yet is still a recovery path — one click away.
  return handleEntry?.handle ? { file: null, source: 'handle', needsPermission: true } : null;
}

/**
 * Ask for permission on a clip's remembered handle and read the file. Must be
 * called from a click: the permission prompt needs the user's gesture.
 */
export async function requestMedia(clip) {
  const ref = mediaRef(clip);
  const entry = await findEntry(HANDLES, ref);
  if (!entry?.handle?.requestPermission) return null;
  let granted;
  try { granted = await entry.handle.requestPermission({ mode: 'read' }); }
  catch { return null; }
  if (granted !== 'granted') return null;
  const file = await entry.handle.getFile().catch(() => null);
  if (file) await rememberMedia(file, { duration: entry.duration, handle: entry.handle });
  return file;
}

/** Everything the cache holds, for the storage read-out in the media panels. */
export async function mediaCacheSize() {
  const db = await openDb();
  if (!db) return { count: 0, bytes: 0, handles: 0 };
  try {
    const blobs = await asPromise(db.transaction(BLOBS, 'readonly').objectStore(BLOBS).getAll());
    const handles = await asPromise(db.transaction(HANDLES, 'readonly').objectStore(HANDLES).count());
    return {
      count: blobs.length,
      bytes: blobs.reduce((sum, entry) => sum + (entry.size || 0), 0),
      handles
    };
  } catch {
    return { count: 0, bytes: 0, handles: 0 };
  }
}

/** Forget every cached file and handle — the panel's "clear media cache". */
export async function clearMediaCache() {
  const db = await openDb();
  if (!db) return false;
  try {
    for (const name of [BLOBS, HANDLES]) {
      await asPromise(db.transaction(name, 'readwrite').objectStore(name).clear());
    }
    return true;
  } catch (err) {
    console.warn('Media cache clear failed', err);
    return false;
  }
}
