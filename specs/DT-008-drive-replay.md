# DT-008 — Drive Replay / Animation

## Overview

Animate a recorded drive by moving a directional chevron along the full route at variable playback speed. Launched from the existing full-screen map tab (🗺 button on Drive History cards). No new screen — replay controls are layered onto the existing map page.

---

## Entry Point

The existing `openDriveMap()` function generates a self-contained Blob URL page. DT-008 adds replay capability to that same page.

**Change required in `openDriveMap()`:** pass full coordinate objects (currently strips to `[lat, lng]` only) so the Blob page has access to `speed` and `ts` per point.

---

## Layout

The existing page has two fixed overlays:

| Element | Position | Current content |
|---|---|---|
| `#info` pill | Top-center | Vehicle name · Date · Distance / Duration |
| `#dna` pill | Bottom-center | Curve / Elevation / Speed / Overall grades |

DT-008 adds two new elements:

| Element | Position | Content |
|---|---|---|
| `#replay-hud` | Top-center, below `#info` | Recorded time · Current speed (updates live) |
| `#replay-controls` | Bottom-center, above `#dna` | Playback controls (always visible) |

All four elements stack in z-order above the map. The map never scrolls — full route is always visible.

---

## Replay HUD (`#replay-hud`)

Fixed pill, centered, immediately below `#info`. Same dark glass style as `#info` (`rgba(15,23,42,0.92)`, `backdrop-filter: blur(8px)`, `border-radius: 10px`).

Displays two values that update on every animation frame while playing or paused mid-replay:

- **Recorded time** — wall-clock time from the GPS timestamp, formatted as `h:mm:ss AM/PM` (e.g. `3:47:22 PM`)
- **Current speed** — GPS speed at that point converted to MPH, formatted as `42 MPH`. Show `-- MPH` when speed data is unavailable for a point.

While in **idle** state (chevron at start, never played), HUD shows the drive start time and speed of first point.

---

## Playback Controls (`#replay-controls`)

Fixed pill, centered, immediately above `#dna`. Same dark glass style.

Button order (left → right):

```
[ ⏮ Stop ]  [ ⏪ −10m ]  [ ▶ / ⏸ ]  [ ⏩ +10m ]  [ 1× ]
```

| Control | Behaviour |
|---|---|
| **Stop ⏮** | Resets chevron to route start, resets HUD to first point values, enters idle state |
| **−10m ⏪** | Seeks 10 minutes backward in recorded drive time; clamps at 0 |
| **Play/Pause ▶⏸** | Toggles between playing and paused; icon changes to match current state |
| **+10m ⏩** | Seeks 10 minutes forward in recorded drive time; clamps at end |
| **Speed [ 1× ]** | Cycles 1× → 2× → 4× → 8× → 16× → 32× → 1× on each tap; label updates |

The ±10m buttons operate on **recorded drive time**, not wall-clock replay time.

---

## State Machine

```
idle ──[Play]──► playing ──[Pause]──► paused
 ▲                  │                   │
 └──────[Stop]──────┘                   │
 └──────────────────────[Stop]──────────┘
 ◄──────────────[reach end]─────────────(auto)
```

- **idle**: Chevron at route start. Play button shows ▶.
- **playing**: Chevron animating. Play button shows ⏸.
- **paused**: Chevron frozen at current position. Play button shows ▶.
- When replay reaches the last GPS point, auto-transitions to idle (chevron resets, Play shows ▶).

---

## Animation

### Data

Each GPS point: `{ lat, lng, alt, speed (m/s), ts (epoch ms) }`. Points are sparse — typically 1 per 1–3 seconds.

### Loop

Use `requestAnimationFrame`. On each frame:

1. Compute `driveElapsedMs = (wallClockNow - playStartWallClock) × playbackSpeed + seekOffsetMs`
2. Find the two points that bracket `driveElapsedMs` by binary-searching `ts`.
3. Compute `t = (driveElapsedMs - p0.ts) / (p1.ts - p0.ts)` — interpolation factor [0,1].
4. Lerp `lat` and `lng` between `p0` and `p1`.
5. Compute bearing between `p0` and `p1` — rotate chevron to face direction of travel.
6. Interpolate speed between `p0` and `p1`; convert m/s → MPH.
7. Move chevron marker to interpolated position; update `#replay-hud`.
8. Pan map to keep chevron visible if it exits the viewport (smooth pan, no jarring re-fit).

### Seeking

When ±10m or speed change occurs while playing:

- Adjust `seekOffsetMs` by ±600,000 ms (clamp to `[0, totalDriveMs]`).
- If playing, update `playStartWallClock` so the new offset takes effect immediately without a visible jump.
- If paused, update `driveElapsedMs` and redraw chevron at the new position.

### Multi-part drives

`openDriveMap` already concatenates parts via `getDriveGroup`. For replay, coordinates from all parts are merged in order and treated as a single timeline. There is no indication of part boundaries during playback.

---

## Replay Marker

A single `L.marker` with a `L.divIcon`, created once on page load and positioned at the first GPS point. Never removed — Stop moves it back to start.

### Primary: Vehicle Photo

If the active vehicle has a photo, use it as the marker:

- **Shape**: Circle, 48×48 px, `border-radius: 50%`, `object-fit: cover`
- **Border**: 3px solid `#f97316` (brand orange) so it reads over the route line
- **Shadow**: `box-shadow: 0 2px 8px rgba(0,0,0,0.5)` for map contrast
- **Rotation**: The circular photo itself does not rotate (looks wrong on a face/car). Instead, a small orange directional arrow chevron (14×14 px) is rendered below the photo pointing in the direction of travel. The chevron rotates with bearing on every frame; the photo stays upright.
- **z-order**: `zIndexOffset: 1000` — above route line and static arrows

**Data flow:** `openDriveMap()` reads the active vehicle record from IndexedDB before generating the Blob, extracts `vehicle.photo` (base64 string), and injects it into the Blob template. The vehicle name is already passed via `drive.vehicle` — use it to look up the matching vehicle.

### Fallback: Chevron

Used automatically when the vehicle has no photo (`vehicle.photo` is null/empty):

- **Size**: 18×26 px
- **Color**: Solid `#f97316` with white outline stroke
- **Shape**: Same upward-pointing triangle SVG as the static route arrows, but larger and fully opaque
- **Rotation**: Full marker rotates to bearing on every frame

### Switching

The marker type is determined once when the page loads — no runtime toggle. If a vehicle has a photo, it always gets the photo marker; if not, always the chevron.

---

## Visual Design Notes

- All four overlay pills (info, replay-hud, controls, dna) use identical glass-dark styling so they read as a coherent system.
- `#replay-controls` buttons: icon-only on mobile (≤ 480px); icon + short label on wider screens.
- Speed badge `[ 1× ]` uses brand-orange text when > 1× to signal non-default state.
- Active state on ⏸ Play/Pause uses a subtle brand-orange ring/highlight.
- Buttons are minimum 44×44 px touch targets.
- The ±10m buttons are visually slightly smaller/less prominent than Stop and Play/Pause (secondary actions).

---

## Data Flow Changes

### `openDriveMap()` (app.js ~line 1444)

Currently passes:
```js
const coords = allCoords.map(c => [c.lat, c.lng]);
```

Must change to pass the full objects so the Blob page has `speed` and `ts`:
```js
const replayCoords = allCoords.map(c => ({
  lat: c.lat, lng: c.lng,
  speed: (c.speed != null && c.speed >= 0) ? mpsToMph(c.speed) : null,
  ts: c.ts
}));
```

`coords` (the `[lat, lng]` array) is kept for the polyline and static arrows — no existing code changes needed there. `replayCoords` is a second payload added to the Blob template.

---

## Out of Scope (v1.6.0)

- Progress/scrub bar (drag to seek) — deferred
- Audio cues or haptics
- Replay of the live GPS track (main map screen)
- Sharing a replay link
