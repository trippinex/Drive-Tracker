/**
 * DriveTracker – app.js
 *
 * Sections:
 *   1. IndexedDB wrapper  (drives + vehicles stores)
 *   2. Haversine & geo utilities
 *   3. Map engine  (Leaflet)
 *   4. Screen Wake Lock
 *   5. Telemetry display
 *   6. Drive session controller
 *   7. History & GPX/KML export
 *   8. Vehicle management  (Settings panel)
 *   9. PWA update handler & bootstrap
 */

'use strict';

// Current app version — update this with every release.
const APP_VERSION = '1.7.3';
const APP_IS_BETA = false;

// ═══════════════════════════════════════════════════════════════
// 1. IndexedDB wrapper
// ═══════════════════════════════════════════════════════════════

const DB_NAME        = 'drivelog';
const DB_VERSION     = 6;           // v6: adds drive_draft store for crash recovery
const DRIVES_STORE   = 'drives';
const VEHICLES_STORE = 'vehicles';
const DRAFT_STORE    = 'drive_draft';

// Authenticated user's Firebase UID — set in initApp() after sign-in.
// All DB reads/writes are scoped to this value.
let currentUserId = null;

// No default vehicles — users add their own via Settings.

/** Open (or upgrade) the IndexedDB database. Returns a Promise<IDBDatabase>. */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db      = e.target.result;
      const oldVer  = e.oldVersion;

      // ── v1: drives store (original) ──────────────────────────────────────
      if (oldVer < 1) {
        const drivesStore = db.createObjectStore(DRIVES_STORE, { keyPath: 'id', autoIncrement: true });
        drivesStore.createIndex('startedAt', 'startedAt', { unique: false });
      }

      // ── v2: vehicles store ────────────────────────────────────────────────
      if (oldVer < 2) {
        const vs = db.createObjectStore(VEHICLES_STORE, { keyPath: 'id', autoIncrement: true });
        vs.createIndex('name', 'name', { unique: false });
      }

      // ── v3: one-time removal of auto-seeded placeholder vehicles.
      //    These were machine-generated defaults, not user data.
      //    ─────────────────────────────────────────────────────────────────────
      // DATA PRESERVATION POLICY (v3 onward):
      //   Future version bumps must NEVER clear, delete, or overwrite existing
      //   user data (drives, vehicles, settings). Migrations may only:
      //     • create new object stores
      //     • add new indexes to existing stores
      //     • add new fields with safe default values
      //   Never call .clear(), .delete(), or .put() on existing records.
      // ─────────────────────────────────────────────────────────────────────
      if (oldVer >= 2 && oldVer < 3) {
        e.target.transaction.objectStore(VEHICLES_STORE).clear();
      }

      // ── v4: add userId indexes so all data is user-scoped.
      //    Existing records without userId are migrated in initApp() after auth.
      if (oldVer < 4) {
        const tx = e.target.transaction;
        tx.objectStore(DRIVES_STORE).createIndex('userId', 'userId', { unique: false });
        tx.objectStore(VEHICLES_STORE).createIndex('userId', 'userId', { unique: false });
      }

      // ── v5: add firestoreId index for bidirectional cloud sync.
      if (oldVer < 5) {
        const tx = e.target.transaction;
        tx.objectStore(DRIVES_STORE).createIndex('firestoreId', 'firestoreId', { unique: false });
        tx.objectStore(VEHICLES_STORE).createIndex('firestoreId', 'firestoreId', { unique: false });
      }

      // ── v6: add drive_draft store for crash/kill recovery.
      if (oldVer < 6) {
        db.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
      }
    };

    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Drives ────────────────────────────────────────────────────────────────────

// ── Drives ────────────────────────────────────────────────────────────────────

async function saveDrive(record) {
  const db      = await openDB();
  const payload = { ...record, userId: currentUserId };
  const localId = await new Promise((resolve, reject) => {
    const tx  = db.transaction(DRIVES_STORE, 'readwrite');
    const req = tx.objectStore(DRIVES_STORE).add(payload);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  // Sync to Firestore asynchronously — don't block the UI.
  window.syncDriveAdd?.({ ...payload, id: localId }).then(fsId => {
    if (fsId) setDriveFirestoreId(localId, fsId);
  });
  return localId;
}

async function getAllDrives() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(DRIVES_STORE, 'readonly');
    const req = tx.objectStore(DRIVES_STORE).index('startedAt').getAll();
    req.onsuccess = () => {
      const all  = req.result || [];
      const mine = all.filter(d => !d.userId || d.userId === currentUserId);
      resolve(mine.reverse());
    };
    req.onerror = () => reject(req.error);
  });
}

async function deleteDrive(id) {
  const db    = await openDB();
  const drive = await new Promise((resolve, reject) => {
    const tx  = db.transaction(DRIVES_STORE, 'readonly');
    const req = tx.objectStore(DRIVES_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DRIVES_STORE, 'readwrite');
    tx.objectStore(DRIVES_STORE).delete(id).onsuccess = () => {
      window.syncDriveDelete?.(drive?.firestoreId);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ── Vehicles ──────────────────────────────────────────────────────────────────

async function getAllVehicles() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(VEHICLES_STORE, 'readonly');
    const req = tx.objectStore(VEHICLES_STORE).getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      resolve(all.filter(v => !v.userId || v.userId === currentUserId));
    };
    req.onerror = () => reject(req.error);
  });
}

async function addVehicle(data) {
  const db      = await openDB();
  const payload = { ...data, userId: currentUserId };
  const localId = await new Promise((resolve, reject) => {
    const tx  = db.transaction(VEHICLES_STORE, 'readwrite');
    const req = tx.objectStore(VEHICLES_STORE).add(payload);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  window.syncVehicleAdd?.({ ...payload, id: localId }).then(fsId => {
    if (fsId) setVehicleFirestoreId(localId, fsId);
  });
  return localId;
}

async function updateVehicle(id, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(VEHICLES_STORE, 'readwrite');
    const store = tx.objectStore(VEHICLES_STORE);
    const get   = store.get(id);
    get.onsuccess = () => {
      const existing = get.result;
      const updated  = { ...existing, ...data, id, userId: currentUserId };
      const put      = store.put(updated);
      put.onsuccess  = () => {
        window.syncVehicleUpdate?.(existing?.firestoreId, updated);
        resolve();
      };
      put.onerror = () => reject(put.error);
    };
    get.onerror = () => reject(get.error);
  });
}

async function deleteVehicle(id) {
  const db      = await openDB();
  const vehicle = await new Promise((resolve, reject) => {
    const tx  = db.transaction(VEHICLES_STORE, 'readonly');
    const req = tx.objectStore(VEHICLES_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VEHICLES_STORE, 'readwrite');
    tx.objectStore(VEHICLES_STORE).delete(id).onsuccess = () => {
      window.syncVehicleDelete?.(vehicle?.firestoreId);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ── Raw DB helpers (no userId filter — used by sync.js) ──────────────────────

async function getAllVehiclesRaw() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(VEHICLES_STORE, 'readonly');
    const req = tx.objectStore(VEHICLES_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

// Exposed on window so sync.js can call them across script boundaries.
window.getAllDrivesRaw = async function getAllDrivesRaw() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(DRIVES_STORE, 'readonly');
    const req = tx.objectStore(DRIVES_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
};

window.getAllVehiclesRaw = async function getAllVehiclesRaw() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(VEHICLES_STORE, 'readonly');
    const req = tx.objectStore(VEHICLES_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
};

window.addVehicleRaw = async function addVehicleRaw(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(VEHICLES_STORE, 'readwrite');
    const req = tx.objectStore(VEHICLES_STORE).add(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
};

window.addDriveRaw = async function addDriveRaw(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(DRIVES_STORE, 'readwrite');
    const req = tx.objectStore(DRIVES_STORE).add(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
};

/** Update a vehicle record in-place by its local IndexedDB id (used by real-time listener). */
window.updateVehicleByLocalId = async function updateVehicleByLocalId(localId, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(VEHICLES_STORE, 'readwrite');
    const store = tx.objectStore(VEHICLES_STORE);
    const get   = store.get(localId);
    get.onsuccess = () => {
      if (!get.result) return resolve();
      store.put({ ...get.result, ...data, id: localId }).onsuccess = resolve;
    };
    get.onerror = () => reject(get.error);
  });
};

/** Delete a vehicle by local IndexedDB id (used by real-time listener). */
window.deleteVehicleByLocalId = async function deleteVehicleByLocalId(localId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VEHICLES_STORE, 'readwrite');
    tx.objectStore(VEHICLES_STORE).delete(localId).onsuccess = resolve;
    tx.onerror = () => reject(tx.error);
  });
};

/** Delete a drive by local IndexedDB id (used by real-time listener). */
window.deleteDriveByLocalId = async function deleteDriveByLocalId(localId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DRIVES_STORE, 'readwrite');
    tx.objectStore(DRIVES_STORE).delete(localId).onsuccess = resolve;
    tx.onerror = () => reject(tx.error);
  });
};

// Fix 5: Save a drive record to IndexedDB only (no Firestore sync).
// Used for rolling mid-drive chunks so partial data doesn't pollute Firestore.
// The complete, finalised records are synced to Firestore at stopDrive().
async function saveDriveLocal(record) {
  const db      = await openDB();
  const payload = { ...record, userId: currentUserId };
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(DRIVES_STORE, 'readwrite');
    const req = tx.objectStore(DRIVES_STORE).add(payload);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// Fix 5: Patch specific fields on an existing drive record (local only).
// Called at stopDrive() to finalise endedAt/distanceMiles/totalParts on rolled chunks.
async function updateDriveById(localId, fields) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(DRIVES_STORE, 'readwrite');
    const store = tx.objectStore(DRIVES_STORE);
    const get   = store.get(localId);
    get.onsuccess = () => {
      if (!get.result) return resolve();
      store.put({ ...get.result, ...fields }).onsuccess = resolve;
    };
    get.onerror = () => reject(get.error);
  });
}

// ── Drive draft (crash / OS-kill recovery) ────────────────────────────────────

async function saveDraft() {
  if (!sessionState.active) return;
  const db = await openDB();
  const record = {
    id:              1,
    userId:          currentUserId,
    startTime:       sessionState.startTime,
    pausedAt:        sessionState.pausedAt,
    totalPausedMs:   sessionState.totalPausedMs,
    vehicle:         sessionState.vehicle,
    coordinates:     [...sessionState.coordinates],
    totalDistanceMi: sessionState.totalDistanceMi,
    flushedPartIds:  [...sessionState.flushedPartIds],
    driveGroupId:    sessionState.driveGroupId,
    savedAt:         Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(DRAFT_STORE, 'readwrite');
    const req = tx.objectStore(DRAFT_STORE).put(record);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function clearDraft() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      tx.objectStore(DRAFT_STORE).clear().onsuccess = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[Draft] clearDraft failed:', e);
  }
}

async function loadDraft() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(DRAFT_STORE, 'readonly');
    const req = tx.objectStore(DRAFT_STORE).get(1);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

window.setVehicleFirestoreId = async function setVehicleFirestoreId(localId, firestoreId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(VEHICLES_STORE, 'readwrite');
    const store = tx.objectStore(VEHICLES_STORE);
    const get   = store.get(localId);
    get.onsuccess = () => {
      if (!get.result) return resolve();
      store.put({ ...get.result, firestoreId }).onsuccess = resolve;
    };
    get.onerror = () => reject(get.error);
  });
};

window.setDriveFirestoreId = async function setDriveFirestoreId(localId, firestoreId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(DRIVES_STORE, 'readwrite');
    const store = tx.objectStore(DRIVES_STORE);
    const get   = store.get(localId);
    get.onsuccess = () => {
      if (!get.result) return resolve();
      store.put({ ...get.result, firestoreId }).onsuccess = resolve;
    };
    get.onerror = () => reject(get.error);
  });
};

/**
 * One-time migration: stamp any existing records that lack a userId with the
 * current user's UID. This preserves all pre-auth data without losing anything.
 * Safe to call on every login — it skips records that already have a userId.
 */
