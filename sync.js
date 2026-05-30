/**
 * DriveTracker — sync.js
 *
 * Bidirectional sync between IndexedDB (local / offline-first) and
 * Firestore (cloud mirror for cross-device access and backup).
 *
 * Architecture:
 *  - IndexedDB is always the primary store for reads/writes (offline-first).
 *  - Every write also fires to Firestore asynchronously (fire-and-forget).
 *  - Each record carries a `firestoreId` field that links its local IndexedDB
 *    entry to its Firestore document so records can be matched across devices.
 *  - On sign-in: pull any cloud records missing locally; push any local records
 *    missing from the cloud. Last-write-wins for vehicles (they're editable).
 *    Drives are append-only — never modified after save, only deleted.
 *
 * Firestore structure:
 *   users/{uid}/vehicles/{firestoreId}   — vehicle records
 *   users/{uid}/drives/{firestoreId}     — drive records
 *
 * Load order requirement: app.js must load before sync.js so the raw
 * DB helper functions (getAllVehiclesRaw, addVehicleRaw, etc.) are available.
 */

'use strict';

const MAX_SYNC_COORDS = 2000;  // cap on GPS coordinates stored per drive in Firestore
                               // (prevents hitting the 1 MB document size limit on
                               // very long drives; full resolution stays in IndexedDB)

let _db      = null;
let _uid     = null;
let _enabled = false;

// ── Initialise (called from auth.js after sign-in is verified) ────────────────
window.initSync = function initSync(uid) {
  try {
    _db      = firebase.firestore();
    _uid     = uid;
    _enabled = true;
    console.log('[Sync] Firestore ready for uid:', uid);
  } catch (err) {
    console.warn('[Sync] Firestore unavailable — sync disabled:', err.message);
    _enabled = false;
  }
};

// ── Firestore collection refs ─────────────────────────────────────────────────
const vehiclesCol = () => _db.collection('users').doc(_uid).collection('vehicles');
const drivesCol   = () => _db.collection('users').doc(_uid).collection('drives');

// ── GPS coordinate downsampling ───────────────────────────────────────────────
function sampleCoords(coords, max) {
  if (!Array.isArray(coords) || coords.length <= max) return coords || [];
  const step = Math.ceil(coords.length / max);
  return coords.filter((_, i) => i % step === 0);
}

// ═══════════════════════════════════════════════════════════════
// Vehicle cloud operations
// ═══════════════════════════════════════════════════════════════

/** Push a new vehicle to Firestore. Returns the Firestore doc ID, or null on failure. */
window.syncVehicleAdd = async function syncVehicleAdd(vehicle) {
  if (!_enabled) return null;
  try {
    const { id, firestoreId, ...data } = vehicle;
    const ref = await vehiclesCol().add({ ...data, updatedAt: Date.now() });
    return ref.id;
  } catch (err) {
    console.warn('[Sync] vehicleAdd failed:', err.message);
    return null;
  }
};

/** Overwrite an existing vehicle document in Firestore. */
window.syncVehicleUpdate = async function syncVehicleUpdate(firestoreId, vehicle) {
  if (!_enabled || !firestoreId) return;
  try {
    const { id, firestoreId: _fid, ...data } = vehicle;
    await vehiclesCol().doc(firestoreId).set({ ...data, updatedAt: Date.now() });
  } catch (err) {
    console.warn('[Sync] vehicleUpdate failed:', err.message);
  }
};

