# DT-018 — POI Management

## Overview

Add named Points of Interest (POIs) that persist to Firestore, appear as markers on every map view, and announce themselves via Web Speech API when the user's GPS position enters a configurable approach radius during live recording or replay.

---

## Phase Scope

**Phase 1 (this spec):** Desktop browser only. POI management (add / edit / delete) is accessible from the hamburger menu as a right-side panel. On mobile, POI markers are visible on all maps and voice announcements fire during recording, but the management UI is not surfaced.

**Phase 2 (deferred):** POI management from mobile browser.

---

## POI Data Model

Stored in Firestore at `users/{uid}/pois/{poiId}`. POIs are global to the user account — not tied to a specific vehicle.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | ✓ | Official name (e.g. "Laguna Seca") |
| `friendlyName` | string | — | If set, used for voice announcements instead of `name` |
| `address` | string | — | Human-readable address from geocoding or reverse-geocode |
| `lat` | number | ✓ | Decimal degrees |
| `lng` | number | ✓ | Decimal degrees |
| `category` | string | ✓ | See Categories below |
| `notes` | string | — | Free-form personal notes |
| `createdAt` | Timestamp | ✓ | Set on first write |
| `updatedAt` | Timestamp | ✓ | Updated on every save |

### Categories

| Value | Label | Map Icon |
|---|---|---|
| `fuel_stop` | Fuel Stop | ⛽ |
| `track_circuit` | Track / Circuit | 🏁 |
| `viewpoint_scenic` | Viewpoint / Scenic | 🏔️ |
| `restaurant_cafe` | Restaurant / Café | 🍽️ |
| `parking` | Parking | 🅿️ |
| `home_base` | Home / Base | 🏠 |
| `garage_storage` | Garage / Storage | 🏗️ |
| `other` | Other | 📍 |

Category icons are rendered as emoji inside a `L.divIcon` div — a small rounded square with a category-specific background color, consistent with existing marker style.

---

## Global POI Settings

Stored alongside other user preferences (align with the existing settings document structure). Two keys:

| Setting | Type | Default | Notes |
|---|---|---|---|
| `poi.approachRadiusM` | number | `300` | Meters; applies to all POIs |
| `poi.showRadiusCircle` | boolean | `false` | Whether to draw the approach-radius circle on the map around each POI marker |

---

## Geocoding

Use **Nominatim** (OpenStreetMap) — free, no API key required.

- **Forward geocode** (address → lat/lng): called when user types an address in the Add/Edit form and confirms. Fires a debounced request; shows a suggestion list if multiple results match; user selects one.
- **Reverse geocode** (lat/lng → address): called immediately after a map click-to-place to pre-fill the address field in the form.

Nominatim endpoint: `https://nominatim.openstreetmap.org/`  
Include `User-Agent: DriveTracker/1.x` header on all requests per Nominatim policy.

---

## Entry Point

Hamburger menu gains a new item: **"Points of Interest"**. Clicking it opens the POI Management Panel. The menu item is present on all viewport sizes; the panel itself is desktop-only (see Mobile Behavior).

---

## POI Management Panel

A right-side slide-in panel — same pattern as Drive History. On desktop, it overlays the right portion of the map so the map remains visible for click-to-place interactions.

### Header

```
[ ← ]  Points of Interest          [ ⚙ ]  [ + Add POI ]
```

- **← (close):** closes the panel.
- **⚙ (settings):** expands an inline settings row below the header:
  - Approach radius: number input (meters), default 300. Label: "Approach radius (m)".
  - Show radius circles: checkbox. Label: "Show radius on map".
  - Changes save immediately (debounced write to Firestore settings).
- **+ Add POI:** enters Add mode (see Add/Edit Form below).

### POI List

Each row:
```
[ icon ]  Name                   [ ✏ ]  [ 🗑 ]
          Friendly: "nickname"
          Category · address snippet
```

- Clicking the name/row body pans and zooms the main map to the POI's location and closes the panel.
- Edit (✏) opens the Add/Edit form pre-filled with that POI's data.
- Delete (🗑) shows a brief inline confirmation ("Delete [name]? [Cancel] [Delete]") before removing from Firestore.
- List is sorted alphabetically by `name`.
- Empty state: "No POIs yet. Click + Add POI to create your first."

### Add/Edit Form

Slides in over the list (or replaces it) within the same panel.

```
[ ← Back ]  Add POI  /  Edit POI

Official name *        [________________]
Friendly name          [________________]
                       (used for voice announcement)

Address                [________________] [ Search ]
                       or click on the map to place

Category *             [ ▼ dropdown ]
Notes                  [ textarea     ]

                       [ Cancel ]  [ Save ]
```

