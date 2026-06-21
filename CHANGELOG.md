# Changelog

All notable changes to DriveTracker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.7.6] - 2026-06-21

### Added

- **Voice picker** — new "🔊 Voice" item in the hamburger menu (all browsers, all devices). Opens a modal with a dropdown of all voices available on the current device, a customisable preview phrase (defaulting to "Approaching Red Rock Canyon"), and a Preview button to audition any voice before committing. Selection is saved to `localStorage` so each device remembers its own preference independently. Works on iOS Safari, Chrome, and any other browser with Web Speech API support.

---

## [1.7.5] - 2026-06-21

### Fixed

- **Safari voice selection ignoring system preference** — on iOS/macOS Safari, the app was overriding the browser's default TTS voice with a hardcoded "Samantha" preference, ignoring whatever voice the user configured in iOS Settings. Now only Chrome/Android overrides the voice (to prefer `Google US English`); Safari lets the system default win so user-selected voices like Ava Enhanced work as expected.

---

## [1.7.4] - 2026-06-21

### Fixed

- **Voice quality on Safari** — improved voice selection to prefer iOS/macOS "Samantha" (or any downloaded Enhanced voice) over the generic `en-US` fallback. Also fixed a precedence bug in the previous selection logic (`!v.localService === false` was ambiguous). Chrome/Android still prefers `Google US English`; Safari users now get a noticeably more natural voice.

---

## [1.7.3] - 2026-06-21

### Fixed

- **About modal showing wrong version** — `APP_VERSION` was not bumped through the v1.7.1 and v1.7.2 patch releases. Updated to `1.7.2` (current release).

---

## [1.7.2] - 2026-06-21

### Fixed

- **POI markers missing on mobile browsers** (BUG-003) — Main-map POI markers used a CSS class (`poi-marker`) that can silently fail to apply on mobile if the stylesheet hasn't been processed at render time. Switched to inline styles, consistent with the replay blob markers which already used this approach.

---

## [1.7.1] - 2026-06-21

### Fixed

- **POI voice announcements silent on mobile** (BUG-002) — Mobile browsers (iOS Safari, Chrome) block `speechSynthesis.speak()` unless called from a user gesture. Added a one-time `touchstart`/`click` listener that fires a silent zero-volume utterance to unlock the speech engine for the session. Applied to both live recording and drive replay.

---

## [1.7.0] - 2026-06-21

### Added

#### Points of Interest (DT-018 Phase 1)

- **POI management panel** — Hamburger menu → Points of Interest opens a right-side slide-in panel (desktop only; hidden on mobile via CSS media query). Create, edit, and delete POIs with a name, optional friendly name, category, address, and notes.
- **8 categories** — Fuel Stop, Track / Circuit, Viewpoint / Scenic, Restaurant / Café, Parking, Home / Base, Garage / Storage, Other — each with a distinct icon and color.
- **Address lookup** — Nominatim (OpenStreetMap) forward geocoding with a results dropdown; also supports map-click-to-place with automatic reverse geocoding.
- **Map markers** — POI pins appear on all map views: main map, drive detail, and drive replay. Optional radius circle toggle in POI settings.
- **Voice announcements** — Web Speech API announces "Approaching [name]" on entry into the approach radius (default 300 m) during live recording and drive replay. Uses entry-detection (outside→inside boundary crossing) so announcements fire once per visit rather than on a timer. Prefers Google US English voice when available.
- **Replay checkbox** — Drive replay includes a 📍 POIs toggle to enable/disable announcements per session.
- **Configurable radius** — Global approach radius setting (metres) persisted in Firestore alongside a show/hide radius circle toggle.
- **Cloud storage** — POIs stored in Firestore at `users/{uid}/pois/{id}`; real-time `onSnapshot` listener keeps the in-memory cache current across devices.

---

## [1.6.1] - 2026-06-21

### Fixed

#### Mobile / PWA map view fixes

