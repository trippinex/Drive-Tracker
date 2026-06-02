# Changelog

All notable changes to DriveTracker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.0] - 2026-06-01

### Added

#### "Copy for AI" Drive Export (DT-002)
- New **⊕ AI** button on each Drive History card
- Copies a compact JSON payload to the clipboard — drive metadata plus ~100 evenly-sampled GPS coordinates — ready to paste into any AI chat for analysis

#### Pause and Resume Drive Recording (DT-013)
- During an active drive, the **Stop Drive** button is replaced by a **Pause | Stop** split control
- **Pause** (amber) halts GPS recording and releases the screen wake lock; the timer freezes
- **Resume** (blue) reacquires the wake lock and continues recording seamlessly
- Paused time is excluded from the final drive duration

---

## [1.2.1] - 2026-05-31

### Fixed

#### Long-Drive Stability
- **Iterative RDP** — converted Ramer-Douglas-Peucker simplification from recursive to iterative, eliminating JavaScript stack overflow on drives producing 8,000+ raw GPS points (8-hour drives)
- **GPS gap detection** — warns in the status bar if GPS updates stop for ≥ 60 seconds mid-drive (e.g. iOS background suspension); counts and reports total gaps per session
- **Wake lock heartbeat** — re-acquires screen wake lock every 5 minutes during active recording; warns immediately in status bar when the lock drops mid-drive
- **Leaflet arrow marker cap** — limits direction chevrons to 200 live DOM elements (removes oldest when cap is hit); prevents progressive map lag on drives 1+ hours long
- **Rolling in-drive chunk flush** — when the coordinate buffer reaches 5,000 points mid-drive, flushes to IndexedDB and clears memory rather than holding the full array until stop; makes 8-hour drives memory-safe on mobile
- **Secret management** — moved Firebase API key, auth domain, and allowed email out of source code into GCP Secret Manager; runtime config injected via `config.js` (never committed)

#### Validated
Validated against three recorded drives showing 94.8% reduction in stored GPS points per mile compared to the original time-based recording system, with no loss of route quality.

---

## [1.2.0] - 2026-05-30

### Added

#### About Modal
- New **About** entry in the hamburger menu (ℹ️)
- Floating modal displaying the app icon, DriveTracker title, brief description, current version, and a **View Changelog** link to GitHub
- Version number sourced from `APP_VERSION` constant in `app.js` — single place to update per release
- Dismisses via ✕ button or tapping outside the modal

### Changed

#### Garage (formerly Settings)
- **Settings** renamed to **Garage** throughout the UI — menu label, panel title, status messages, and empty-state text
- Hamburger menu Garage item now displays a branded orange garage SVG icon (peaked roof + door panels) replacing the generic gear icon
- Garage panel header shows the same orange garage icon to the left of the title for visual consistency

---

## [1.1.0] - 2026-05-30

### Added

#### GPS Recording Improvements
- **Speed-adaptive distance threshold** — replaces the fixed 15m threshold with a speed-scaled table matching Google Maps' capture strategy:
  - ≤ 10 mph → 8m (slow/stopped, preserves manoeuvring detail)
  - ≤ 35 mph → 15m (suburban)
  - ≤ 60 mph → 25m (arterial/mixed roads)
  - \> 60 mph → 40m (highway — ~1 point per 1.5 sec at 65 mph)
- **Minimum 2-second time gate** — both distance AND time must be satisfied to record a point; prevents GPS jitter bursts at stops
- **Ramer-Douglas-Peucker simplification at save time** — removes collinear points within 10m of straight-line segments before storage; turns and curves fully preserved; typical 20–40% reduction on highway sections

---

## [1.0.0] - 2026-05-30

### Initial Release

#### Core PWA
- Progressive Web App with offline-first architecture
- Service Worker with cache-first strategy for shell assets and stale-while-revalidate for map tiles
- Installable on iOS and Android home screens
- Full offline GPS recording capability