/** Delete a vehicle document from Firestore. */
window.syncVehicleDelete = async function syncVehicleDelete(firestoreId) {
  if (!_enabled || !firestoreId) return;
  try {
    await vehiclesCol().doc(firestoreId).delete();
  } catch (err) {
    console.warn('[Sync] vehicleDelete failed:', err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// Drive cloud operations
// ═══════════════════════════════════════════════════════════════

/** Push a new drive to Firestore (coordinates downsampled). Returns Firestore doc ID. */
window.syncDriveAdd = async function syncDriveAdd(drive) {
  if (!_enabled) return null;
  try {
    const { id, firestoreId, ...data } = drive;
    const coords = sampleCoords(data.coordinates, MAX_SYNC_COORDS);
    const ref = await drivesCol().add({ ...data, coordinates: coords, syncedAt: Date.now() });
    return ref.id;
  } catch (err) {
    console.warn('[Sync] driveAdd failed:', err.message);
    return null;
  }
};

/** Delete a drive document from Firestore. */
window.syncDriveDelete = async function syncDriveDelete(firestoreId) {
  if (!_enabled || !firestoreId) return;
  try {
    await drivesCol().doc(firestoreId).delete();
  } catch (err) {
    console.warn('[Sync] driveDelete failed:', err.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// Full bidirectional sync — runs once on every sign-in
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Real-time listeners — push Firestore changes to this device
// ═══════════════════════════════════════════════════════════════

let _vehicleUnsub = null;
let _driveUnsub   = null;

/**
 * Start real-time Firestore listeners for vehicles and drives.
 * When another device adds/updates/deletes a record, this device's
 * IndexedDB and UI are updated automatically without requiring a reload.
 */
window.startRealtimeSync = function startRealtimeSync() {
  if (!_enabled) return;

  // ── Vehicles listener ──────────────────────────────────────────────────────
  _vehicleUnsub = vehiclesCol().onSnapshot(async snapshot => {
    for (const change of snapshot.docChanges()) {
      const { type, doc } = change;
      const fsId = doc.id;
      const data = { ...doc.data(), firestoreId: fsId, userId: _uid };

      if (type === 'added' || type === 'modified') {
        // Check if it already exists locally by firestoreId.
        const locals = await window.getAllVehiclesRaw();
        const existing = locals.find(v => v.firestoreId === fsId);
        if (!existing) {
          await window.addVehicleRaw(data);
        } else {
          // Update existing local record.
          await window.updateVehicleByLocalId(existing.id, data);
        }
        // Refresh the dropdown so the new/updated vehicle appears immediately.
        if (typeof populateVehicleDropdown === 'function') {
          populateVehicleDropdown();
        }
      } else if (type === 'removed') {
        const locals = await window.getAllVehiclesRaw();
        const existing = locals.find(v => v.firestoreId === fsId);
        if (existing) await window.deleteVehicleByLocalId(existing.id);
        if (typeof populateVehicleDropdown === 'function') {
          populateVehicleDropdown();
        }
      }
    }
  }, err => console.warn('[Sync] Vehicle listener error:', err.message));

  // Drives do NOT use a real-time listener.
  // Drives are always recorded locally first — a real-time listener would race
  // with syncOnSignIn and produce duplicates. Cross-device drive history is
  // handled by syncOnSignIn on sign-in and Menu → Sync on demand.
  _driveUnsub = null;

  console.log('[Sync] Real-time listeners active.');
};

/** Stop listeners (called on sign-out). */
window.stopRealtimeSync = function stopRealtimeSync() {
  _vehicleUnsub?.();
  _driveUnsub?.();
  _vehicleUnsub = null;
  _driveUnsub   = null;
};

window.syncOnSignIn = async function syncOnSignIn() {
  if (!_enabled) return;

  try {
    if (typeof setStatus === 'function') setStatus('Syncing with cloud…');

    // ── Vehicles ────────────────────────────────────────────────────────────
    const [cloudVehicleSnap, localVehicles] = await Promise.all([
      vehiclesCol().get(),
      window.getAllVehiclesRaw(),
    ]);

    // Map local vehicles by their Firestore ID for fast lookup.
    const localByFsId = new Map(
      localVehicles
        .filter(v => v.firestoreId)
        .map(v => [v.firestoreId, v])
    );

    // Pull cloud vehicles that are missing from local IndexedDB.
    for (const doc of cloudVehicleSnap.docs) {
      if (!localByFsId.has(doc.id)) {
        await window.addVehicleRaw({ ...doc.data(), firestoreId: doc.id, userId: _uid });
      }
    }

    // Push local vehicles that have never been synced to the cloud.
    for (const v of localVehicles) {
      if (!v.firestoreId) {
        const fsId = await window.syncVehicleAdd(v);
        if (fsId) await window.setVehicleFirestoreId(v.id, fsId);
      }
    }

    // ── Drives — strict 1:1 mirror of Firestore ─────────────────────────────
    // Correct order: fetch Firestore FIRST, then push only truly new offline
    // drives (not already in Firestore by startedAt+vehicle fingerprint),
    // then wipe local entirely and re-populate from Firestore.
    // This prevents duplicate local drives from being blindly pushed to
    // Firestore and re-downloaded, perpetuating the duplication.

    const [localDrives, initialSnap] = await Promise.all([
      window.getAllDrivesRaw(),
      drivesCol().get(),
    ]);

    // Build a fingerprint set of drives already in Firestore so we can
    // avoid pushing local duplicates that Firestore already has.
    const cloudFingerprints = new Set(
      initialSnap.docs.map(d => `${d.data().startedAt}|${d.data().vehicle}`)
    );

    // Step 1 — Push offline drives that are genuinely new (not in Firestore).
    let pushed = 0;
    for (const d of localDrives) {
      if (!d.firestoreId) {
        const fp = `${d.startedAt}|${d.vehicle}`;
        if (!cloudFingerprints.has(fp)) {
          await window.syncDriveAdd(d);
          cloudFingerprints.add(fp);
          pushed++;
        }
        // If fingerprint already exists in Firestore, this is a duplicate — skip.
      }
    }

    // Step 2 — Fetch authoritative Firestore list (includes newly pushed drives).
    const cloudDriveSnap = pushed > 0 ? await drivesCol().get() : initialSnap;

    // Step 3 — Delete every local drive.
    for (const d of localDrives) {
      await window.deleteDriveByLocalId(d.id);
    }

    // Step 4 — Re-populate from Firestore. Exactly 1 local record per Firestore doc.
    for (const doc of cloudDriveSnap.docs) {
      await window.addDriveRaw({ ...doc.data(), firestoreId: doc.id, userId: _uid });
    }

    console.log(`[Sync] Drives mirrored: ${cloudDriveSnap.size} record(s) from Firestore.`);

    console.log(
      `[Sync] ✓ ${cloudVehicleSnap.size} cloud vehicle(s), ` +
      `${cloudDriveSnap.size} cloud drive(s) synced.`
    );

    // Let GPS status resume after sync.
    if (typeof setStatus === 'function') {
      setStatus('GPS ready. Tap Start Drive to begin recording.');
    }

  } catch (err) {
    console.warn('[Sync] syncOnSignIn failed:', err.message);
  }
};
