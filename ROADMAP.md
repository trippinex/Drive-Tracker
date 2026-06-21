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
| v1.3.0 | "Copy for AI" drive export (DT-002), Pause and resume drive recording (DT-013) |
| v1.4.0 | Drive Score / Road DNA (DT-003) |
| v1.5.0 | Drive History panel hardening — XSS fixes, a11y, performance, mobile UX |
| v1.5.1 | Drive recovery after OS kill |
| v1.6.0 | Drive Replay / Animation (DT-008) |

---

---

## 📋 Backlog

| ID | Feature | Notes |
|---|---|---|
| DT-004 | Track Day Mode | Lap timer, auto-detected start/finish line, sector colouring on map |
| DT-005 | Speed-adaptive RDP epsilon | Apply tighter RDP on city sections, looser on highways for optimal point reduction |
| DT-006 | Drive Comparison | Overlay two drives on the same map and speed graph — "was I faster Tuesday or Sunday?" |
| DT-007 | Achievement System | Unlockable milestones: First 1,000 miles, Elevation Seeker, Night Owl, etc. |
| DT-010 | OBD-II Bluetooth integration | Pair with ELM327 dongle for real engine telemetry (RPM, boost, coolant temp) |
| DT-011 | Group Drive / Convoy Mode | Multiple DriveTracker users share a real-time map during a group drive |
| DT-012 | Drive History pagination & search | History panel currently loads all drives at once — add pagination, virtual scrolling, and date/vehicle filtering to keep the UI performant as the drive count grows into the hundreds |
| DT-014 | Claude AI Drive Analysis | Analyze button on Drive History entries; sends drive data to Claude via GCP Cloud Function proxy (Firebase JWT auth, Secret Manager for API key); displays car-enthusiast-style analysis dialog. Medium scope. |
| DT-015 | Shared Garage (FuelTracker integration) | Single Firestore-backed vehicle garage at `users/{uid}/vehicles/{id}` shared between DriveTracker and FuelTracker via onSnapshot. Requires vehicle schema alignment and SQLite→Firestore migration for FuelTracker. Medium-High scope. |
| DT-016 | Cost Per Drive (FuelTracker integration) | Display estimated fuel cost on Drive History cards using FuelTracker's rolling MPG and last fuel price (`distance ÷ MPG × $/gal`). Depends on DT-015. Low-Medium scope. |
| DT-017 | Drive Share | Generate a shareable link for any drive that opens the full map view and replay for anyone — no login required. Recipient sees the route, Drive DNA scores, and can use all replay controls (play/pause/stop/seek/speed). Link contains or references the drive's coordinate data. Medium scope. |

---

## 💡 Ideas (Not Yet Prioritised)

- Lap timer mode for track days
- Fuel cost estimator per drive (with MPG from FuelTracker integration)
- Weather overlay on drive map (conditions at time of recording)
- Drive sharing (generate a shareable link to a drive map)
- Leaderboard / personal records (longest drive, fastest section, etc.)