**Click-to-place flow:**
1. User clicks "click on the map to place" link (or the map itself while the form is open).
2. Panel collapses to a slim banner: "Click anywhere on the map to place the POI".
3. Map cursor changes to crosshair.
4. User clicks map → pin preview drops at that location; reverse-geocode pre-fills Address field.
5. Panel re-expands with the form, coordinates locked to the clicked location.
6. User can repeat the click to re-place before saving.

**Address search flow:**
1. User types in Address field and presses Search (or Enter).
2. Nominatim forward-geocode fires; results dropdown appears below the field.
3. User selects a result → pin preview appears on map at that location; lat/lng stored internally.

**Validation:**
- `name` is required; show inline error on Save if blank.
- `category` is required; default to `other` if none selected.
- A lat/lng must be resolved (via click or address search) before Save is enabled.

---

## Map Markers

POI markers appear on **every map view**:
- Main recording map (live)
- Drive detail / full-screen map (opened from Drive History cards)
- Drive Replay map (DT-008)

### Marker visual

`L.divIcon` with a 32×32 px rounded-square div. Background color varies by category (brand palette — to be finalised during implementation). Emoji icon centered inside. A small white drop-shadow so markers read over the route polyline.

### Radius circle

When `poi.showRadiusCircle` is `true`, draw a `L.circle` at each POI's lat/lng with radius = `poi.approachRadiusM` and a semi-transparent fill (same color as the marker, low opacity). The circle updates live if the setting changes while the panel is open.

### Data loading

POIs are loaded via a Firestore `onSnapshot` listener on `users/{uid}/pois`, so markers update in real time when POIs are added, edited, or deleted (including from another tab).

---

## Voice Announcements — Shared Position Handler

Both live recording and replay route their current position through a single shared function:

```js
handlePoiProximity(lat, lng, ts)
```

This function:
1. Iterates all loaded POIs.
2. For each POI, computes the Haversine distance from `(lat, lng)` to the POI's location.
3. If distance ≤ `poi.approachRadiusM` AND the POI has not been announced within the last 5 minutes in this session:
   - Calls `speechSynthesis.speak()` with the utterance: `"Approaching [friendlyName ?? name]"`.
   - Records the announcement timestamp for that POI (in-memory, per session — not persisted to Firestore).
4. Does nothing if `speechSynthesis` is unavailable or the browser has not granted audio permission.

Per-POI cooldown is **5 minutes** (300,000 ms). The cooldown resets when a new recording session starts or the page reloads.

### Live Recording

The existing `navigator.geolocation.watchPosition` success callback calls `handlePoiProximity(position.coords.latitude, position.coords.longitude, position.timestamp)` on every position update, in addition to its current recording logic.

### Replay (DT-008)

The replay animation loop calls `handlePoiProximity(lat, lng, driveElapsedTs)` on each frame **only when the "Announce POIs" checkbox is checked**.

A new checkbox is added to the `#replay-controls` pill:

```
[ ⏮ ]  [ ⏪ ]  [ ▶/⏸ ]  [ ⏩ ]  [ 1× ]  [ 📍 Announce POIs ☑ ]
```

- Default: **checked**.
- State persists for the lifetime of the replay page (not saved to Firestore).
- When unchecked mid-replay, the in-memory cooldown state resets so a subsequent re-check starts fresh.

---

## Mobile Behavior (Phase 1)

| Capability | Mobile |
|---|---|
| POI markers on map | ✓ |
| Voice announcements during recording | ✓ |
| "Points of Interest" in hamburger menu | Hidden (CSS `display: none` on mobile breakpoint) |
| Add / Edit / Delete | Not available |

---

## Testing Strategy

### 1 — Chrome DevTools GPS simulation

Open DevTools → More tools → Sensors → Location. Manually enter coordinates that step toward a known POI's lat/lng. Good for quick smoke-testing approach radius and voice announcement trigger during development without leaving the desk.

### 2 — Drive Replay as fake GPS source

Because replay and live recording share `handlePoiProximity`, replaying any saved drive that passes near a POI will trigger the same proximity logic. Check "Announce POIs" in the replay controls. This tests the full announcement pipeline against real coordinate data.

---

## Out of Scope (Phase 1)

- POI management on mobile (Phase 2)
- Per-POI approach radius (global setting only)
- Importing / exporting POIs
- Sharing POIs between users
- POI categories beyond the eight defined above
- Distance-remaining callout (e.g. "POI in 200 m")
- Haptic feedback
