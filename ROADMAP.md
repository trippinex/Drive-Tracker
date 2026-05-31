# DriveTracker — Feature Roadmap

This document tracks shipped work, active branches, and planned features.
Update this file when a feature moves from one stage to the next.

---

## ✅ Shipped

| Version | Feature |
|---|---|
| v1.0.0 | Initial release — GPS tracking, Leaflet map, vehicle garage, Firestore sync, Firebase Auth |
| v1.1.0 | GPS recording improvements — speed-adaptive threshold, 2s time gate, RDP simplification |
| v1.2.0 | About modal, Settings → Garage rename, garage icon |
| v1.2.1 | Long-drive stability — iterative RDP, GPS gap detection, wake lock heartbeat, arrow cap, rolling flush, secret management |

---

## 🚀 Next Up — v1.3.0

> ⚠️ **Reminder: Promote `fix/long-drive-stability` to GitHub BEFORE starting v1.3.0 work.**

### Feature 1: Claude AI Drive Analysis
**Priority:** High

An 🤖 **Analyze** button on each Drive History entry that sends the drive data to
Claude (via a secure GCP Cloud Function proxy) and displays a car-enthusiast-style
analysis in a dialog — commenting on route character, driving style, vehicle usage,
elevation, speed patterns, and anything interesting about the session.

**Architecture:**
```
PWA → Cloud Function (validates Firebase JWT)
          → GCP Secret Manager (Anthropic API key)
          → Claude API
          → Analysis dialog in PWA
```

**Key decisions to make before implementing:**
- Claude model: Haiku (fast/cheap) vs Sonnet (richer analysis)?
- Cache analysis per drive in Firestore (avoid re-calling on every open)?
- Desktop-only or mobile too?
- Drive data sent: summary stats + ~100 sampled coordinates (not full array)

**Estimated scope:** Medium
- Cloud Function (~50 lines Node.js)
- GCP Secret Manager setup
- PWA: Analyze button, loading state, analysis dialog

---

### Feature 2: Shared Garage (FuelTracker Integration)
**Priority:** High

A single shared vehicle Garage backed by Firestore, visible in both DriveTracker
and FuelTracker. Adding, editing, or deleting a vehicle in either app is instantly
reflected in the other. Eliminates the duplicate vehicle list problem.

**Architecture:**
- Vehicles stored in Firestore at `users/{uid}/vehicles/{id}` (already exists in DriveTracker)
- FuelTracker reads/writes to the same Firestore path via a shared SDK
- Both apps listen via `onSnapshot` — changes are real-time across both

**Key decisions to make before implementing:**
- Vehicle schema alignment — DriveTracker has (name, make, model, year, notes, photo);
  FuelTracker adds (fuel_capacity_gallons, vin, license_plate). Merge or extend?
- Migration plan for existing FuelTracker vehicles (SQLite → Firestore)
- Photo storage — DriveTracker stores base64 in Firestore; may need Firebase Storage for FuelTracker-style photos

**Estimated scope:** Medium-High
- Firestore vehicle schema consolidation
- FuelTracker migration from SQLite to Firestore vehicles
- Real-time sync listener in both apps

---

### Feature 3: Cost Per Drive (FuelTracker Integration)
**Priority:** High

After every drive, automatically calculate and display the estimated fuel cost on
the Drive History card using data from FuelTracker (last known fuel price and
rolling MPG).

```
Fuel cost = distance ÷ rolling_MPG × last_fuel_price_per_gallon

Example: 11.09 mi ÷ 32.4 MPG × $3.29/gal = $1.13
```

**What's needed from FuelTracker:**
- Most recent fuel price per gallon (from last fill-up for that vehicle)
- Rolling MPG (average over last 3–5 fill-ups for that vehicle)

**Display:**
- Drive History card shows: `⛽ $1.13` alongside distance and duration
- Tapping it shows a breakdown tooltip: `11.09 mi ÷ 32.4 MPG × $3.29/gal`
- Drives recorded before FuelTracker data is available show `⛽ --`

**Estimated scope:** Low-Medium
- Depends on Shared Garage being complete (vehicle linkage)
- Read latest fill-up data from Firestore (FuelTracker's data)
- Compute and display on History cards

---

## 📋 Backlog

| ID | Feature | Notes |
|---|---|---|
| DT-001 | GCS file-based coordinate storage | Replace Firestore inline coordinates to remove 1MB limit entirely for very long drives |
| DT-002 | "Copy for AI" drive export | Copy a compact JSON summary + sampled route to clipboard for pasting into any AI chat |
| DT-003 | Drive Score / Road DNA | Score each drive on curve density, elevation delta, and speed variance — car enthusiasts chase high scores |
| DT-004 | Track Day Mode | Lap timer, auto-detected start/finish line, sector colouring on map |
| DT-005 | Speed-adaptive RDP epsilon | Apply tighter RDP on city sections, looser on highways for optimal point reduction |
| DT-006 | Drive Comparison | Overlay two drives on the same map and speed graph — "was I faster Tuesday or Sunday?" |
| DT-007 | Achievement System | Unlockable milestones: First 1,000 miles, Elevation Seeker, Night Owl, etc. |
| DT-008 | Drive replay / animation | Replay the drive on the map with the car marker moving along the recorded route |
| DT-009 | Strava / Garmin Connect export | Push completed drives to third-party fitness/activity platforms |
| DT-010 | OBD-II Bluetooth integration | Pair with ELM327 dongle for real engine telemetry (RPM, boost, coolant temp) |
| DT-011 | Group Drive / Convoy Mode | Multiple DriveTracker users share a real-time map during a group drive |
| DT-012 | Drive History pagination & search | History panel currently loads all drives at once — add pagination, virtual scrolling, and date/vehicle filtering to keep the UI performant as the drive count grows into the hundreds |
| DT-013 | Pause and resume drive recording | Allow the driver to pause an active recording session (e.g. fuel stop, rest area) and resume without starting a new drive. GPS tracking and the timer halt on pause; the route polyline and all telemetry resume seamlessly on resume. Paused time is excluded from drive duration. The Stop Drive button becomes a Pause / Stop split control during an active session. |

---

## 💡 Ideas (Not Yet Prioritised)

- Lap timer mode for track days
- Fuel cost estimator per drive (with MPG from FuelTracker integration)
- Weather overlay on drive map (conditions at time of recording)
- Drive sharing (generate a shareable link to a drive map)
- Leaderboard / personal records (longest drive, fastest section, etc.)