async function migrateUnownedData(userId) {
  const db = await openDB();

  const stampStore = async (storeName) => {
    const all = await new Promise((res, rej) => {
      const tx  = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
    const unowned = all.filter(r => !r.userId);
    if (!unowned.length) return;

    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const record of unowned) {
      store.put({ ...record, userId });
    }
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
    console.log(`[DB] Migrated ${unowned.length} unowned record(s) in ${storeName} → userId ${userId}`);
  };

  await stampStore(DRIVES_STORE);
  await stampStore(VEHICLES_STORE);
}

/**
 * Compress an image File and return a base64 data URL.
 * Resizes to fit within maxW×maxH while preserving aspect ratio.
 *
 * Transparency support:
 *   PNG and WebP may have transparent pixels. Converting those to JPEG
 *   destroys the alpha channel (replaced with black or white).
 *   Fix: keep PNG/WebP as PNG so transparency is preserved.
 *   JPEG inputs are still saved as JPEG (smaller files, no alpha to lose).
 */
function compressImage(file, maxW = 480, maxH = 360, quality = 0.82) {
  const transparent = file.type === 'image/png'  ||
                      file.type === 'image/webp' ||
                      file.type === 'image/gif';

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = e => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale  = Math.min(maxW / img.width, maxH / img.height, 1);
        const canvas = document.createElement('canvas');
        canvas.width  = Math.round(img.width  * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');

        if (!transparent) {
          // Fill white behind JPEG so semi-transparent edges don't go black.
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        // For PNG/WebP, leave canvas transparent so alpha is preserved.

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        // PNG for transparent images (lossless alpha); JPEG for opaque.
        resolve(transparent
          ? canvas.toDataURL('image/png')
          : canvas.toDataURL('image/jpeg', quality)
        );
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ═══════════════════════════════════════════════════════════════
// 2. Geo utilities
// ═══════════════════════════════════════════════════════════════

const EARTH_RADIUS_MILES = 3958.8;

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(a));
}

const mpsToMph = mps => mps * 2.23694;

const EARTH_RADIUS_METERS = 6371000;
function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return EARTH_RADIUS_METERS * 2 * Math.asin(Math.sqrt(a));
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

// ═══════════════════════════════════════════════════════════════
// 3. Map engine
// ═══════════════════════════════════════════════════════════════

let map           = null;
let carMarker     = null;
let routePolyline = null;
let locationDot   = null;
let idleWatchId   = null;
let arrowMarkers  = [];     // directional chevrons placed along the route
let arrowStepCount = 0;     // counts GPS points between arrow placements
const ARROW_EVERY  = 8;     // place one arrow every N GPS points
const MAX_ARROWS   = 200;   // Fix 4: cap arrow markers to prevent DOM bloat on long drives

function initMap() {
  if (map) return;

  map = L.map('map', {
    center: [37.7749, -122.4194],
    zoom: 15,
    zoomControl: false,
    attributionControl: true,
  });

  L.control.zoom({ position: 'topleft' }).addTo(map);

  // CartoCDN Positron — clean light tiles matching the slate theme.
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);
}

function updateCarMarker(latlng) {
  if (carMarker) { carMarker.setLatLng(latlng); return; }
  const icon = L.divIcon({
    className: '',
    html: `<div class="car-marker-icon" aria-label="Current position">🚗</div>`,
    iconSize: [36, 36], iconAnchor: [18, 18],
  });
  carMarker = L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(map);
}

function appendToRoute(latlng) {
  if (!routePolyline) {
    routePolyline = L.polyline([latlng], { color: '#f97316', weight: 4, opacity: 0.9 }).addTo(map);
    arrowStepCount = 0;
    return;
  }

  const pts = routePolyline.getLatLngs();
  const prev = pts[pts.length - 1];
  routePolyline.addLatLng(latlng);

  // Place a direction arrow every ARROW_EVERY points.
  arrowStepCount++;
  if (arrowStepCount >= ARROW_EVERY && prev) {
    addDirectionArrow(prev.lat, prev.lng, latlng.lat, latlng.lng);
    arrowStepCount = 0;
  }
}

function panToPosition(latlng) {
  map.panTo(latlng, { animate: true, duration: 0.5 });
}

function clearRoute() {
  if (routePolyline) { routePolyline.remove(); routePolyline = null; }
  arrowMarkers.forEach(m => m.remove());
  arrowMarkers = [];
  arrowStepCount = 0;
}

function clearCarMarker() {
  if (carMarker) { carMarker.remove(); carMarker = null; }
}

// ── Recommendation 3: Ramer-Douglas-Peucker route simplification ─────────────
// Applied once at drive-save time. Removes intermediate GPS points that lie
// within EPSILON degrees of the straight line between their neighbours —
// i.e., collinear "noise" on straight road sections. Turns and curves are
// fully preserved because their apex deviates significantly from the straight
// line. Typical reduction: 30–60% on highway sections, ~10% on city drives.
const RDP_EPSILON = 0.00009;   // ≈ 10 metres in geographic degrees

function rdpPerpendicularDist(pt, lineStart, lineEnd) {
  const x0 = pt.lng,        y0 = pt.lat;
  const x1 = lineStart.lng, y1 = lineStart.lat;
  const x2 = lineEnd.lng,   y2 = lineEnd.lat;
  const num = Math.abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1);
  const den = Math.sqrt((y2 - y1) ** 2 + (x2 - x1) ** 2);
  return den === 0 ? 0 : num / den;
}

// Fix 1: Iterative RDP — eliminates recursion stack overflow on large arrays.
// The recursive version could throw RangeError on 8-hour drives (14,000+ points).
// This iterative version uses an explicit stack array with identical output.
function rdpSimplify(points, epsilon = RDP_EPSILON) {
  if (points.length <= 2) return points;

  const keep  = new Uint8Array(points.length);  // 1 = keep, 0 = discard
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [start, end] = stack.pop();
    if (end - start <= 1) continue;

    let maxDist = 0, maxIdx = start;
    for (let i = start + 1; i < end; i++) {
      const d = rdpPerpendicularDist(points[i], points[start], points[end]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }

    if (maxDist > epsilon) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx]);
      stack.push([maxIdx, end]);
    }
  }

  return points.filter((_, i) => keep[i] === 1);
}

/** Returns compass bearing (0–360°) from point A to point B. */
function getBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLon  = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Place a direction chevron on the map at [lat2, lon2] pointing from A→B.
 *  Fix 4: removes the oldest arrow when MAX_ARROWS is reached so the DOM
 *  doesn't accumulate thousands of markers on 8-hour drives. */
function addDirectionArrow(lat1, lon1, lat2, lon2) {
  if (arrowMarkers.length >= MAX_ARROWS) {
    arrowMarkers.shift().remove();   // evict oldest — trailing-arrows effect
  }
  const bearing = getBearing(lat1, lon1, lat2, lon2);
  const icon = L.divIcon({
    className: '',
    html: `<div class="route-arrow" style="transform:rotate(${bearing}deg)">
             <svg viewBox="0 0 10 14" width="10" height="14">
               <polygon points="5,0 10,14 5,10 0,14" fill="#f97316" opacity="0.85"/>
             </svg>
           </div>`,
    iconSize:   [10, 14],
    iconAnchor: [5, 7],
  });
  const marker = L.marker([lat2, lon2], { icon, interactive: false, zIndexOffset: -1 });
  marker.addTo(map);
  arrowMarkers.push(marker);
}

/** Show the blue pulsating "you are here" dot before a drive starts. */
function showLocationDot(latlng) {
  const icon = L.divIcon({
    className: '',
    html: `<div class="location-dot-wrapper">
             <div class="location-dot-ring"></div>
             <div class="location-dot-core"></div>
           </div>`,
    iconSize:   [40, 40],
    iconAnchor: [20, 20],
  });
  if (locationDot) {
    locationDot.setLatLng(latlng);
  } else {
    locationDot = L.marker(latlng, { icon, interactive: false }).addTo(map);
  }
}

/** Hide the blue dot when a drive begins (car marker takes over). */
function hideLocationDot() {
  if (locationDot) { locationDot.remove(); locationDot = null; }
}

// ═══════════════════════════════════════════════════════════════
// 4. Screen Wake Lock
// ═══════════════════════════════════════════════════════════════

let wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    setStatus('Screen Wake Lock not supported — screen may dim.');
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    document.getElementById('wakelock-status').classList.add('active');
    wakeLock.addEventListener('release', () => {
      document.getElementById('wakelock-status').classList.remove('active');
      wakeLock = null;
      // Fix 3: warn the driver if the lock drops mid-recording
      if (sessionState.active) {
        setStatus('⚠️ Screen lock lost — screen may dim during drive.');
      }
    });
  } catch (err) {
    console.warn('Wake Lock request failed:', err.message);
  }
}

async function releaseWakeLock() {
  if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  document.getElementById('wakelock-status').classList.remove('active');
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    if (sessionState.active) saveDraft().catch(() => {});
    return;
  }
  if (sessionState.active && !wakeLock) {
    await acquireWakeLock();
    setStatus('Screen lock re-acquired after returning to app.');
  }
});

// ═══════════════════════════════════════════════════════════════
// 5. Telemetry display
// ═══════════════════════════════════════════════════════════════

const els = {
  speed:     document.getElementById('tel-speed'),
  distance:  document.getElementById('tel-distance'),
  duration:  document.getElementById('tel-duration'),
  altitude:  document.getElementById('tel-altitude'),
  accuracy:  document.getElementById('accuracy-badge'),
  speedCard: document.getElementById('card-speed'),
};

function updateTelemetry({ speedMph, distanceMiles, elapsedSeconds, altitudeM, accuracyM }) {
  els.speed.textContent    = speedMph.toFixed(1);
  els.distance.textContent = distanceMiles.toFixed(2);
  els.duration.textContent = formatDuration(elapsedSeconds);
  els.altitude.textContent = altitudeM !== null ? Math.round(altitudeM * 3.28084) : '--';
  els.speedCard.classList.toggle('speed-active', speedMph > 2);
  if (accuracyM !== null) els.accuracy.textContent = `±${Math.round(accuracyM)}m`;
}

function resetTelemetry() {
  els.speed.textContent    = '0.0';
  els.distance.textContent = '0.00';
  els.duration.textContent = '00:00:00';
  els.altitude.textContent = '--';
  els.speedCard.classList.remove('speed-active');
}

// ═══════════════════════════════════════════════════════════════
// 6. Drive session controller
// ═══════════════════════════════════════════════════════════════

const sessionState = {
  active: false, paused: false, watchId: null,
  startTime: null, pausedAt: null, totalPausedMs: 0,
  coordinates: [], totalDistanceMi: 0,
  timerInterval: null, vehicle: '',
  // Fix 5: rolling in-drive chunk flush
  flushedPartIds:  [],   // local IndexedDB IDs of parts saved mid-drive
  driveGroupId:    null, // set on first flush; links all parts together
  isFlushing:      false, // prevents concurrent flush operations
  draftHeartbeat:  null, // periodic draft save interval
};

// Fix 2: GPS gap detection
const GPS_GAP_THRESHOLD_MS = 60_000;  // 60 seconds
let lastGPSTimestamp = 0;
let gapCount = 0;

// Fix 3: Wake lock heartbeat
let wakeLockHeartbeat = null;

// Maximum GPS coordinates per drive part stored in Firestore.
// At ~150 bytes/point, 5,000 points ≈ 750 KB — safely under the 1 MB document limit.
const MAX_COORDS_PER_PART = 5000;

// ── Recommendation 1: Speed-adaptive distance threshold ───────────────────────
// Scale the minimum recording distance with GPS-reported speed, matching the
// strategy used by Google Maps and Waze. Faster speeds = larger threshold =
// fewer points on straight highway sections.
const SPEED_THRESHOLDS = [
  { maxMph: 10,       metres: 8  },  // stopped / crawling — preserve slow detail
  { maxMph: 35,       metres: 15 },  // suburban driving
  { maxMph: 60,       metres: 25 },  // mixed / arterial roads
  { maxMph: Infinity, metres: 40 },  // highway — ~1 point per 1.5 sec at 65 mph
];

function getDistanceThresholdMiles(speedMph) {
  for (const tier of SPEED_THRESHOLDS) {
    if (speedMph <= tier.maxMph) return tier.metres / 1609.34;
  }
  return 40 / 1609.34;
}

// ── Recommendation 2: Minimum time gap between recorded points ────────────────
// Prevents burst recording caused by GPS jitter when stationary (the device
// oscillates a few metres around a fixed point, falsely triggering the distance
// threshold). Both distance AND time must be satisfied to record a point.
const MIN_RECORD_INTERVAL_MS = 2000;  // 2 seconds
let lastRecordedTs = 0;

/**
 * Fix 5: Flush the current coordinate buffer to IndexedDB as a partial part.
 * Called mid-drive when the buffer reaches MAX_COORDS_PER_PART.
 * Saves locally only (no Firestore sync) — finalised records sync at stopDrive().
 * Clears sessionState.coordinates to free memory for the next chunk.
 */
async function flushDriveChunk() {
  if (sessionState.coordinates.length < 2 || sessionState.isFlushing) return;
  sessionState.isFlushing = true;

  try {
    const coords = rdpSimplify([...sessionState.coordinates]);

    if (!sessionState.driveGroupId) {
      sessionState.driveGroupId = String(sessionState.startTime);
    }

    const partNumber = sessionState.flushedPartIds.length + 1;
    const id = await saveDriveLocal({
      vehicle:         sessionState.vehicle,
      startedAt:       sessionState.startTime,
      endedAt:         null,   // finalised at stopDrive
      durationSeconds: null,
      distanceMiles:   null,
      coordinates:     coords,
      driveGroupId:    sessionState.driveGroupId,
      partNumber,
      totalParts:      null,   // finalised at stopDrive
    });

    sessionState.flushedPartIds.push(id);
    sessionState.coordinates = [];  // free memory — this is the whole point
    console.log(`[Drive] Chunk ${partNumber} flushed (${coords.length} pts after RDP). Memory cleared.`);
    setStatus(`Tracking — chunk ${partNumber} saved, continuing…`);
  } catch (err) {
    console.error('[Drive] Chunk flush failed:', err.message);
  } finally {
    sessionState.isFlushing = false;
  }
}

function onPositionUpdate(pos) {
  if (!sessionState.active || sessionState.paused) return;
  const { latitude: lat, longitude: lng, altitude, speed, accuracy } = pos.coords;
  const latlng   = L.latLng(lat, lng);
  const now      = pos.timestamp;
  const speedMph = (speed != null && speed >= 0) ? mpsToMph(speed) : 0;

  // Always update car marker, pan, and telemetry — smooth UX on every GPS tick.
  updateCarMarker(latlng);
  panToPosition(latlng);
  updateTelemetry({
    speedMph,
    distanceMiles:  sessionState.totalDistanceMi,
    elapsedSeconds: getElapsedSeconds(),
    altitudeM:      altitude,
    accuracyM:      accuracy,
  });

  // Gate: record a point only when BOTH conditions are satisfied —
  //   1. Speed-adaptive distance threshold exceeded (Rec 1)
  //   2. At least 2 seconds since the last recorded point (Rec 2)
  const prev = sessionState.coordinates[sessionState.coordinates.length - 1];
  if (prev) {
    const distMiles = haversine(prev.lat, prev.lng, lat, lng);
    const threshold = getDistanceThresholdMiles(speedMph);
    const elapsed   = now - lastRecordedTs;

    if (distMiles < threshold || elapsed < MIN_RECORD_INTERVAL_MS) return;
    sessionState.totalDistanceMi += distMiles;
  }

  // Fix 2: GPS gap detection — warn if position updates stopped for >= 60 seconds.
  if (lastGPSTimestamp > 0) {
    const gap = now - lastGPSTimestamp;
    if (gap >= GPS_GAP_THRESHOLD_MS) {
      gapCount++;
      setStatus(`⚠️ GPS gap detected (${Math.round(gap / 1000)}s). ${gapCount} gap${gapCount > 1 ? 's' : ''} this drive.`);
    }
  }
  lastGPSTimestamp = now;

  appendToRoute(latlng);
  handlePoiProximity(lat, lng);
  sessionState.coordinates.push({ lat, lng, alt: altitude, speed, ts: now });
  lastRecordedTs = now;

  // Fix 5: Trigger rolling flush when buffer reaches the chunk size.
  if (sessionState.coordinates.length >= MAX_COORDS_PER_PART && !sessionState.isFlushing) {
    flushDriveChunk();  // async fire-and-forget; clears coordinates on completion
  } else {
    setStatus(`Tracking — ${sessionState.coordinates.length} pts (chunk ${sessionState.flushedPartIds.length + 1}).`);
  }
}