- **Bottom pills overlapping** — Replaced independently-positioned `#replay-controls` and `#dna` pills with a `#bottom-pills` flex column container; the DNA pill wraps to two rows on narrow phones making a fixed `bottom: 80px` offset insufficient. The container now stacks pills with a consistent 8px gap regardless of pill height.
- **Map button did nothing in Safari** — Two root causes fixed: (1) Safari rejects `window.open()` called after any `await` in an async function (user gesture consumed) — fixed by opening a blank window synchronously before any async work then navigating it to the blob URL; (2) `window.open()` is silently blocked in iOS PWA standalone mode — fixed by detecting `navigator.standalone` and using `window.location.href` instead.
- **Zoom control overlapping top pills** — Leaflet's default `topleft` zoom control collided with the info pill on mobile. Removed on touch devices (pinch-to-zoom is the native gesture); moved to `bottomright` on desktop.
- **Top pills inconsistent spacing** — Wrapped `#info` and `#replay-hud` in a `#top-pills` flex column container mirroring `#bottom-pills`, giving both pairs an identical 8px gap driven by actual rendered heights.

#### Deploy pipeline fixes

- **CDN invalidation failing on deploy** — `deploy.sh` was targeting the wrong GCP project (`hermes-498713` instead of `drive-tracker-497900`). Added `--project drive-tracker-497900`; deploys now flush the CDN instantly.
- **Versioned asset CDN TTL** — Reduced `max-age` on `app.js`, `styles.css`, and `theme.css` from 1 hour to 5 minutes as a fallback for when CDN invalidation is unavailable.

---

## [1.6.0] - 2026-06-21

### Added

#### Drive Replay / Animation (DT-008)

Tap the 🗺 Map button on any Drive History card to open the full-screen route map. Four glass pills overlay the map:

- **Drive info** (top) — vehicle name, date, distance, and duration; unchanged from before
- **Replay HUD** (below info) — shows the recorded wall-clock time and GPS speed at the chevron's current position; updates live during playback
- **Playback controls** (above DNA pill) — Play/Pause toggle, Stop, −10 min, +10 min, and speed selector
- **Drive DNA** (bottom) — existing Curve / Elevation / Speed / Overall grades; unchanged

**Playback controls:**
- **Play/Pause** — single button that toggles between ▶ and ⏸; hitting Play zooms the map to a ~5-mile radius around the car's current position
- **Stop** — resets the marker to the route start and restores the full-route map view
- **−10 min / +10 min** — seeks 10 minutes of recorded drive time backward or forward; clamps at the ends
- **Speed** — cycles 1× → 2× → 4× → 8× → 16× → 32× → 1× on each tap; label turns orange above 1×

**Replay marker:**
- If the active vehicle has a photo, the photo is used as the replay marker (full image, `object-fit: contain`, rounded corners)
- Falls back to a rotating orange chevron when no photo is on file

**Map behaviour:**
- On Play: map zooms to a ~5-mile radius around the marker
- During playback: an invisible 3-mile bounding box around the marker is checked every frame; the map repans to re-center before the marker reaches the viewport edge
- On Stop: map restores the full-route view

---

## [1.5.1] - 2026-06-20

### Fixed

- **Drive recovery after OS kill** — pausing a drive and switching to another app could cause the OS to evict the browser tab, losing all recorded data. The app now saves a draft to IndexedDB on pause, on page hide, and every 30 seconds during active recording. On next launch, if a draft with sufficient data is found, a modal offers to resume the interrupted drive or discard it.

---

## [1.5.0] - 2026-06-06

### Fixed

#### Security
- **XSS hardening** — all user-supplied strings (vehicle name, error messages, photo URLs) are now HTML-escaped before injection into `innerHTML`; previously a crafted vehicle name could break out of attributes or inject markup

#### Accessibility
- **Focus trap** — keyboard focus is now constrained within the Drive History panel while it is open; Tab / Shift+Tab cycle only through panel controls
- **Escape to close** — pressing Escape closes the panel (consistent with every other overlay in the app)
- **Focus restoration** — focus returns to the element that opened the panel (hamburger menu → History button) when the panel closes
- **`role="listitem"`** added to each drive card, correctly pairing with the existing `role="list"` on the history container
- **Accessible button labels** — all five action buttons (Map, GPX, KML, AI, Delete) now carry descriptive `aria-label` values that include the vehicle name and date (e.g. "Export GPX for Toyota Camry, Mon Jun 3")
- **`inert` on background** — the app header and main content area are marked `inert` while the panel is open, preventing assistive technologies from navigating to background content

