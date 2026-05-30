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

---

## 🔄 In Progress — Awaiting Validation

### v1.2.1 (beta) — Long-Drive Stability
**Branch:** `fix/long-drive-stability` (local only — not yet on GitHub)
**Status:** Deployed to GCP. Needs a real 3-hour+ drive to validate before promoting.

> ⚠️ **Reminder: Promote `fix/long-drive-stability` to GitHub BEFORE starting the AI Drive Analysis feature.**

Fixes included:
- Iterative RDP (eliminates stack overflow on 8-hr drives)
- GPS gap detection (60s threshold, status bar warning)
- Wake lock 5-min heartbeat + warning on drop
- Arrow marker cap (200 max, trailing effect)
- Rolling in-drive chunk flush (memory safe for 8-hr drives)
- Beta designation in About modal

---

## 🚀 Next Up — AI Drive Analysis

### Feature: Claude AI Drive Analysis
**Priority:** High
**Depends on:** v1.2.1 promoted to GitHub

**Description:**
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

## 📋 Backlog

| Feature | Notes |
|---|---|
| GCS file-based coordinate storage | Replace Firestore inline coordinates to remove 1MB limit entirely for very long drives |
| "Copy for AI" drive export | Copy a compact JSON summary + sampled route to clipboard for pasting into any AI chat |
| Speed-adaptive RDP epsilon | Apply tighter RDP on city sections, looser on highways for optimal point reduction |
| Drive replay / animation | Replay the drive on the map with the car marker moving along the recorded route |
| Strava / Garmin Connect export | Push completed drives to third-party fitness/activity platforms |

---

## 💡 Ideas (Not Yet Prioritised)

- Lap timer mode for track days
- Fuel cost estimator per drive (with MPG from FuelTracker integration)
- Weather overlay on drive map (conditions at time of recording)
- Drive sharing (generate a shareable link to a drive map)
- Leaderboard / personal records (longest drive, fastest section, etc.)