function onPositionError(err) {
  const messages = {
    1: 'Location permission denied. Please allow location access.',
    2: 'Position unavailable. Check GPS signal.',
    3: 'Location request timed out.',
  };
  setStatus(messages[err.code] || `GPS error: ${err.message}`);
}

function getElapsedSeconds() {
  if (!sessionState.startTime) return 0;
  return Math.floor((Date.now() - sessionState.startTime - sessionState.totalPausedMs) / 1000);
}

async function startDrive() {
  // Guard: require a vehicle to be selected before recording.
  const selectedVehicle = document.getElementById('vehicle-select').value;
  if (!selectedVehicle) {
    const vehicles = await getAllVehicles();
    if (!vehicles.length) {
      setStatus('No vehicles configured. Add one in Menu → Garage before starting a drive.');
    } else {
      setStatus('Please select a vehicle before starting a drive.');
    }
    return;
  }

  if (!navigator.geolocation) {
    setStatus('Geolocation is not supported by this browser.');
    return;
  }

  sessionState.active          = true;
  sessionState.paused          = false;
  sessionState.startTime       = Date.now();
  sessionState.pausedAt        = null;
  sessionState.totalPausedMs   = 0;
  sessionState.coordinates     = [];
  sessionState.totalDistanceMi = 0;
  sessionState.vehicle         = document.getElementById('vehicle-select').value;

  clearRoute();
  resetTelemetry();
  lastRecordedTs    = 0;   // reset time gate
  lastGPSTimestamp  = 0;   // Fix 2: reset gap detector
  gapCount          = 0;
  sessionState.flushedPartIds = [];  // Fix 5: reset rolling flush state
  sessionState.driveGroupId   = null;
  sessionState.isFlushing     = false;
  sessionState.draftHeartbeat = setInterval(() => {
    if (sessionState.active) saveDraft().catch(() => {});
  }, 30_000);
  stopIdleWatch();
  hideLocationDot();
  showVehiclePhoto();
  await acquireWakeLock();

  // Fix 3: Wake lock heartbeat — re-acquire every 5 min in case OS revokes it.
  wakeLockHeartbeat = setInterval(async () => {
    if (!sessionState.active) return;
    if (!wakeLock) {
      await acquireWakeLock();
      if (!wakeLock) setStatus('⚠️ Screen lock lost — screen may dim during drive.');
    }
  }, 5 * 60 * 1000);

  sessionState.watchId = navigator.geolocation.watchPosition(
    onPositionUpdate, onPositionError,
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );

  sessionState.timerInterval = setInterval(() => {
    if (sessionState.paused) return;
    els.duration.textContent = formatDuration(getElapsedSeconds());
  }, 1000);

  poiAnnounceLog.clear();
  setCTAState('recording');
  setStatus('Drive started. Acquiring GPS signal…');
  document.getElementById('vehicle-select').disabled = true;
}

async function pauseDrive() {
  if (!sessionState.active || sessionState.paused) return;
  sessionState.paused   = true;
  sessionState.pausedAt = Date.now();
  await releaseWakeLock();
  saveDraft().catch(() => {});
  setCTAState('paused');
  setStatus('Drive paused. Tap Resume to continue.');
}

async function resumeDrive() {
  if (!sessionState.active || !sessionState.paused) return;
  if (sessionState.pausedAt) {
    sessionState.totalPausedMs += Date.now() - sessionState.pausedAt;
    sessionState.pausedAt = null;
  }
  sessionState.paused = false;
  await acquireWakeLock();
  setCTAState('recording');
  setStatus('Drive resumed.');
}

async function stopDrive() {
  if (!sessionState.active) return;

  // If stopped while paused, account for the current paused segment.
  if (sessionState.paused && sessionState.pausedAt) {
    sessionState.totalPausedMs += Date.now() - sessionState.pausedAt;
    sessionState.pausedAt = null;
  }

  if (sessionState.watchId !== null) {
    navigator.geolocation.clearWatch(sessionState.watchId);
    sessionState.watchId = null;
  }

  clearInterval(sessionState.timerInterval);
  sessionState.timerInterval = null;
  clearInterval(wakeLockHeartbeat);    // Fix 3: stop heartbeat
  wakeLockHeartbeat = null;
  clearInterval(sessionState.draftHeartbeat);
  sessionState.draftHeartbeat = null;
  hideVehiclePhoto();
  await releaseWakeLock();


  sessionState.active = false;
  sessionState.paused = false;

  const hasFlushedParts = sessionState.flushedPartIds.length > 0;
  const endedAt  = Date.now();
  const duration = getElapsedSeconds();
  const distance = sessionState.totalDistanceMi;

  if (hasFlushedParts) {
    // Fix 5: Drive used rolling flush — finalise the remaining buffer and
    // patch all flushed parts with the correct final metadata.
    const raw    = sessionState.coordinates;
    const coords = raw.length > 1 ? rdpSimplify(raw) : [];
    if (coords.length > 1) console.log(`[Drive] Final chunk RDP: ${raw.length} → ${coords.length} pts`);

    const totalParts = sessionState.flushedPartIds.length + (coords.length > 1 ? 1 : 0);
    const driveGroupId = sessionState.driveGroupId;

    // Save final (remaining) chunk if it has enough points.
    let lastPartId = null;
    if (coords.length > 1) {
      lastPartId = await saveDrive({
        vehicle:         sessionState.vehicle,
        startedAt:       sessionState.startTime,
        endedAt, durationSeconds: duration, distanceMiles: distance,
        coordinates:     coords,
        driveGroupId,
        partNumber:      totalParts,
        totalParts,
      });
    }

    // Patch all previously flushed chunks with final metadata.
    for (let i = 0; i < sessionState.flushedPartIds.length; i++) {
      await updateDriveById(sessionState.flushedPartIds[i], {
        endedAt, durationSeconds: duration, distanceMiles: distance,
        totalParts,
      });
    }

    setStatus(`Drive saved (${totalParts} parts, ${distance.toFixed(2)} mi).`);

    // Compute score from all parts — need DB read since flushed coords are no longer in memory.
    const allDrives   = await getAllDrives();
    const groupCoords = allDrives
      .filter(d => d.driveGroupId === driveGroupId)
      .sort((a, b) => a.partNumber - b.partNumber)
      .flatMap(d => d.coordinates || []);
    const score = computeDriveScore(groupCoords, distance);
    const allPartIds = [...sessionState.flushedPartIds, ...(lastPartId != null ? [lastPartId] : [])];
    for (const pid of allPartIds) await updateDriveById(pid, { score });
    showDriveSummary(score);

  } else if (sessionState.coordinates.length > 1) {
    // Normal path — no rolling flush occurred.
    const raw    = sessionState.coordinates;
    const coords = rdpSimplify(raw);
    console.log(`[Drive] RDP: ${raw.length} → ${coords.length} pts (${((1 - coords.length/raw.length)*100).toFixed(0)}% reduction)`);

    // Split into parts if still over the chunk limit after RDP.
    const chunks = [];
    for (let i = 0; i < coords.length; i += MAX_COORDS_PER_PART) {
      chunks.push(coords.slice(i, i + MAX_COORDS_PER_PART));
    }

    const isMultiPart  = chunks.length > 1;
    const driveGroupId = isMultiPart ? String(sessionState.startTime) : undefined;
    const score        = computeDriveScore(coords, distance);

    for (let i = 0; i < chunks.length; i++) {
      await saveDrive({
        vehicle:         sessionState.vehicle,
        startedAt:       sessionState.startTime,
        endedAt, durationSeconds: duration, distanceMiles: distance,
        coordinates:     chunks[i],
        score,
        ...(isMultiPart && { driveGroupId, partNumber: i + 1, totalParts: chunks.length }),
      });
    }

    historyDirty = true;
    const partNote = isMultiPart ? ` (${chunks.length} parts)` : '';
    setStatus(`Drive saved (${coords.length} pts, ${distance.toFixed(2)} mi${partNote}).`);
    showDriveSummary(score);

  } else {
    setStatus('Drive cancelled — too few GPS points recorded.');
  }

  await clearDraft();
  clearCarMarker();     // remove the drive's car marker so blue dot is visible again
  setCTAState('start');
  document.getElementById('vehicle-select').disabled = false;
  startIdleWatch();     // resume blue dot — will reappear on next GPS tick
}

// ── CTA / drive controls ─────────────────────────────────────────────────────
const ctaBtn       = document.getElementById('cta-btn');
const driveControls = document.getElementById('drive-controls');
const pauseBtn     = document.getElementById('pause-btn');
const stopBtn      = document.getElementById('stop-btn');

function setCTAState(state) {
  if (state === 'start') {
    ctaBtn.textContent    = '▶  Start Drive';
    ctaBtn.className      = 'start';
    ctaBtn.style.display  = '';
    driveControls.style.display = 'none';
  } else if (state === 'recording') {
    ctaBtn.style.display  = 'none';
    driveControls.style.display = 'flex';
    pauseBtn.textContent  = '⏸  Pause';
    pauseBtn.className    = '';
  } else if (state === 'paused') {
    ctaBtn.style.display  = 'none';
    driveControls.style.display = 'flex';
    pauseBtn.textContent  = '▶  Resume';
    pauseBtn.className    = 'paused';
  }
}

ctaBtn.addEventListener('click', () => { startDrive(); });
pauseBtn.addEventListener('click', () => {
  sessionState.paused ? resumeDrive() : pauseDrive();
});
stopBtn.addEventListener('click', () => { stopDrive(); });

function setStatus(msg) {
  document.getElementById('status-bar').textContent = msg;
}