#### Performance
- **Dirty-flag caching** — `renderHistory()` is only called when data has actually changed (after a delete or after saving a new drive); reopening an unchanged panel is now instant
- **IntersectionObserver pagination** — only the first 20 drives are rendered to the DOM on open; a sentinel element at the bottom of the list triggers the next 20 as the user scrolls, keeping DOM size bounded regardless of how many drives accumulate
- **Eliminated per-action IDB re-reads** — export (GPX / KML / AI) and delete button handlers now use the in-memory drives array captured at render time instead of issuing a new `getAllDrives()` IndexedDB read per click
- **Batched score backfill** — pre-v1.4.0 drives requiring a lazy score backfill are now computed and written to IndexedDB in a single `Promise.all` before the DOM is touched, eliminating concurrent fire-and-forget writes

#### Mobile / UX
- **Dynamic viewport height** — history panel `max-height` now uses `75dvh` (with `75vh` fallback) so the panel respects the mobile browser chrome on iOS Safari and Android Chrome
- **Inline delete confirmation** — the Delete button now replaces the action row in-place with "Delete permanently? [Yes, delete] [Cancel]" instead of using `window.confirm()`, which is unreliable in standalone PWA mode on Android
- **Map button on all screen sizes** — the 🗺 Map button is now visible on mobile (was desktop-only); all five action buttons wrap cleanly on narrow screens

---

## [1.4.0] - 2026-06-04

### Added

#### Drive Score / Road DNA (DT-003)
Every drive is automatically scored on three dimensions and assigned a letter grade **S / A / B / C / D** using fixed real-world benchmarks — scores never shift as your library grows.

**Curve Density** — measures how twisty the road was (total bearing-change degrees per mile, GPS jitter < 5° filtered out):

| Grade | °/mile | What it feels like |
|---|---|---|
| S | > 3,200 | Tail of the Dragon, mountain hairpins |
| A | 2,000 – 3,200 | Canyon roads, serious mountain passes |
| B | 1,200 – 2,000 | Fun back roads, rolling hills |
| C | 500 – 1,200 | Suburban streets, gentle curves |
| D | < 500 | Highways, straight country roads |

**Elevation Delta** — measures how hilly the route was (cumulative elevation gain in ft/mile). Suppressed (`--`) when more than half of GPS points lack altitude data:

| Grade | ft/mile | What it feels like |
|---|---|---|
| S | > 400 | Serious mountain driving |
| A | 150 – 400 | Mountain roads |
| B | 50 – 150 | Rolling hills |
| C | 10 – 50 | Gently rolling terrain |
| D | < 10 | Flat as a pancake |

**Speed Variance** — measures how dynamic the driving was (standard deviation of GPS speeds in mph). Rewards acceleration and braking over a monotone cruise:

| Grade | Std dev (mph) | What it feels like |
|---|---|---|
| S | > 30 | Very dynamic — hard acceleration, trail braking |
| A | 20 – 30 | Spirited driving |
| B | 12 – 20 | Active, engaged driving |
| C | 5 – 12 | Normal varied driving |
| D | < 5 | Cruise control on the interstate |

**Composite grade** — weighted average of all three dimensions (Curve 40%, Elevation 35%, Speed 25%). Weight redistributes proportionally if Elevation or Speed data is unavailable.

- **Colored grade badge** replaces the Points stat in Drive History cards — gold (S), green (A), blue (B), yellow (C), red (D)
- **Post-drive summary modal** — shown immediately after stopping a drive; displays the composite grade plus all three sub-scores
- **Drive DNA panel** — fixed pill at the bottom of the full-screen map tab showing Curve / Elevation / Speed / Overall sub-grades
- Drives shorter than 1 mile are not scored (`--`)
- Pre-v1.4.0 drives are **backfilled lazily** on first history open — score computed from stored coordinates and written back to IndexedDB + Firestore silently

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

