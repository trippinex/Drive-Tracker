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
const APP_VERSION = '1.2.1';
const APP_IS_BETA = false;

// ═══════════════════════════════════════════════════════════════
// 1. IndexedDB wrapper
// ═══════════════════════════════════════════════════════════════

const DB_NAME        = 'drivelog';
const DB_VERSION     = 5;           // v5: adds firestoreId index for cloud sync
const DRIVES_STORE   = 'drives';
const VEHICLES_STORE = 'vehicles';

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
  if (document.visibilityState === 'visible' && sessionState.active && !wakeLock) {
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
  flushedPartIds: [],   // local IndexedDB IDs of parts saved mid-drive
  driveGroupId:   null, // set on first flush; links all parts together
  isFlushing:     false, // prevents concurrent flush operations
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

  setCTAState('stop');
  setStatus('Drive started. Acquiring GPS signal…');
  document.getElementById('vehicle-select').disabled = true;
}

async function stopDrive() {
  if (!sessionState.active) return;

  if (sessionState.watchId !== null) {
    navigator.geolocation.clearWatch(sessionState.watchId);
    sessionState.watchId = null;
  }

  clearInterval(sessionState.timerInterval);
  sessionState.timerInterval = null;
  clearInterval(wakeLockHeartbeat);    // Fix 3: stop heartbeat
  wakeLockHeartbeat = null;
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
    if (coords.length > 1) {
      await saveDrive({
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

    for (let i = 0; i < chunks.length; i++) {
      await saveDrive({
        vehicle:         sessionState.vehicle,
        startedAt:       sessionState.startTime,
        endedAt, durationSeconds: duration, distanceMiles: distance,
        coordinates:     chunks[i],
        ...(isMultiPart && { driveGroupId, partNumber: i + 1, totalParts: chunks.length }),
      });
    }

    const partNote = isMultiPart ? ` (${chunks.length} parts)` : '';
    setStatus(`Drive saved (${coords.length} pts, ${distance.toFixed(2)} mi${partNote}).`);

  } else {
    setStatus('Drive cancelled — too few GPS points recorded.');
  }

  clearCarMarker();     // remove the drive's car marker so blue dot is visible again
  setCTAState('start');
  document.getElementById('vehicle-select').disabled = false;
  startIdleWatch();     // resume blue dot — will reappear on next GPS tick
}

// ── CTA button ──────────────────────────────────────────────────────────────
const ctaBtn = document.getElementById('cta-btn');

function setCTAState(state) {
  if (state === 'start') {
    ctaBtn.textContent = '▶  Start Drive';
    ctaBtn.className   = 'start';
  } else {
    ctaBtn.textContent = '⏹  Stop Drive';
    ctaBtn.className   = 'stop';
  }
}

ctaBtn.addEventListener('click', () => {
  sessionState.active ? stopDrive() : startDrive();
});

function setStatus(msg) {
  document.getElementById('status-bar').textContent = msg;
}

// ═══════════════════════════════════════════════════════════════
// 7. History & export
// ═══════════════════════════════════════════════════════════════

const historyOverlay = document.getElementById('history-overlay');
const historyList    = document.getElementById('history-list');

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
  // Combine all parts for multi-part drives so the full route is shown.
  const parts     = await getDriveGroup(drive);
  const allCoords = parts.flatMap(p => p.coordinates || []);
  const coords    = allCoords.map(c => [c.lat, c.lng]);
  const title   = `${drive.vehicle || 'Drive'} — ${new Date(drive.startedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  const stats   = `${(drive.distanceMiles || 0).toFixed(2)} mi &nbsp;·&nbsp; ${formatDuration(drive.durationSeconds || 0)}`;

  // Build arrows data: one every 8 coords
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
    html, body { margin: 0; padding: 0; height: 100%; background: #f8fafc; font-family: system-ui, sans-serif; }
    #map { position: absolute; inset: 0; }
    #info {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
      background: rgba(15,23,42,0.92); color: #f1f5f9;
      padding: 10px 20px; border-radius: 10px; z-index: 1000;
      display: flex; align-items: center; gap: 16px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3); backdrop-filter: blur(8px);
      white-space: nowrap;
    }
    #info strong { color: #f97316; font-size: 14px; }
    #info span   { font-size: 13px; color: #94a3b8; }
    .route-arrow { display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>
  <div id="info">
    <strong>${drive.vehicle || 'Drive'}</strong>
    <span>${new Date(drive.startedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
    <span>${stats}</span>
  </div>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const coords    = ${JSON.stringify(coords)};
    const arrowData = ${JSON.stringify(arrowData)};

    const map = L.map('map', { zoomControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OSM &copy; CARTO', subdomains: 'abcd', maxZoom: 19
    }).addTo(map);

    if (coords.length > 1) {
      const poly = L.polyline(coords, { color: '#f97316', weight: 4, opacity: 0.9 }).addTo(map);

      // Direction arrows
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

      // Start marker (green)
      L.circleMarker(coords[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#22c55e', fillOpacity: 1 })
       .bindTooltip('Start', { permanent: false }).addTo(map);

      // End marker (red)
      L.circleMarker(coords[coords.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#ef4444', fillOpacity: 1 })
       .bindTooltip('End', { permanent: false }).addTo(map);

      map.fitBounds(poly.getBounds(), { padding: [60, 60] });
    } else {
      map.setView([37.7749, -122.4194], 13);
    }
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
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
    historyList.innerHTML = `<p class="empty-history">Could not load history: ${err.message}</p>`;
    return;
  }
  if (!drives.length) {
    historyList.innerHTML = '<p class="empty-history">No drives recorded yet. Hit Start Drive!</p>';
    return;
  }

  // Build a name → photo map for O(1) lookup per drive.
  const vehiclePhotoMap = new Map(vehicles.map(v => [v.name, v.photo || null]));

  historyList.innerHTML = '';
  drives.forEach(drive => {
    const date      = new Date(drive.startedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const time      = new Date(drive.startedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const partLabel = drive.totalParts ? ` — Part ${drive.partNumber} of ${drive.totalParts}` : '';
    const baseName  = `${(drive.vehicle || 'Drive').replace(/\s+/g, '_')}_${new Date(drive.startedAt).toISOString().slice(0,10)}`;
    const photo    = vehiclePhotoMap.get(drive.vehicle);
    const thumbHTML = photo
      ? `<img src="${photo}" class="history-vehicle-thumb" alt="${drive.vehicle}" />`
      : `<div class="history-vehicle-thumb history-vehicle-thumb-default">${DEFAULT_CAR_SVG}</div>`;

    const item     = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-item-body">
        ${thumbHTML}
        <div class="history-item-content">
          <div class="history-item-header">
            <span class="history-item-title">${drive.vehicle || 'Unknown Vehicle'}${partLabel}</span>
            <span class="history-item-date">${date} ${time}</span>
          </div>
          <div class="history-item-stats">
            <div class="history-stat"><span class="history-stat-label">Distance</span><span class="history-stat-value">${drive.distanceMiles.toFixed(2)} mi</span></div>
            <div class="history-stat"><span class="history-stat-label">Duration</span><span class="history-stat-value">${formatDuration(drive.durationSeconds)}</span></div>
            <div class="history-stat"><span class="history-stat-label">Points</span><span class="history-stat-value">${drive.coordinates.length}</span></div>
          </div>
          <div class="history-item-actions">
            <button class="export-btn map-view-btn" data-id="${drive.id}" data-format="map">🗺 Map</button>
            <button class="export-btn" data-id="${drive.id}" data-format="gpx">↓ GPX</button>
            <button class="export-btn" data-id="${drive.id}" data-format="kml">↓ KML</button>
            <button class="export-btn delete-btn" data-id="${drive.id}" data-format="delete" style="margin-left:auto">🗑 Delete</button>
          </div>
        </div>
      </div>`;
    item.querySelectorAll('.export-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const format = btn.dataset.format;
        const id     = Number(btn.dataset.id);
        if (format === 'delete') {
          const label = drive.totalParts
            ? `Delete all ${drive.totalParts} parts of this drive?`
            : 'Delete this drive permanently?';
          if (!confirm(label)) return;
          // Delete all parts of a multi-part drive together.
          const parts = await getDriveGroup(drive);
          for (const part of parts) await deleteDrive(part.id);
          renderHistory();
          return;
        }
        if (format === 'map') { openDriveMap(drive); return; }
        // For GPX/KML combine all parts into one export file.
        const parts     = await getDriveGroup(drive);
        const combined  = { ...drive, coordinates: parts.flatMap(p => p.coordinates || []) };
        if (format === 'gpx') downloadFile(buildGPX(combined), `${baseName}.gpx`, 'application/gpx+xml');
        if (format === 'kml') downloadFile(buildKML(combined), `${baseName}.kml`, 'application/vnd.google-earth.kml+xml');
      });
    });
    historyList.appendChild(item);
  });
}

// History panel open / close helpers (called from hamburger menu).
function openHistory() {
  historyOverlay.classList.add('open');
  renderHistory();
}
document.getElementById('history-close').addEventListener('click', () => historyOverlay.classList.remove('open'));
historyOverlay.addEventListener('click', e => { if (e.target === historyOverlay) historyOverlay.classList.remove('open'); });
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
  setCTAState('start');
  previewLocation();
  handleDeepLink();
};