function showToast(msg, durationMs = 2500) {
  const el = document.getElementById('copy-toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('visible'), durationMs);
}

// ── Drive scoring ──────────────────────────────────────────────────────────────

const GRADE_COLORS = {
  'S':  { bg: 'rgba(245,158,11,0.15)',  border: '#f59e0b', color: '#f59e0b' },
  'A':  { bg: 'rgba(34,197,94,0.15)',   border: '#22c55e', color: '#22c55e' },
  'B':  { bg: 'rgba(59,130,246,0.15)',  border: '#3b82f6', color: '#3b82f6' },
  'C':  { bg: 'rgba(234,179,8,0.15)',   border: '#eab308', color: '#eab308' },
  'D':  { bg: 'rgba(239,68,68,0.15)',   border: '#ef4444', color: '#ef4444' },
  '--': { bg: 'rgba(100,116,139,0.15)', border: '#64748b', color: '#64748b' },
};

/**
 * Score a drive on three dimensions using fixed real-world benchmarks.
 * Returns { composite, grade, curve, elevation, speed } where each grade is
 * 'S'|'A'|'B'|'C'|'D'|'--'.  '--' signals insufficient data for that dimension.
 */
function computeDriveScore(coords, distanceMiles) {
  if (!coords || coords.length < 2 || (distanceMiles || 0) < 1) {
    return { composite: null, grade: '--',
             curve:     { raw: null, grade: '--' },
             elevation: { raw: null, grade: '--' },
             speed:     { raw: null, grade: '--' } };
  }

  // Curve density — total bearing-change degrees per mile, ignoring jitter < 5°
  let totalDeg = 0;
  for (let i = 2; i < coords.length; i++) {
    const b1 = getBearing(coords[i-2].lat, coords[i-2].lng, coords[i-1].lat, coords[i-1].lng);
    const b2 = getBearing(coords[i-1].lat, coords[i-1].lng, coords[i].lat,   coords[i].lng);
    let d = Math.abs(b2 - b1);
    if (d > 180) d = 360 - d;
    if (d >= 5) totalDeg += d;
  }
  const curveRaw = Math.min(totalDeg / distanceMiles / 3200, 1) * 100;

  // Elevation gain — cumulative positive altitude delta (m→ft) per mile
  const altPts = coords.filter(c => c.alt != null);
  let elevationRaw = null;
  if (altPts.length / coords.length >= 0.5) {
    let gainM = 0;
    for (let i = 1; i < altPts.length; i++) {
      const d = altPts[i].alt - altPts[i-1].alt;
      if (d > 0) gainM += d;
    }
    elevationRaw = Math.min((gainM * 3.28084) / distanceMiles / 400, 1) * 100;
  }

  // Speed variance — standard deviation of GPS speeds (mph)
  const spds = coords.filter(c => c.speed != null && c.speed >= 0).map(c => mpsToMph(c.speed));
  let speedRaw = null;
  if (spds.length >= 2) {
    const mean   = spds.reduce((a, b) => a + b, 0) / spds.length;
    const stdDev = Math.sqrt(spds.reduce((s, v) => s + (v - mean) ** 2, 0) / spds.length);
    speedRaw = Math.min(stdDev / 30, 1) * 100;
  }

  // Composite — weighted average, redistributing weight if a dimension is absent
  const dims = [
    { raw: curveRaw, w: 0.40 },
    ...(elevationRaw !== null ? [{ raw: elevationRaw, w: 0.35 }] : []),
    ...(speedRaw     !== null ? [{ raw: speedRaw,     w: 0.25 }] : []),
  ];
  const totalW    = dims.reduce((s, d) => s + d.w, 0);
  const composite = dims.reduce((s, d) => s + d.raw * (d.w / totalW), 0);

  const toGrade = v => {
    if (v === null) return '--';
    if (v >= 85) return 'S';
    if (v >= 70) return 'A';
    if (v >= 55) return 'B';
    if (v >= 40) return 'C';
    return 'D';
  };

  return {
    composite: Math.round(composite),
    grade:     toGrade(composite),
    curve:     { raw: Math.round(curveRaw),                                    grade: toGrade(curveRaw) },
    elevation: { raw: elevationRaw !== null ? Math.round(elevationRaw) : null, grade: toGrade(elevationRaw) },
    speed:     { raw: speedRaw     !== null ? Math.round(speedRaw)     : null, grade: toGrade(speedRaw) },
  };
}

/** Render a colored letter-grade badge as an HTML string.
 *  Pass large=true for the post-drive summary hero badge. */
function gradeBadgeHTML(grade, large = false) {
  const c   = GRADE_COLORS[grade] || GRADE_COLORS['--'];
  const fs  = large ? '32px' : '14px';
  const pad = large ? '10px 22px' : '2px 8px';
  return `<span style="display:inline-block;background:${c.bg};border:2px solid ${c.border};color:${c.color};font-size:${fs};padding:${pad};font-weight:800;border-radius:10px;line-height:1.2;letter-spacing:0.02em">${grade}</span>`;
}

/** Build the Drive DNA panel HTML for the standalone map page.
 *  Uses inline styles since the map page has no access to styles.css. */
function buildDnaHTML(score) {
  const badge = (grade) => {
    const map = {
      'S': ['rgba(245,158,11,0.2)', '#f59e0b'],
      'A': ['rgba(34,197,94,0.2)',  '#22c55e'],
      'B': ['rgba(59,130,246,0.2)', '#3b82f6'],
      'C': ['rgba(234,179,8,0.2)',  '#eab308'],
      'D': ['rgba(239,68,68,0.2)',  '#ef4444'],
    };
    const [bg, col] = map[grade] || ['rgba(100,116,139,0.2)', '#64748b'];
    return `<span style="display:inline-block;background:${bg};border:1.5px solid ${col};color:${col};font-size:13px;padding:2px 8px;font-weight:800;border-radius:7px;line-height:1.3">${grade}</span>`;
  };
  const item = (label, grade) =>
    `<div class="dna-item"><div class="dna-grade">${label}</div>${badge(grade)}</div>`;
  return `
    ${item('Curve',     score.curve.grade)}
    ${item('Elevation', score.elevation.grade)}
    ${item('Speed',     score.speed.grade)}
    ${item('Overall',   score.grade)}
  `;
}

function showDriveSummary(score) {
  const overlay = document.getElementById('drive-summary-overlay');
  if (!overlay) return;
  document.getElementById('drive-summary-badge').innerHTML = gradeBadgeHTML(score.grade, true);
  const row = (label, g) =>
    `<div class="drive-summary-row"><span class="drive-summary-sub-label">${label}</span>${gradeBadgeHTML(g)}</div>`;
  document.getElementById('drive-summary-subs').innerHTML =
    row('Curve',          score.curve.grade) +
    row('Elevation',      score.elevation.grade) +
    row('Speed Variance', score.speed.grade);
  overlay.removeAttribute('hidden');
}

document.getElementById('drive-summary-close')?.addEventListener('click', () => {
  document.getElementById('drive-summary-overlay')?.setAttribute('hidden', '');
});

// ═══════════════════════════════════════════════════════════════
// 7. History & export
// ═══════════════════════════════════════════════════════════════

const historyOverlay = document.getElementById('history-overlay');
const historyPanel   = document.getElementById('history-panel');
const historyList    = document.getElementById('history-list');

// Elements that receive `inert` while the history panel is open.
const HISTORY_INERT_TARGETS = [
  document.getElementById('app-header'),
  document.querySelector('main'),
];

function escapeHTML(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const HISTORY_PAGE_SIZE = 20;
let historyDirty    = true;
let historyObserver = null;

function buildGPX(drive) {
  const trkpts = drive.coordinates.map(c => {
    const alt  = c.alt != null ? `<ele>${c.alt.toFixed(1)}</ele>` : '';
    const time = new Date(c.ts).toISOString();
    return `    <trkpt lat="${c.lat.toFixed(6)}" lon="${c.lng.toFixed(6)}">${alt}<time>${time}</time></trkpt>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="DriveTracker" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${drive.vehicle || 'Drive'}</name>
    <time>${new Date(drive.startedAt).toISOString()}</time>
  </metadata>
  <trk>
    <name>${drive.vehicle || 'Drive'} – ${new Date(drive.startedAt).toLocaleDateString()}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

function buildKML(drive) {
  const coords = drive.coordinates
    .map(c => `${c.lng.toFixed(6)},${c.lat.toFixed(6)},${c.alt?.toFixed(1) ?? 0}`)
    .join('\n          ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${drive.vehicle || 'Drive'}</name>
    <Placemark>
      <name>${drive.vehicle || 'Drive'} – ${new Date(drive.startedAt).toLocaleDateString()}</name>
      <LineString>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>
          ${coords}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
}

function buildAIExport(drive) {
  const AI_SAMPLE_TARGET = 100;
  const allCoords = drive.coordinates || [];
  const stride = allCoords.length > AI_SAMPLE_TARGET
    ? Math.floor(allCoords.length / AI_SAMPLE_TARGET)
    : 1;

  const sampled = [];
  for (let i = 0; i < allCoords.length; i += stride) {
    const c = allCoords[i];
    sampled.push([
      parseFloat(c.lat.toFixed(5)),
      parseFloat(c.lng.toFixed(5)),
      c.alt   != null ? parseFloat(c.alt.toFixed(1))                       : null,
      c.speed != null && c.speed >= 0 ? parseFloat(mpsToMph(c.speed).toFixed(1)) : null,
    ]);
  }
  // Always include the final point if not already captured.
  if (allCoords.length > 0) {
    const last = allCoords[allCoords.length - 1];
    const lastIncludedIdx = Math.floor((allCoords.length - 1) / stride) * stride;
    if (lastIncludedIdx !== allCoords.length - 1) {
      sampled.push([
        parseFloat(last.lat.toFixed(5)),
        parseFloat(last.lng.toFixed(5)),
        last.alt   != null ? parseFloat(last.alt.toFixed(1))                       : null,
        last.speed != null && last.speed >= 0 ? parseFloat(mpsToMph(last.speed).toFixed(1)) : null,
      ]);
    }
  }

  return JSON.stringify({
    vehicle:         drive.vehicle || 'Unknown',
    date:            new Date(drive.startedAt).toISOString().slice(0, 10),
    startedAt:       new Date(drive.startedAt).toISOString(),
    durationSeconds: drive.durationSeconds,
    distanceMiles:   parseFloat((drive.distanceMiles || 0).toFixed(3)),
    totalPoints:     allCoords.length,
    coords:          sampled,
  });
}

/**
 * For a multi-part drive, returns all sibling parts sorted by partNumber.
 * For a single-part drive, returns [drive].
 */
async function getDriveGroup(drive) {
  if (!drive.driveGroupId) return [drive];
  const all = await getAllDrives();
  return all
    .filter(d => d.driveGroupId === drive.driveGroupId)
    .sort((a, b) => a.partNumber - b.partNumber);
}

/** Open the drive route in a full-screen map in a new browser tab. */
async function openDriveMap(drive) {
  const isStandalone = window.navigator.standalone === true ||
                       window.matchMedia('(display-mode: standalone)').matches;

  // Safari blocks window.open() after any await (user gesture consumed).
  // Open the blank window synchronously before any async work.
  const newWin = isStandalone ? null : window.open('', '_blank');

  // Combine all parts for multi-part drives so the full route is shown.
  const parts      = await getDriveGroup(drive);
  const allCoords  = parts.flatMap(p => p.coordinates || []);
  const score      = drive.score || computeDriveScore(allCoords, drive.distanceMiles || 0);
  const coords     = allCoords.map(c => [c.lat, c.lng]);
  const title      = `${drive.vehicle || 'Drive'} — ${new Date(drive.startedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  const stats      = `${(drive.distanceMiles || 0).toFixed(2)} mi &nbsp;·&nbsp; ${formatDuration(drive.durationSeconds || 0)}`;

  // Full coordinate data for the replay engine (speed converted to MPH).
  const replayCoords = allCoords.map(c => ({
    lat:   c.lat,
    lng:   c.lng,
    speed: (c.speed != null && c.speed >= 0) ? parseFloat(mpsToMph(c.speed).toFixed(1)) : null,
    ts:    c.ts || 0,
  }));

  // Look up the vehicle photo for the replay marker; fall back to chevron if absent.
  const vehicles     = await getAllVehicles();
  const vehicleRec   = vehicles.find(v => v.name === drive.vehicle);
  const vehiclePhoto = vehicleRec?.photo || null;
  const poiSnapshot  = [...loadedPOIs];

  // Build static direction arrows: one every 8 coords.
  const arrowData = [];
  for (let i = 8; i < coords.length; i += 8) {
    const p = coords[i - 1], c = coords[i];
    const dLon = (c[1] - p[1]) * Math.PI / 180;
    const y    = Math.sin(dLon) * Math.cos(c[0] * Math.PI / 180);
    const x    = Math.cos(p[0] * Math.PI / 180) * Math.sin(c[0] * Math.PI / 180) -
                 Math.sin(p[0] * Math.PI / 180) * Math.cos(c[0] * Math.PI / 180) * Math.cos(dLon);
    const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    arrowData.push({ lat: c[0], lng: c[1], bearing });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; background: #0f172a; font-family: system-ui, sans-serif; }
    #map { position: absolute; inset: 0; }

    /* Shared glass pill */
    .glass-pill {
      position: fixed; left: 50%; transform: translateX(-50%);
      background: rgba(15,23,42,0.92); color: #f1f5f9;
      border-radius: 12px; z-index: 1000;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      white-space: nowrap;
    }

    /* Top pill stack — mirrors #bottom-pills so gap is identical */
    #top-pills {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      z-index: 1000;
    }
    #info, #replay-hud { position: relative; left: auto; transform: none; }

    /* Drive info pill */
    #info { padding: 10px 20px; display: flex; align-items: center; gap: 16px; }
    #info strong { color: #f97316; font-size: 14px; font-weight: 700; }
    #info span   { font-size: 13px; color: #94a3b8; }

    /* Replay HUD */
    #replay-hud { padding: 8px 24px; display: flex; align-items: center; gap: 24px; }
    .hud-item  { display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .hud-label { font-size: 10px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; }
    .hud-value { font-size: 15px; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; }

    /* Bottom pill stack — controls sit directly above DNA, gap between them */
    #bottom-pills {
      position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      padding-bottom: max(16px, env(safe-area-inset-bottom));
      z-index: 1000;
    }
    /* Override glass-pill's position:fixed for the two bottom children */
    #replay-controls, #dna { position: relative; left: auto; transform: none; }

    /* Replay controls */
    #replay-controls { padding: 8px 12px; display: flex; align-items: center; gap: 6px; }
    .rp-btn {
      display: flex; align-items: center; justify-content: center; gap: 5px;
      min-width: 44px; min-height: 44px; padding: 0 12px;
      border: none; border-radius: 9px; cursor: pointer;
      font-size: 13px; font-weight: 600; font-family: system-ui, sans-serif;
      background: rgba(255,255,255,0.08); color: #f1f5f9;
      transition: background 0.15s, transform 0.1s;
      -webkit-tap-highlight-color: transparent;
    }
    .rp-btn:hover  { background: rgba(255,255,255,0.15); }
    .rp-btn:active { transform: scale(0.92); }
    .rp-btn.primary { background: #f97316; color: #fff; min-width: 52px; }
    .rp-btn.primary:hover { background: #ea580c; }
    #rp-speed.active { color: #f97316; font-weight: 800; }
    .rp-label { display: none; }
    @media (min-width: 480px) { .rp-label { display: inline; } }
    .rp-divider { width: 1px; height: 26px; background: rgba(255,255,255,0.12); margin: 0 2px; flex-shrink: 0; }
    .rp-announce { display: flex; align-items: center; gap: 5px; cursor: pointer; padding: 0 8px; min-height: 44px; font-size: 12px; font-weight: 600; color: #94a3b8; user-select: none; }
    .rp-announce input[type="checkbox"] { width: 14px; height: 14px; accent-color: #f97316; cursor: pointer; }
    .rp-announce span { display: none; }
    @media (min-width: 480px) { .rp-announce span { display: inline; } }

    /* DNA pill */
    #dna {
      padding: 10px 16px;
      display: flex; align-items: center; justify-content: center;
      flex-wrap: wrap; gap: 10px 14px; max-width: calc(100vw - 32px);
    }
    .dna-grade { font-size: 10px; color: #94a3b8; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; margin-bottom: 2px; }
    .dna-item  { display: flex; flex-direction: column; align-items: center; gap: 3px; }

    /* Route direction arrows */
    .route-arrow { display: flex; align-items: center; justify-content: center; }

    /* Replay marker */
    .rp-photo   { width: 56px; height: 56px; object-fit: contain; display: block; border-radius: 8px; }
    .rp-chevron { display: flex; align-items: center; justify-content: center; transform-origin: center center; }
  </style>
</head>
<body>
  <div id="top-pills">
    <div id="info" class="glass-pill">
      <strong>${escapeHTML(drive.vehicle || 'Drive')}</strong>
      <span>${new Date(drive.startedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
      <span>${stats}</span>
    </div>
    <div id="replay-hud" class="glass-pill">
      <div class="hud-item">
        <span class="hud-label">Time</span>
        <span class="hud-value" id="hud-time">--:-- --</span>
      </div>
      <div class="hud-item">
        <span class="hud-label">Speed</span>
        <span class="hud-value" id="hud-speed">-- MPH</span>
      </div>
    </div>
  </div>

  <div id="map"></div>

  <div id="bottom-pills">
  <div id="replay-controls" class="glass-pill">
    <button class="rp-btn" id="rp-stop" title="Stop">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><rect x="0" y="0" width="13" height="13" rx="2"/></svg>
      <span class="rp-label">Stop</span>
    </button>
    <div class="rp-divider"></div>
    <button class="rp-btn" id="rp-back" title="Back 10 minutes">
      <svg width="16" height="13" viewBox="0 0 16 13" fill="currentColor">
        <polygon points="7,0 0,6.5 7,13 7,8.5 14,13 14,0 7,4.5"/>
        <rect x="14.5" y="0" width="1.5" height="13" rx="0.75"/>
      </svg>
      <span class="rp-label">−10m</span>
    </button>
    <button class="rp-btn primary" id="rp-playpause" title="Play / Pause">
      <svg id="rp-play-icon"  width="11" height="13" viewBox="0 0 11 13" fill="currentColor"><polygon points="0,0 11,6.5 0,13"/></svg>
      <svg id="rp-pause-icon" width="11" height="13" viewBox="0 0 11 13" fill="currentColor" style="display:none"><rect x="0" y="0" width="4" height="13" rx="1"/><rect x="7" y="0" width="4" height="13" rx="1"/></svg>
    </button>
    <button class="rp-btn" id="rp-fwd" title="Forward 10 minutes">
      <svg width="16" height="13" viewBox="0 0 16 13" fill="currentColor">
        <rect x="0" y="0" width="1.5" height="13" rx="0.75"/>
        <polygon points="2,0 9,4.5 9,0 16,6.5 9,13 9,8.5 2,13"/>
      </svg>
      <span class="rp-label">+10m</span>
    </button>
    <div class="rp-divider"></div>
    <button class="rp-btn" id="rp-speed" title="Playback speed">1×</button>
    <div class="rp-divider"></div>
    <label class="rp-announce" title="Announce POIs during replay">
      <input type="checkbox" id="rp-announce" checked />
      <span>📍 POIs</span>
    </label>
  </div>

  <div id="dna" class="glass-pill">${buildDnaHTML(score)}</div>
  </div><!-- #bottom-pills -->

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const coords        = ${JSON.stringify(coords)};
    const arrowData     = ${JSON.stringify(arrowData)};
    const replayCoords  = ${JSON.stringify(replayCoords)};
    const vehiclePhoto  = ${JSON.stringify(vehiclePhoto)};
    const poiData       = ${JSON.stringify(poiSnapshot)};
    const poiSettingsData = ${JSON.stringify(poiSettings)};
    const SPEEDS        = [1, 2, 4, 8, 16, 32];

    // ── Map ──────────────────────────────────────────────────────
    const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    const map = L.map('map', { zoomControl: false });
    if (!isTouchDevice) {
      L.control.zoom({ position: 'bottomright' }).addTo(map);
    }
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OSM &copy; CARTO', subdomains: 'abcd', maxZoom: 19
    }).addTo(map);

    let poly = null;
    if (coords.length > 1) {
      poly = L.polyline(coords, { color: '#f97316', weight: 4, opacity: 0.9 }).addTo(map);

      arrowData.forEach(a => {
        L.marker([a.lat, a.lng], {
          icon: L.divIcon({
            className: '',
            html: '<div class="route-arrow" style="transform:rotate(' + a.bearing + 'deg)">' +
                  '<svg viewBox="0 0 10 14" width="10" height="14">' +
                  '<polygon points="5,0 10,14 5,10 0,14" fill="#f97316" opacity="0.85"/>' +
                  '</svg></div>',
            iconSize: [10, 14], iconAnchor: [5, 7]
          }),
          interactive: false, zIndexOffset: -1
        }).addTo(map);
      });

      L.circleMarker(coords[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#22c55e', fillOpacity: 1 })
       .bindTooltip('Start').addTo(map);
      L.circleMarker(coords[coords.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#ef4444', fillOpacity: 1 })
       .bindTooltip('End').addTo(map);

      map.fitBounds(poly.getBounds(), { padding: [60, 60] });
    } else {
      map.setView([37.7749, -122.4194], 13);
    }

    // ── POI markers ───────────────────────────────────────────────
    const _PC={'fuel_stop':'#ef4444','track_circuit':'#7c3aed','viewpoint_scenic':'#06b6d4','restaurant_cafe':'#f59e0b','parking':'#3b82f6','home_base':'#22c55e','garage_storage':'#64748b','other':'#f97316'};
    const _PI={'fuel_stop':'⛽','track_circuit':'🏁','viewpoint_scenic':'🏔️','restaurant_cafe':'🍽️','parking':'🅿️','home_base':'🏠','garage_storage':'🏗️','other':'📍'};
    function _esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
    poiData.forEach(poi=>{
      const clr=_PC[poi.category]||'#f97316', ico=_PI[poi.category]||'📍';
      L.marker([poi.lat,poi.lng],{
        icon:L.divIcon({className:'',html:'<div style="width:32px;height:32px;border-radius:8px;background:'+clr+';display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.3);border:2px solid rgba(255,255,255,.9)">'+ico+'</div>',iconSize:[32,32],iconAnchor:[16,16]}),
        zIndexOffset:500,interactive:false
      }).bindTooltip(_esc(poi.friendlyName||poi.name),{direction:'top'}).addTo(map);
      if(poiSettingsData.showRadiusCircle)
        L.circle([poi.lat,poi.lng],{radius:poiSettingsData.approachRadiusM,color:clr,weight:1,fillOpacity:0.08,interactive:false}).addTo(map);
    });

    // ── POI proximity announcements ────────────────────────────────
    // Entry-detection: announce only on outside→inside transition.
    // undefined = initial state (no announcement); true/false = inside/outside.
    let _blobVoice=null;
    function _initBlobVoice(){
      const vv=speechSynthesis.getVoices();
      if(!vv.length)return;
      _blobVoice=vv.find(v=>v.name==='Google US English')||vv.find(v=>v.lang==='en-US')||null;
    }
    function _unlockBlobSpeech(){
      if(!window.speechSynthesis)return;
      const u=new SpeechSynthesisUtterance('');u.volume=0;
      speechSynthesis.speak(u);
      _initBlobVoice();
    }
    if(window.speechSynthesis){
      speechSynthesis.addEventListener('voiceschanged',_initBlobVoice);
      _initBlobVoice();
      document.addEventListener('touchstart',_unlockBlobSpeech,{once:true});
      document.addEventListener('click',_unlockBlobSpeech,{once:true});
    }
    const _poiInside=new Map();
    function handlePoiBlobProx(lat,lng){
      if(!poiData.length||!window.speechSynthesis)return;
      const r=poiSettingsData.approachRadiusM, toR=d=>d*Math.PI/180;
      poiData.forEach(poi=>{
        const dLa=toR(poi.lat-lat),dLo=toR(poi.lng-lng);
        const a=Math.sin(dLa/2)**2+Math.cos(toR(lat))*Math.cos(toR(poi.lat))*Math.sin(dLo/2)**2;
        const inside=6371000*2*Math.asin(Math.sqrt(a))<=r;
        const was=_poiInside.get(poi.id);
        _poiInside.set(poi.id,inside);
        if(inside&&was===false){
          const utt=new SpeechSynthesisUtterance('Approaching '+(poi.friendlyName||poi.name));
          if(_blobVoice)utt.voice=_blobVoice;
          speechSynthesis.speak(utt);
        }
      });
    }
    document.getElementById('rp-announce')?.addEventListener('change',e=>{if(!e.target.checked)_poiInside.clear();});

    // ── Replay engine ─────────────────────────────────────────────
    const rc         = replayCoords;
    const hasReplay  = rc.length >= 2 && rc[0].ts > 0 && rc[rc.length - 1].ts > rc[0].ts;

    if (!hasReplay) {
      const ctrl = document.getElementById('replay-controls');
      ctrl.style.opacity = '0.35';
      ctrl.style.pointerEvents = 'none';
    } else {
      const startTs = rc[0].ts;
      const totalMs = rc[rc.length - 1].ts - startTs;

      let state        = 'idle';
      let speedIdx     = 0;
      let seekMs       = 0;
      let wallStart    = 0;
      let animFrame    = null;
      let lastBearing  = 0;

      // ── Marker ─────────────────────────────────────────────────
      function makeIcon(bearing) {
        if (vehiclePhoto) {
          return L.divIcon({
            className: '',
            html: '<img class="rp-photo" src="' + vehiclePhoto + '" />',
            iconSize:   [56, 56],
            iconAnchor: [28, 28],
          });
        }
        return L.divIcon({
          className: '',
          html: '<div class="rp-chevron" style="transform:rotate(' + bearing + 'deg);">' +
                  '<svg viewBox="0 0 18 26" width="18" height="26">' +
                    '<polygon points="9,0 18,26 9,20 0,26" fill="#f97316" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>' +
                  '</svg>' +
                '</div>',
          iconSize:   [18, 26],
          iconAnchor: [9, 13],
        });
      }

      const replayMarker = L.marker([rc[0].lat, rc[0].lng], {
        icon: makeIcon(0), interactive: false, zIndexOffset: 1000,
      }).addTo(map);

      function updateBearing(bearing) {
        if (vehiclePhoto) return;
        const el = replayMarker.getElement();
        if (!el) return;
        const chev = el.querySelector('.rp-chevron');
        if (chev) chev.style.transform = 'rotate(' + bearing + 'deg)';
      }

      // ── Math helpers ────────────────────────────────────────────
      function getBrg(lat1, lon1, lat2, lon2) {
        const r = Math.PI / 180;
        const dL = (lon2 - lon1) * r;
        const y  = Math.sin(dL) * Math.cos(lat2 * r);
        const x  = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
                   Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dL);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      }

      function bracketIdx(elapsed) {
        const target = startTs + elapsed;
        let lo = 0, hi = rc.length - 1;
        while (lo < hi - 1) {
          const mid = (lo + hi) >>> 1;
          if (rc[mid].ts <= target) lo = mid; else hi = mid;
        }
        return lo;
      }

      function interpolate(elapsed) {
        const i  = bracketIdx(elapsed);
        const p0 = rc[i];
        const p1 = rc[Math.min(i + 1, rc.length - 1)];
        if (p0 === p1 || p1.ts === p0.ts) {
          return { lat: p0.lat, lng: p0.lng, speed: p0.speed, bearing: lastBearing };
        }
        const t   = (startTs + elapsed - p0.ts) / (p1.ts - p0.ts);
        const lat = p0.lat + t * (p1.lat - p0.lat);
        const lng = p0.lng + t * (p1.lng - p0.lng);
        const speed = (p0.speed != null && p1.speed != null)
          ? p0.speed + t * (p1.speed - p0.speed)
          : (p0.speed ?? p1.speed ?? null);
        return { lat, lng, speed, bearing: getBrg(p0.lat, p0.lng, p1.lat, p1.lng) };
      }

      function fmtTime(ts) {
        const d = new Date(ts);
        let h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
        const ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0') + ' ' + ap;
      }

      // ── Frame application ───────────────────────────────────────
      function applyFrame(elapsed) {
        const pt = interpolate(elapsed);
        lastBearing = pt.bearing;
        replayMarker.setLatLng([pt.lat, pt.lng]);
        if(state==='playing'&&document.getElementById('rp-announce')?.checked)handlePoiBlobProx(pt.lat,pt.lng);
        updateBearing(pt.bearing);
        document.getElementById('hud-time').textContent  = fmtTime(startTs + elapsed);
        document.getElementById('hud-speed').textContent = pt.speed != null
          ? pt.speed.toFixed(1) + ' MPH' : '-- MPH';
        const latD = 3 / 69;
        const lngD = 3 / (69 * Math.cos(pt.lat * Math.PI / 180));
        const carBox = L.latLngBounds(
          [pt.lat - latD, pt.lng - lngD],
          [pt.lat + latD, pt.lng + lngD]
        );
        if (!map.getBounds().contains(carBox)) {
          map.panTo([pt.lat, pt.lng], { animate: true, duration: 0.5 });
        }
      }

      function nowElapsed() {
        const ms = state === 'playing'
          ? Math.min((Date.now() - wallStart) * SPEEDS[speedIdx] + seekMs, totalMs)
          : Math.min(seekMs, totalMs);
        return ms;
      }

      function setPlayIcon(playing) {
        document.getElementById('rp-play-icon').style.display  = playing ? 'none' : '';
        document.getElementById('rp-pause-icon').style.display = playing ? ''     : 'none';
      }

      function tick() {
        if (state !== 'playing') return;
        const elapsed = nowElapsed();
        applyFrame(elapsed);
        if (elapsed >= totalMs) { toIdle(); return; }
        animFrame = requestAnimationFrame(tick);
      }

      function zoomToMarker(lat, lng) {
        const latD = 5 / 69;
        const lngD = 5 / (69 * Math.cos(lat * Math.PI / 180));
        map.fitBounds([[lat - latD, lng - lngD], [lat + latD, lng + lngD]], { animate: true, duration: 0.8 });
      }

      function zoomToRoute() {
        if (poly) map.fitBounds(poly.getBounds(), { padding: [60, 60], animate: true, duration: 0.8 });
      }

      function toIdle() {
        cancelAnimationFrame(animFrame);
        state = 'idle'; seekMs = 0;
        applyFrame(0);
        setPlayIcon(false);
        zoomToRoute();
      }

      // ── Controls ────────────────────────────────────────────────
      document.getElementById('rp-playpause').addEventListener('click', () => {
        if (state === 'idle' || state === 'paused') {
          wallStart = Date.now();
          state = 'playing';
          setPlayIcon(true);
          animFrame = requestAnimationFrame(tick);
          const pt = interpolate(seekMs);
          zoomToMarker(pt.lat, pt.lng);
        } else {
          seekMs = nowElapsed();
          cancelAnimationFrame(animFrame);
          state = 'paused';
          setPlayIcon(false);
        }
      });

      document.getElementById('rp-stop').addEventListener('click', () => {
        cancelAnimationFrame(animFrame);
        toIdle();
      });

      document.getElementById('rp-back').addEventListener('click', () => {
        seekMs = Math.max(0, nowElapsed() - 600000);
        if (state === 'playing') wallStart = Date.now();
        applyFrame(seekMs);
      });

      document.getElementById('rp-fwd').addEventListener('click', () => {
        seekMs = Math.min(totalMs, nowElapsed() + 600000);
        if (state === 'playing') wallStart = Date.now();
        applyFrame(seekMs);
        if (seekMs >= totalMs) { cancelAnimationFrame(animFrame); toIdle(); }
      });

      document.getElementById('rp-speed').addEventListener('click', () => {
        seekMs   = nowElapsed();
        wallStart = Date.now();
        speedIdx = (speedIdx + 1) % SPEEDS.length;
        const spd = SPEEDS[speedIdx];
        const btn = document.getElementById('rp-speed');
        btn.textContent = spd + '\xd7';
        btn.classList.toggle('active', spd > 1);
      });

      // Initialise HUD at drive start
      applyFrame(0);
    }
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  if (isStandalone) {
    window.location.href = url;
  } else {
    newWin.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Default car SVG used in history when a vehicle has no photo.
const DEFAULT_CAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5 11l1.5-4.5A2 2 0 018.4 5h7.2a2 2 0 011.9 1.5L19 11"/>
  <rect x="2" y="11" width="20" height="7" rx="2"/>
  <circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>
  <path d="M2 14h20"/>
</svg>`;

async function renderHistory() {
  historyList.innerHTML = '<p class="empty-history">Loading…</p>';
  let drives, vehicles;
  try {
    [drives, vehicles] = await Promise.all([getAllDrives(), getAllVehicles()]);
  } catch (err) {
    historyList.innerHTML = `<p class="empty-history">Could not load history: ${escapeHTML(err.message)}</p>`;
    return;
  }
  if (!drives.length) {
    historyList.innerHTML = '<p class="empty-history">No drives recorded yet. Hit Start Drive!</p>';
    return;
  }

  // Batch the lazy score backfill before touching the DOM.
  const backfillUpdates = [];
  for (const drive of drives) {
    if (!drive.score && (drive.distanceMiles || 0) >= 1 && drive.coordinates?.length >= 2) {
      drive.score = computeDriveScore(drive.coordinates, drive.distanceMiles);
      backfillUpdates.push(updateDriveById(drive.id, { score: drive.score }));
    }
  }
  if (backfillUpdates.length) await Promise.all(backfillUpdates);

  // Build a name → photo map for O(1) lookup per drive.
  const vehiclePhotoMap = new Map(vehicles.map(v => [v.name, v.photo || null]));

  historyList.innerHTML = '';
  let rendered = 0;

  function renderPage() {
    historyObserver?.disconnect();
    historyObserver = null;

    const page = drives.slice(rendered, rendered + HISTORY_PAGE_SIZE);
    page.forEach(drive => {
      const date       = new Date(drive.startedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const time       = new Date(drive.startedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const partLabel  = drive.totalParts ? ` — Part ${drive.partNumber} of ${drive.totalParts}` : '';
      const baseName   = `${(drive.vehicle || 'Drive').replace(/\s+/g, '_')}_${new Date(drive.startedAt).toISOString().slice(0,10)}`;
      const photo      = vehiclePhotoMap.get(drive.vehicle);
      const vSafe      = escapeHTML(drive.vehicle || 'Unknown Vehicle');
      const driveLabel = `${vSafe}${escapeHTML(partLabel)}, ${date}`;

      const thumbHTML = photo
        ? `<img src="${escapeHTML(photo)}" class="history-vehicle-thumb" alt="${vSafe}" />`
        : `<div class="history-vehicle-thumb history-vehicle-thumb-default">${DEFAULT_CAR_SVG}</div>`;

      const item = document.createElement('div');
      item.className = 'history-item';
      item.setAttribute('role', 'listitem');
      item.innerHTML = `
        <div class="history-item-body">
          ${thumbHTML}
          <div class="history-item-content">
            <div class="history-item-header">
              <span class="history-item-title">${vSafe}${escapeHTML(partLabel)}</span>
              <span class="history-item-date">${date} ${time}</span>
            </div>
            <div class="history-item-stats">
              <div class="history-stat"><span class="history-stat-label">Distance</span><span class="history-stat-value">${drive.distanceMiles.toFixed(2)} mi</span></div>
              <div class="history-stat"><span class="history-stat-label">Duration</span><span class="history-stat-value">${formatDuration(drive.durationSeconds)}</span></div>
              <div class="history-stat"><span class="history-stat-label">Score</span><span class="history-stat-value">${drive.score ? gradeBadgeHTML(drive.score.grade) : '<span style="color:var(--text-muted)">—</span>'}</span></div>
            </div>
            <div class="history-item-actions">
              <button class="export-btn map-view-btn" data-format="map" aria-label="View map for ${driveLabel}">🗺 Map</button>
              <button class="export-btn" data-format="gpx" aria-label="Export GPX for ${driveLabel}">↓ GPX</button>
              <button class="export-btn" data-format="kml" aria-label="Export KML for ${driveLabel}">↓ KML</button>
              <button class="export-btn" data-format="ai" aria-label="Copy AI export for ${driveLabel}">⊕ AI</button>
              <button class="export-btn delete-btn" data-format="delete" aria-label="Delete ${driveLabel}" style="margin-left:auto">🗑 Delete</button>
            </div>
          </div>
        </div>`;

      const actionsEl = item.querySelector('.history-item-actions');

      item.querySelectorAll('.export-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const format = btn.dataset.format;

          if (format === 'delete') {
            const confirmEl = document.createElement('div');
            confirmEl.className = 'history-delete-confirm';
            const confirmLabel = drive.totalParts
              ? `Delete all ${drive.totalParts} parts?`
              : 'Delete permanently?';
            confirmEl.innerHTML = `
              <span>${escapeHTML(confirmLabel)}</span>
              <button class="export-btn confirm-yes" aria-label="Confirm delete ${driveLabel}">Yes, delete</button>
              <button class="export-btn confirm-no" aria-label="Cancel delete">Cancel</button>`;
            actionsEl.replaceWith(confirmEl);
            confirmEl.querySelector('.confirm-yes').addEventListener('click', async () => {
              const parts = drive.driveGroupId
                ? drives.filter(d => d.driveGroupId === drive.driveGroupId).sort((a, b) => a.partNumber - b.partNumber)
                : [drive];
              for (const part of parts) await deleteDrive(part.id);
              historyDirty = true;
              renderHistory();
            });
            confirmEl.querySelector('.confirm-no').addEventListener('click', () => {
              confirmEl.replaceWith(actionsEl);
            });
            return;
          }

          if (format === 'map') { openDriveMap(drive); return; }

          // GPX / KML / AI — use in-memory drives array, no extra IDB read.
          const parts = drive.driveGroupId
            ? drives.filter(d => d.driveGroupId === drive.driveGroupId).sort((a, b) => a.partNumber - b.partNumber)
            : [drive];
          const combined = { ...drive, coordinates: parts.flatMap(p => p.coordinates || []) };
          if (format === 'gpx') downloadFile(buildGPX(combined), `${baseName}.gpx`, 'application/gpx+xml');
          if (format === 'kml') downloadFile(buildKML(combined), `${baseName}.kml`, 'application/vnd.google-earth.kml+xml');
          if (format === 'ai') {
            try {
              await navigator.clipboard.writeText(buildAIExport(combined));
              showToast('Copied for AI ✓');
            } catch {
              showToast('Copy failed — try again', 3000);
            }
          }
        });
      });

      historyList.appendChild(item);
    });

    rendered += page.length;

    // Attach IntersectionObserver sentinel if more drives remain.
    // rAF defers the initial check until layout has settled so the sentinel
    // isn't immediately considered visible before overflow is computed.
    if (rendered < drives.length) {
      const sentinel = document.createElement('div');
      sentinel.className = 'history-sentinel';
      historyList.appendChild(sentinel);
      historyObserver = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting) renderPage();
      }, { root: historyList, threshold: 0 });
      requestAnimationFrame(() => {
        if (sentinel.parentElement) historyObserver.observe(sentinel);
      });
    }
  }

  renderPage();
  historyDirty = false;
}

// ── Focus trap ──────────────────────────────────────────────────────────────
let _historyOpener = null;

function _historyTrapKey(e) {
  if (e.key === 'Escape') { closeHistory(); return; }
  if (e.key !== 'Tab') return;
  const focusable = Array.from(historyPanel.querySelectorAll(
    'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  ));
  if (!focusable.length) { e.preventDefault(); return; }
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

// ── Open / close ─────────────────────────────────────────────────────────────
function openHistory() {
  if (historyDirty) renderHistory();
  _historyOpener = document.activeElement;
  HISTORY_INERT_TARGETS.forEach(el => el?.setAttribute('inert', ''));
  historyOverlay.classList.add('open');
  document.getElementById('history-close').focus();
  document.addEventListener('keydown', _historyTrapKey);
}

function closeHistory() {
  historyObserver?.disconnect();
  historyObserver = null;
  historyOverlay.classList.remove('open');
  HISTORY_INERT_TARGETS.forEach(el => el?.removeAttribute('inert'));
  document.removeEventListener('keydown', _historyTrapKey);
  _historyOpener?.focus();
  _historyOpener = null;
}

document.getElementById('history-close').addEventListener('click', closeHistory);
historyOverlay.addEventListener('click', e => { if (e.target === historyOverlay) closeHistory(); });
window.renderHistory = renderHistory;

// ─── Hamburger menu ───────────────────────────────────────────────────────────
const menuBtn     = document.getElementById('menu-btn');
const navMenu     = document.getElementById('nav-menu');
const navBackdrop = document.getElementById('nav-menu-backdrop');

function openMenu() {
  if (!navMenu || !navBackdrop) return;
  const headerBottom = document.getElementById('app-header').getBoundingClientRect().bottom;
  navMenu.style.top  = `${headerBottom + 6}px`;
  navMenu.removeAttribute('hidden');
  navBackdrop.removeAttribute('hidden');
  menuBtn?.setAttribute('aria-expanded', 'true');
}

function closeMenu() {
  navMenu?.setAttribute('hidden', '');
  navBackdrop?.setAttribute('hidden', '');
  menuBtn?.setAttribute('aria-expanded', 'false');
}

// Guard every listener — if any element is missing (stale HTML cache) the
// rest of the app still boots rather than crashing the entire DOMContentLoaded chain.
menuBtn?.addEventListener('click', () => {
  navMenu?.hasAttribute('hidden') ? openMenu() : closeMenu();
});

navBackdrop?.addEventListener('click', closeMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

document.getElementById('menu-history-btn')?.addEventListener('click', () => {
  closeMenu();
  openHistory();
});

document.getElementById('menu-about-btn')?.addEventListener('click', () => {
  closeMenu();
  const ver = APP_IS_BETA ? `v${APP_VERSION} (beta)` : `v${APP_VERSION}`;
  document.getElementById('about-version').textContent = ver;
  document.getElementById('about-overlay').classList.add('open');
});

document.getElementById('about-close')?.addEventListener('click', () => {
  document.getElementById('about-overlay').classList.remove('open');
});

document.getElementById('about-overlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('about-overlay')) {
    document.getElementById('about-overlay').classList.remove('open');
  }
});

document.getElementById('menu-sync-btn')?.addEventListener('click', async () => {
  closeMenu();
  if (typeof window.syncOnSignIn !== 'function') {
    setStatus('Sign in to sync with cloud.');
    return;
  }
  const btn = document.getElementById('menu-sync-btn');
  btn?.classList.add('syncing');
  await window.syncOnSignIn();
  await populateVehicleDropdown();
  btn?.classList.remove('syncing');
});

document.getElementById('menu-settings-btn')?.addEventListener('click', () => {
  closeMenu();
  settingsOverlay.classList.add('open');
  showVehicleList();
  renderVehicleList();
});

// ═══════════════════════════════════════════════════════════════
// 8. Vehicle management  (Settings panel)
// ═══════════════════════════════════════════════════════════════

const settingsOverlay  = document.getElementById('settings-overlay');
const settingsListView = document.getElementById('settings-list-view');
const settingsFormView = document.getElementById('settings-form-view');
const vehicleListEl    = document.getElementById('vehicle-list');
const vehicleForm      = document.getElementById('vehicle-form');
const formTitle        = document.getElementById('settings-form-title');
const vehicleIdInput   = document.getElementById('v-id');

/** Rebuild the header <select> from IndexedDB and restore last-used selection. */
async function populateVehicleDropdown() {
  const vehicles = await getAllVehicles();
  const select   = document.getElementById('vehicle-select');
  const saved    = localStorage.getItem('selectedVehicle') || '';

  select.innerHTML = '';

  if (!vehicles.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = 'No vehicles — add one in Garage';
    select.appendChild(opt);
    updateVehiclePhoto('');
    return;
  }

  vehicles.forEach(v => {
    const opt = document.createElement('option');
    opt.value       = v.name;
    opt.textContent = v.name;
    if (v.name === saved) opt.selected = true;
    select.appendChild(opt);
  });

  // Update the photo for whichever vehicle ends up selected.
  updateVehiclePhoto(select.value);
}

/**
 * Pre-load the selected vehicle's photo into the img element.
 * The wrap stays hidden — it is only shown during an active drive by showVehiclePhoto().
 */
async function updateVehiclePhoto(vehicleName) {
  const wrap = document.getElementById('vehicle-photo-wrap');
  const img  = document.getElementById('vehicle-photo-img');
  if (!wrap || !img) return;

  // Always hide when the selection changes (drive not active).
  wrap.classList.add('hidden');

  if (!vehicleName) { img.src = ''; return; }

  const vehicles = await getAllVehicles();
  const vehicle  = vehicles.find(v => v.name === vehicleName);
  img.src = vehicle?.photo || '';
}

/** Reveal the vehicle photo — called only when a drive starts. */
function showVehiclePhoto() {
  const wrap = document.getElementById('vehicle-photo-wrap');
  const img  = document.getElementById('vehicle-photo-img');
  if (wrap && img?.src && img.src !== window.location.href) {
    wrap.classList.remove('hidden');
  }
}

/** Hide the vehicle photo — called when a drive stops. */
function hideVehiclePhoto() {
  document.getElementById('vehicle-photo-wrap')?.classList.add('hidden');
}

// Persist selection and update photo when vehicle changes.
document.getElementById('vehicle-select').addEventListener('change', function () {
  localStorage.setItem('selectedVehicle', this.value);
  updateVehiclePhoto(this.value);
});

/** Render the vehicle list inside the Settings panel. */
async function renderVehicleList() {
  vehicleListEl.innerHTML = '<p class="settings-empty">Loading…</p>';
  const vehicles = await getAllVehicles();

  if (!vehicles.length) {
    vehicleListEl.innerHTML = `
      <div class="settings-empty-state">
        <svg class="settings-empty-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12"/>
        </svg>
        <p class="settings-empty-title">No vehicles added yet</p>
        <p class="settings-empty-sub">Tap "Add Vehicle" to get started.</p>
      </div>`;
    return;
  }

  vehicleListEl.innerHTML = '';
  vehicles.forEach(v => {
    const card = document.createElement('div');
    card.className = 'vehicle-card';
    // Thumbnail: saved photo or default car SVG
    const thumbHTML = v.photo
      ? `<img src="${v.photo}" class="vehicle-card-thumb" alt="${v.name}" />`
      : `<div class="vehicle-card-thumb vehicle-card-thumb-default">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
             <path d="M5 11l1.5-4.5A2 2 0 018.4 5h7.2a2 2 0 011.9 1.5L19 11"/>
             <rect x="2" y="11" width="20" height="7" rx="2"/>
             <circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>
             <path d="M2 14h20"/>
           </svg>
         </div>`;

    card.innerHTML = `
      <div class="vehicle-card-body">
        ${thumbHTML}
        <div class="vehicle-card-text">
          <p class="vehicle-card-name">${v.name}</p>
          ${v.year || v.make || v.model
            ? `<p class="vehicle-card-sub">${[v.year, v.make, v.model].filter(Boolean).join(' ')}</p>`
            : ''}
          ${v.notes ? `<p class="vehicle-card-notes">${v.notes}</p>` : ''}
        </div>
        <div class="vehicle-card-actions">
          <button class="vehicle-edit-btn" data-id="${v.id}" aria-label="Edit ${v.name}">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
          </button>
          <button class="vehicle-delete-btn" data-id="${v.id}" data-name="${v.name}" aria-label="Delete ${v.name}">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </button>
        </div>
      </div>`;

    card.querySelector('.vehicle-edit-btn').addEventListener('click', () => {
      openVehicleForm('edit', v);
    });

    card.querySelector('.vehicle-delete-btn').addEventListener('click', async () => {
      if (!confirm(`Delete "${v.name}"? This cannot be undone.`)) return;
      await deleteVehicle(v.id);
      await populateVehicleDropdown();
      renderVehicleList();
    });

    vehicleListEl.appendChild(card);
  });
}

/** Switch to the add/edit form view. */
function openVehicleForm(mode, vehicle = null) {
  formTitle.textContent = mode === 'add' ? 'Add Vehicle' : 'Edit Vehicle';

  vehicleIdInput.value                     = vehicle?.id    ?? '';
  document.getElementById('v-name').value  = vehicle?.name  ?? '';
  document.getElementById('v-make').value  = vehicle?.make  ?? '';
  document.getElementById('v-model').value = vehicle?.model ?? '';
  document.getElementById('v-year').value  = vehicle?.year  ?? '';
  document.getElementById('v-notes').value = vehicle?.notes ?? '';

  // Reset the photo UI then show existing photo if present.
  const photoInput   = document.getElementById('v-photo-input');
  const uploadZone   = document.getElementById('v-photo-upload-zone');
  const previewZone  = document.getElementById('v-photo-preview-zone');
  const previewImg   = document.getElementById('v-photo-preview-img');
  if (photoInput)  photoInput.value = '';

  if (vehicle?.photo && previewImg && previewZone && uploadZone) {
    previewImg.src = vehicle.photo;
    uploadZone.classList.add('hidden');
    previewZone.classList.remove('hidden');
  } else if (uploadZone && previewZone) {
    uploadZone.classList.remove('hidden');
    previewZone.classList.add('hidden');
  }

  settingsListView.classList.add('hidden');
  settingsFormView.classList.remove('hidden');
  document.getElementById('v-name').focus();
}

function showVehicleList() {
  settingsFormView.classList.add('hidden');
  settingsListView.classList.remove('hidden');
}

// Form submit — add or update.
vehicleForm.addEventListener('submit', async e => {
  e.preventDefault();
  const id         = vehicleIdInput.value ? Number(vehicleIdInput.value) : null;
  const photoInput = document.getElementById('v-photo-input');
  const previewImg = document.getElementById('v-photo-preview-img');

  // Determine photo value:
  //  - new file selected → compress it
  //  - preview shows existing photo → keep it
  //  - preview hidden → photo was removed → null
  let photo = null;
  const previewZone = document.getElementById('v-photo-preview-zone');
  if (photoInput.files[0]) {
    photo = await compressImage(photoInput.files[0]);
  } else if (previewImg?.src && !previewZone?.classList.contains('hidden')) {
    photo = previewImg.src.startsWith('data:') ? previewImg.src : null;
  }

  const data = {
    name:  document.getElementById('v-name').value.trim(),
    make:  document.getElementById('v-make').value.trim(),
    model: document.getElementById('v-model').value.trim(),
    year:  Number(document.getElementById('v-year').value) || null,
    notes: document.getElementById('v-notes').value.trim(),
    photo,
  };

  if (!data.name) { document.getElementById('v-name').focus(); return; }

  if (id) {
    await updateVehicle(id, data);
  } else {
    await addVehicle(data);
  }
  localStorage.setItem('selectedVehicle', data.name);

  await populateVehicleDropdown();
  showVehicleList();
  renderVehicleList();
});

// ── Photo upload UI handlers ──────────────────────────────────────────────────
(function initPhotoUI() {
  const photoInput  = document.getElementById('v-photo-input');
  const uploadZone  = document.getElementById('v-photo-upload-zone');
  const previewZone = document.getElementById('v-photo-preview-zone');
  const previewImg  = document.getElementById('v-photo-preview-img');
  const removeBtn   = document.getElementById('v-photo-remove-btn');
  if (!photoInput) return;

  function showPreview(dataUrl) {
    previewImg.src = dataUrl;
    uploadZone.classList.add('hidden');
    previewZone.classList.remove('hidden');
  }

  function showUploadZone() {
    previewImg.src = '';
    photoInput.value = '';
    previewZone.classList.add('hidden');
    uploadZone.classList.remove('hidden');
  }

  photoInput.addEventListener('change', async function () {
    if (this.files[0]) {
      const dataUrl = await compressImage(this.files[0]);
      showPreview(dataUrl);
    }
  });

  removeBtn?.addEventListener('click', showUploadZone);
})();

// Settings panel close (open is handled by the hamburger menu above).

document.getElementById('settings-close').addEventListener('click', () => {
  settingsOverlay.classList.remove('open');
});

settingsOverlay.addEventListener('click', e => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('open');
});

document.getElementById('add-vehicle-btn').addEventListener('click', () => {
  openVehicleForm('add');
});

document.getElementById('back-to-list-btn').addEventListener('click', showVehicleList);
document.getElementById('cancel-form-btn').addEventListener('click', showVehicleList);

// ═══════════════════════════════════════════════════════════════
// 9. PWA update handler & bootstrap
// ═══════════════════════════════════════════════════════════════

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          const toast = document.getElementById('update-toast');
          toast.classList.add('visible');
          document.getElementById('update-reload-btn').addEventListener('click', () => {
            nw.postMessage({ type: 'SKIP_WAITING' });
            window.location.reload();
          });
        }
      });
    });
    console.log('[SW] Registered:', reg.scope);
  } catch (err) {
    console.error('[SW] Registration failed:', err);
  }
}

function handleDeepLink() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('action') === 'start') setTimeout(startDrive, 800);
}

/** Start watching position for the idle blue dot. Stops automatically when a drive starts. */
function startIdleWatch() {
  if (!navigator.geolocation || idleWatchId !== null) return;
  let centred = false;
  idleWatchId = navigator.geolocation.watchPosition(
    pos => {
      const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
      if (!centred) {
        map.setView(latlng, 15);
        centred = true;
        setStatus('GPS ready. Tap Start Drive to begin recording.');
      }
      showLocationDot(latlng);
    },
    () => setStatus('Could not get location — check browser permissions.'),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );
}

/** Stop the idle watch (called when a drive starts). */
function stopIdleWatch() {
  if (idleWatchId !== null) {
    navigator.geolocation.clearWatch(idleWatchId);
    idleWatchId = null;
  }
}

function previewLocation() {
  startIdleWatch();
}

// ── Bootstrap ─────────────────────────────────────────────────
// registerSW runs immediately — no auth needed.
// ── Drive crash/kill recovery ────────────────────────────────────────────────

async function checkForDraft() {
  let draft;
  try { draft = await loadDraft(); } catch (e) { return; }
  if (!draft) return;
  if (draft.userId !== currentUserId) { await clearDraft(); return; }
  const hasEnoughData = draft.coordinates.length >= 3 || draft.flushedPartIds.length > 0;
  if (!hasEnoughData) { await clearDraft(); return; }
  showRecoveryModal(draft);
}

function showRecoveryModal(draft) {
  const elapsed = Math.floor((Date.now() - draft.startTime - draft.totalPausedMs) / 1000);
  document.getElementById('recovery-detail').textContent =
    `${draft.vehicle} · ${draft.totalDistanceMi.toFixed(2)} mi · ${formatDuration(elapsed)}`;
  document.getElementById('recovery-overlay').removeAttribute('hidden');

  document.getElementById('recovery-resume-btn').onclick = async () => {
    document.getElementById('recovery-overlay').setAttribute('hidden', '');
    await resumeFromDraft(draft);
  };
  document.getElementById('recovery-discard-btn').onclick = async () => {
    document.getElementById('recovery-overlay').setAttribute('hidden', '');
    await clearDraft();
  };
}

async function resumeFromDraft(draft) {
  sessionState.active          = true;
  sessionState.paused          = true;
  sessionState.startTime       = draft.startTime;
  sessionState.totalPausedMs   = draft.totalPausedMs;
  sessionState.pausedAt        = draft.pausedAt ?? Date.now();
  sessionState.coordinates     = draft.coordinates;
  sessionState.totalDistanceMi = draft.totalDistanceMi;
  sessionState.vehicle         = draft.vehicle;
  sessionState.flushedPartIds  = draft.flushedPartIds;
  sessionState.driveGroupId    = draft.driveGroupId;
  sessionState.isFlushing      = false;

  const sel   = document.getElementById('vehicle-select');
  sel.value   = draft.vehicle;
  sel.disabled = true;

  lastRecordedTs   = 0;
  lastGPSTimestamp = 0;
  gapCount         = 0;

  // Redraw the recovered route on the map.
  if (draft.coordinates.length >= 2) {
    const latlngs = draft.coordinates.map(c => L.latLng(c.lat, c.lng));
    routePolyline = L.polyline(latlngs, { color: '#f97316', weight: 4, opacity: 0.9 }).addTo(map);
    panToPosition(latlngs[latlngs.length - 1]);
  }

  stopIdleWatch();
  hideLocationDot();
  showVehiclePhoto();

  sessionState.watchId = navigator.geolocation.watchPosition(
    onPositionUpdate, onPositionError,
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );

  sessionState.timerInterval = setInterval(() => {
    if (sessionState.paused) return;
    els.duration.textContent = formatDuration(getElapsedSeconds());
  }, 1000);

  wakeLockHeartbeat = setInterval(async () => {
    if (!sessionState.active) return;
    if (!wakeLock) {
      await acquireWakeLock();
      if (!wakeLock) setStatus('⚠️ Screen lock lost — screen may dim during drive.');
    }
  }, 5 * 60 * 1000);

  sessionState.draftHeartbeat = setInterval(() => {
    if (sessionState.active) saveDraft().catch(() => {});
  }, 30_000);

  await clearDraft();

  updateTelemetry({
    speedMph:       0,
    distanceMiles:  sessionState.totalDistanceMi,
    elapsedSeconds: getElapsedSeconds(),
    altitudeM:      null,
    accuracyM:      null,
  });
  setCTAState('paused');
  setStatus('Drive recovered. Tap Resume to continue.');
}

// ═══════════════════════════════════════════════════════════════
// 10. POI Management
// ═══════════════════════════════════════════════════════════════

// ── In-memory state ───────────────────────────────────────────
let loadedPOIs     = [];
let poiSettings    = { approachRadiusM: 300, showRadiusCircle: false };
let poiMarkers     = [];
let poiCircles     = [];
let poiUnsub       = null;
let poiAnnounceLog = new Map();  // poiId → last announced timestamp (session only)
let poiPanelOpen   = false;
let placingPOI     = false;
let pendingLat     = null;
let pendingLng     = null;
let editingPoiId   = null;

// ── Category config ───────────────────────────────────────────
const POI_CATEGORIES = {
  fuel_stop:        { label: 'Fuel Stop',          icon: '⛽', color: '#ef4444' },
  track_circuit:    { label: 'Track / Circuit',    icon: '🏁', color: '#7c3aed' },
  viewpoint_scenic: { label: 'Viewpoint / Scenic', icon: '🏔️', color: '#06b6d4' },
  restaurant_cafe:  { label: 'Restaurant / Café',  icon: '🍽️', color: '#f59e0b' },
  parking:          { label: 'Parking',             icon: '🅿️', color: '#3b82f6' },
  home_base:        { label: 'Home / Base',         icon: '🏠', color: '#22c55e' },
  garage_storage:   { label: 'Garage / Storage',   icon: '🏗️', color: '#64748b' },
  other:            { label: 'Other',               icon: '📍', color: '#f97316' },
};

// ── Firestore refs ────────────────────────────────────────────
function _poisCol() {
  return firebase.firestore().collection('users').doc(currentUserId).collection('pois');
}
function _settingsDoc() {
  return firebase.firestore().collection('users').doc(currentUserId).collection('settings').doc('app');
}

// ── Voice selection ───────────────────────────────────────────
let _preferredVoice = null;

function _initPreferredVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return;
  _preferredVoice =
    voices.find(v => v.name === 'Google US English') ||
    voices.find(v => v.lang === 'en-US' && !v.localService === false) ||
    voices.find(v => v.lang === 'en-US') ||
    null;
}

// Mobile browsers block speechSynthesis.speak() unless primed by a user gesture.
// Fire a silent utterance on first tap to unlock it for the session.
function _unlockSpeech() {
  if (!window.speechSynthesis) return;
  const utt = new SpeechSynthesisUtterance('');
  utt.volume = 0;
  window.speechSynthesis.speak(utt);
  _initPreferredVoice(); // voices may now be populated on iOS
}

if (window.speechSynthesis) {
  window.speechSynthesis.addEventListener('voiceschanged', _initPreferredVoice);
  _initPreferredVoice();
  document.addEventListener('touchstart', _unlockSpeech, { once: true });
  document.addEventListener('click',      _unlockSpeech, { once: true });
}

// ── Proximity / voice ─────────────────────────────────────────
function handlePoiProximity(lat, lng) {
  if (!loadedPOIs.length || !window.speechSynthesis) return;
  const radiusM = poiSettings.approachRadiusM;
  for (const poi of loadedPOIs) {
    const inside = haversineMeters(lat, lng, poi.lat, poi.lng) <= radiusM;
    const was    = poiAnnounceLog.get(poi.id);
    poiAnnounceLog.set(poi.id, inside);
    if (inside && was === false) {
      const utt = new SpeechSynthesisUtterance(`Approaching ${poi.friendlyName || poi.name}`);
      if (_preferredVoice) utt.voice = _preferredVoice;
      window.speechSynthesis.speak(utt);
    }
  }
}

// ── Map markers ───────────────────────────────────────────────
function renderPoiMarkersOnMap() {
  if (!map) return;
  clearPoiMarkersOnMap();
  for (const poi of loadedPOIs) {
    const cat    = POI_CATEGORIES[poi.category] || POI_CATEGORIES.other;
    const marker = L.marker([poi.lat, poi.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div style="width:32px;height:32px;border-radius:8px;background:${cat.color};display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.3);border:2px solid rgba(255,255,255,.9)">${cat.icon}</div>`,
        iconSize: [32, 32], iconAnchor: [16, 16],
      }),
      zIndexOffset: 500,
    }).addTo(map);
    marker.bindTooltip(poi.friendlyName || poi.name, { direction: 'top' });
    poiMarkers.push(marker);
    if (poiSettings.showRadiusCircle) {
      const circle = L.circle([poi.lat, poi.lng], {
        radius: poiSettings.approachRadiusM,
        color: cat.color,
        weight: 1,
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map);
      poiCircles.push(circle);
    }
  }
}

function clearPoiMarkersOnMap() {
  poiMarkers.forEach(m => m.remove());
  poiCircles.forEach(c => c.remove());
  poiMarkers = [];
  poiCircles = [];
}

// ── Firestore listener ────────────────────────────────────────
function startPoiListener() {
  if (!currentUserId) return;
  poiUnsub?.();
  poiUnsub = _poisCol().onSnapshot(snap => {
    loadedPOIs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderPoiMarkersOnMap();
    if (poiPanelOpen) renderPoiList();
  }, err => console.warn('[POI] Listener error:', err.message));
}

window.stopPoiListener = function stopPoiListener() {
  poiUnsub?.();
  poiUnsub = null;
};

// ── POI settings ─────────────────────────────────────────────
async function loadPoiSettings() {
  try {
    const doc = await _settingsDoc().get();
    if (doc.exists && doc.data().poi) Object.assign(poiSettings, doc.data().poi);
  } catch (e) { /* use defaults */ }
}

let _settingsDebounce = null;
function savePoiSettingsDebounced() {
  clearTimeout(_settingsDebounce);
  _settingsDebounce = setTimeout(async () => {
    try { await _settingsDoc().set({ poi: poiSettings }, { merge: true }); }
    catch (e) { console.warn('[POI] Settings save failed:', e.message); }
  }, 800);
}

// ── POI CRUD ─────────────────────────────────────────────────
async function _addPOI(data) {
  await _poisCol().add({ ...data, createdAt: Date.now(), updatedAt: Date.now() });
}

async function _updatePOI(poiId, data) {
  await _poisCol().doc(poiId).set({ ...data, updatedAt: Date.now() }, { merge: true });
}

async function _deletePOI(poiId) {
  await _poisCol().doc(poiId).delete();
}

// ── Panel open/close ─────────────────────────────────────────
const poiOverlay    = document.getElementById('poi-overlay');
const poiListViewEl = document.getElementById('poi-list-view');
const poiFormViewEl = document.getElementById('poi-form-view');
const poiListEl     = document.getElementById('poi-list');

function openPoiPanel() {
  if (!poiOverlay) return;
  poiPanelOpen = true;
  poiOverlay.classList.add('open');
  _showPoiList();
  renderPoiList();
  document.getElementById('poi-radius-input').value     = poiSettings.approachRadiusM;
  document.getElementById('poi-circle-toggle').checked  = poiSettings.showRadiusCircle;
}

function closePoiPanel() {
  poiOverlay?.classList.remove('open');
  poiPanelOpen = false;
  _exitPlaceMode();
}

function _showPoiList() {
  poiListViewEl?.classList.remove('hidden');
  poiFormViewEl?.classList.add('hidden');
  editingPoiId = null;
}

function _showPoiForm(poi = null) {
  poiListViewEl?.classList.add('hidden');
  poiFormViewEl?.classList.remove('hidden');
  editingPoiId = poi?.id ?? null;
  document.getElementById('poi-form-title').textContent        = poi ? 'Edit POI' : 'Add POI';
  document.getElementById('poi-name-input').value              = poi?.name ?? '';
  document.getElementById('poi-friendly-input').value          = poi?.friendlyName ?? '';
  document.getElementById('poi-address-input').value           = poi?.address ?? '';
  document.getElementById('poi-category-select').value         = poi?.category ?? 'other';
  document.getElementById('poi-notes-input').value             = poi?.notes ?? '';
  document.getElementById('poi-address-results').setAttribute('hidden', '');
  pendingLat = poi?.lat ?? null;
  pendingLng = poi?.lng ?? null;
  _updatePlaceStatus();
}

function _updatePlaceStatus() {
  const el = document.getElementById('poi-place-status');
  if (!el) return;
  if (pendingLat !== null) {
    el.textContent = `📍 ${pendingLat.toFixed(5)}, ${pendingLng.toFixed(5)}`;
    el.className = 'poi-place-status placed';
  } else {
    el.textContent = 'No location set — search an address or click on the map';
    el.className = 'poi-place-status';
  }
}

// ── List rendering ────────────────────────────────────────────
function renderPoiList() {
  if (!poiListEl) return;
  if (!loadedPOIs.length) {
    poiListEl.innerHTML = '<p class="poi-empty">No POIs yet. Click + Add POI to create your first.</p>';
    return;
  }
  const sorted = [...loadedPOIs].sort((a, b) => a.name.localeCompare(b.name));
  poiListEl.innerHTML = '';
  for (const poi of sorted) {
    const cat = POI_CATEGORIES[poi.category] || POI_CATEGORIES.other;
    const row = document.createElement('div');
    row.className = 'poi-card';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      <button class="poi-card-icon-btn" data-id="${poi.id}" title="Pan map to ${escapeHTML(poi.name)}">
        <div class="poi-card-icon" style="background:${cat.color}">${cat.icon}</div>
      </button>
      <div class="poi-card-content">
        <div class="poi-card-name">${escapeHTML(poi.name)}</div>
        ${poi.friendlyName ? `<div class="poi-card-friendly">"${escapeHTML(poi.friendlyName)}"</div>` : ''}
        <div class="poi-card-sub">${escapeHTML(cat.label)}${poi.address ? ' · ' + escapeHTML(poi.address.split(',')[0]) : ''}</div>
      </div>
      <div class="poi-card-actions">
        <button class="poi-edit-btn" data-id="${poi.id}" aria-label="Edit ${escapeHTML(poi.name)}">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="poi-delete-btn" data-id="${poi.id}" aria-label="Delete ${escapeHTML(poi.name)}">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>`;
    poiListEl.appendChild(row);
  }

  poiListEl.querySelectorAll('.poi-card-icon-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const poi = loadedPOIs.find(p => p.id === btn.dataset.id);
      if (poi) { map?.setView([poi.lat, poi.lng], 16); closePoiPanel(); }
    });
  });
  poiListEl.querySelectorAll('.poi-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const poi = loadedPOIs.find(p => p.id === btn.dataset.id);
      if (poi) _showPoiForm(poi);
    });
  });
  poiListEl.querySelectorAll('.poi-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => _confirmDeletePOI(btn));
  });
}

function _confirmDeletePOI(btn) {
  const poi = loadedPOIs.find(p => p.id === btn.dataset.id);
  if (!poi) return;
  const card = btn.closest('.poi-card');
  if (card.querySelector('.poi-delete-confirm')) return;
  const conf = document.createElement('div');
  conf.className = 'poi-delete-confirm';
  conf.innerHTML = `<span>Delete "${escapeHTML(poi.name)}"?</span>
    <button class="poi-confirm-yes">Delete</button>
    <button class="poi-confirm-no">Cancel</button>`;
  card.appendChild(conf);
  conf.querySelector('.poi-confirm-yes').addEventListener('click', () => _deletePOI(poi.id));
  conf.querySelector('.poi-confirm-no').addEventListener('click', () => conf.remove());
}

// ── Map click-to-place ────────────────────────────────────────
function _enterPlaceMode() {
  if (placingPOI) return;
  placingPOI = true;
  poiOverlay?.classList.remove('open');
  document.getElementById('poi-place-banner')?.removeAttribute('hidden');
  map?.getContainer() && (map.getContainer().style.cursor = 'crosshair');
  map?.once('click', _onMapPlaceClick);
}

function _exitPlaceMode() {
  if (!placingPOI) return;
  placingPOI = false;
  document.getElementById('poi-place-banner')?.setAttribute('hidden', '');
  if (map?.getContainer()) map.getContainer().style.cursor = '';
  map?.off('click', _onMapPlaceClick);
}

async function _onMapPlaceClick(e) {
  placingPOI = false;
  document.getElementById('poi-place-banner')?.setAttribute('hidden', '');
  if (map?.getContainer()) map.getContainer().style.cursor = '';
  pendingLat = e.latlng.lat;
  pendingLng = e.latlng.lng;
  poiOverlay?.classList.add('open');
  _updatePlaceStatus();
  try {
    const url  = `https://nominatim.openstreetmap.org/reverse?lat=${pendingLat}&lon=${pendingLng}&format=json`;
    const data = await fetch(url).then(r => r.json());
    if (data.display_name) document.getElementById('poi-address-input').value = data.display_name;
  } catch (e) { /* silent — address field stays blank */ }
}

// ── Address search ────────────────────────────────────────────
async function _searchAddress() {
  const q = (document.getElementById('poi-address-input')?.value || '').trim();
  if (!q) return;
  const resultsEl = document.getElementById('poi-address-results');
  if (!resultsEl) return;
  resultsEl.innerHTML = '<div class="poi-geocode-loading">Searching…</div>';
  resultsEl.removeAttribute('hidden');
  try {
    const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`;
    const data = await fetch(url).then(r => r.json());
    if (!data.length) { resultsEl.innerHTML = '<div class="poi-geocode-loading">No results found.</div>'; return; }
    resultsEl.innerHTML = '';
    data.forEach(item => {
      const btn = document.createElement('button');
      btn.type      = 'button';
      btn.className = 'poi-geocode-result';
      btn.textContent = item.display_name;
      btn.addEventListener('click', () => {
        pendingLat = parseFloat(item.lat);
        pendingLng = parseFloat(item.lon);
        document.getElementById('poi-address-input').value = item.display_name;
        resultsEl.setAttribute('hidden', '');
        resultsEl.innerHTML = '';
        _updatePlaceStatus();
        map?.setView([pendingLat, pendingLng], 15);
      });
      resultsEl.appendChild(btn);
    });
  } catch (e) {
    resultsEl.innerHTML = '<div class="poi-geocode-loading">Search failed. Check your connection.</div>';
  }
}

// ── Form submit ───────────────────────────────────────────────
document.getElementById('poi-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const name = (document.getElementById('poi-name-input')?.value || '').trim();
  const nameErr = document.getElementById('poi-name-error');
  if (!name) { nameErr?.removeAttribute('hidden'); return; }
  nameErr?.setAttribute('hidden', '');
  if (pendingLat === null) {
    setStatus('Please set a POI location by clicking the map or searching an address.');
    return;
  }
  const data = {
    name,
    friendlyName: (document.getElementById('poi-friendly-input')?.value || '').trim(),
    address:      (document.getElementById('poi-address-input')?.value  || '').trim(),
    lat:          pendingLat,
    lng:          pendingLng,
    category:     document.getElementById('poi-category-select')?.value || 'other',
    notes:        (document.getElementById('poi-notes-input')?.value || '').trim(),
  };
  try {
    if (editingPoiId) { await _updatePOI(editingPoiId, data); }
    else              { await _addPOI(data); }
    _showPoiList();
  } catch (err) {
    setStatus(`POI save failed: ${err.message}`);
  }
});

// ── Settings panel ────────────────────────────────────────────
document.getElementById('poi-settings-btn')?.addEventListener('click', () => {
  document.getElementById('poi-settings-row')?.classList.toggle('hidden');
});

document.getElementById('poi-radius-input')?.addEventListener('input', () => {
  const v = parseInt(document.getElementById('poi-radius-input').value);
  if (v >= 50) { poiSettings.approachRadiusM = v; renderPoiMarkersOnMap(); savePoiSettingsDebounced(); }
});

document.getElementById('poi-circle-toggle')?.addEventListener('change', e => {
  poiSettings.showRadiusCircle = e.target.checked;
  renderPoiMarkersOnMap();
  savePoiSettingsDebounced();
});

// ── Button wiring ─────────────────────────────────────────────
document.getElementById('menu-poi-btn')?.addEventListener('click', () => {
  closeMenu();
  openPoiPanel();
});

document.getElementById('poi-close-btn')?.addEventListener('click', closePoiPanel);

document.getElementById('poi-add-btn')?.addEventListener('click', () => {
  pendingLat = null;
  pendingLng = null;
  _showPoiForm();
});

document.getElementById('poi-back-btn')?.addEventListener('click', () => {
  _exitPlaceMode();
  _showPoiList();
});

document.getElementById('poi-cancel-btn')?.addEventListener('click', () => {
  _exitPlaceMode();
  _showPoiList();
});

document.getElementById('poi-cancel-btn-2')?.addEventListener('click', () => {
  _exitPlaceMode();
  _showPoiList();
});

document.getElementById('poi-place-btn')?.addEventListener('click', _enterPlaceMode);

document.getElementById('poi-cancel-place-btn')?.addEventListener('click', () => {
  _exitPlaceMode();
  poiOverlay?.classList.add('open');
});

document.getElementById('poi-search-btn')?.addEventListener('click', _searchAddress);

document.getElementById('poi-address-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); _searchAddress(); }
});

// ─────────────────────────────────────────────────────────────
// initApp is called by auth.js once Google sign-in is verified.
window.addEventListener('DOMContentLoaded', () => {
  registerSW();
});

window.initApp = async function initApp(user) {
  console.log('[DriveTracker] Authenticated as', user?.email);

  // Scope all DB operations to this user.
  currentUserId = user.uid;

  // Migrate any pre-auth records so they're owned by this user.
  await migrateUnownedData(user.uid);

  // Sync the menu avatar thumbnail.
  const menuAvatar         = document.getElementById('user-avatar-menu');
  const menuAvatarFallback = document.getElementById('user-avatar-menu-fallback');
  if (menuAvatar && user?.photoURL) {
    menuAvatar.src = user.photoURL;
    menuAvatar.classList.remove('hidden');
    if (menuAvatarFallback) menuAvatarFallback.style.display = 'none';
  }
  // Header avatar src (in case initApp fires before auth.js hideLoginScreen).
  const headerAvatar = document.getElementById('user-avatar');
  if (headerAvatar && user?.photoURL) headerAvatar.src = user.photoURL;

  if (typeof L === 'undefined') {
    setStatus('Map library failed to load. Check your connection and reload.');
    document.getElementById('cta-btn').disabled = true;
    console.error('[DriveTracker] Leaflet (L) is not defined.');
    return;
  }

  await populateVehicleDropdown();
  initMap();
  await loadPoiSettings();
  startPoiListener();
  setCTAState('start');
  previewLocation();
  handleDeepLink();
  await checkForDraft();
};