#### Authentication
- Google Sign-In via Firebase Authentication
- Single-user access restriction by email address
- Persistent session across reloads

#### Map & Tracking
- Leaflet.js map with CartoCDN Positron light tiles
- Real-time GPS tracking using `navigator.geolocation.watchPosition` with `enableHighAccuracy: true`
- **15-metre distance threshold** for GPS point capture (matches Google Maps strategy)
- Pulsating blue dot for current position when not recording
- Orange polyline route trail with directional chevron arrows during recording
- Animated 🚗 car marker following current position during recording
- Haversine formula for distance calculation

#### Telemetry Dashboard
- Live Speed (MPH), Distance (miles), Duration (HH:MM:SS), Altitude (feet)
- Screen Wake Lock API to prevent screen dimming during drives
- Wake lock auto re-acquired on app visibility change

#### Vehicle Management
- Add, edit, and delete vehicles with name, make, model, year, notes, and photo
- Vehicle photos stored as compressed JPEG/PNG base64 in IndexedDB
- Photos with transparent backgrounds preserved (PNG format)
- Vehicle photo displayed above Speed card during active drive
- Vehicle photo and default SVG shown in Settings and History panels
- Real-time vehicle sync across devices via Firestore `onSnapshot`

#### Drive History
- Full drive history with vehicle thumbnail, stats, and export options
- GPX and KML export combining all parts of multi-part drives
- 🗺 Map button (desktop only) opens full-screen route map in new tab
  - Shows complete route with directional arrows, start/end markers, and drive stats
- Delete drive removes all parts and syncs deletion to Firestore

#### Drive Chunking (no data loss)
- Drives exceeding 5,000 GPS points automatically split into numbered parts
- Each part labeled "Vehicle — Part X of Y" in History
- GPX/KML export and Map view combine all parts seamlessly
- Deleting any part removes the entire drive group

#### Cloud Sync (Firestore)
- Bidirectional sync between IndexedDB (local) and Firestore (cloud)
- Firestore is authoritative for Drive History on sign-in
- Drive History: wipe-and-repopulate from Firestore on every sync (strict 1:1 mirror)
- Vehicles: real-time `onSnapshot` listener for instant cross-device updates
- Manual sync via Menu → Sync with animated 🔄 icon
- Offline-recorded drives (no `firestoreId`) pushed to Firestore on next sync
- Duplicate drive prevention using `startedAt + vehicle` fingerprint check

#### Data Storage
- IndexedDB (local, offline-first): drives and vehicles with `userId` scoping
- Firestore (cloud): drive metadata + coordinates, vehicle records
- GPS coordinates stored in Firestore per drive (up to 5,000 points per part)
- All data associated with authenticated user's Firebase UID
- Data preservation policy: DB migrations never delete user data

#### UI / UX
- Slate + Orange design system (FuelTracker ui-theme)
- iOS safe-area-inset support for notched iPhones
- Hamburger ☰ menu with History, 🔄 Sync, ⚙️ Settings, and Sign Out
- Settings bottom sheet with vehicle list and add/edit form
- Drive History bottom sheet with vehicle thumbnails
- App icon (DriveTracker branded) in header, login screen, settings footer
- PWA icons (16, 32, 180, 192, 512px) with transparent background
- Branded favicon and Apple Touch Icon

#### Deployment
- Hosted on Google Cloud Storage behind a Cloud Load Balancer
- HTTPS via Google-managed SSL certificate on a custom domain
- Cloud CDN with per-file cache-control strategy
- Versioned asset URLs (`?v=N`) for deterministic browser cache busting
- `index.html`, `auth.js`, `sync.js` served `no-cache` for immediate update delivery
- `sw.js` served `no-cache, no-store` for instant service worker updates

---

## Unreleased

### Planned
- GCS file-based coordinate storage (replacing Firestore inline coordinates)
- "Copy for AI" drive export button
