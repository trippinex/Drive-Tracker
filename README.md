# DriveTracker

A Progressive Web App (PWA) for car enthusiasts to record driving routes, track real-time telemetry, and manage a garage of vehicles — all from a phone mount.

---

## Features

- **Real-time GPS tracking** with speed, distance, duration, and altitude telemetry
- **Route trail** with directional chevron arrows on the map
- **Vehicle garage** — add vehicles with photo, make, model, year, and notes
- **Drive History** — view past drives with vehicle thumbnails, GPX/KML export, and full-screen map view
- **Cloud sync** via Firestore — drive history and vehicles sync across all your devices
- **Offline-first** — records drives without an internet connection; syncs when back online
- **Google Sign-In** with single-user email restriction
- **Installable PWA** — add to iPhone or Android home screen for a native-app experience

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JavaScript (ES6+), HTML5, CSS3 |
| Styling | Tailwind CSS (CDN) + custom design system |
| Maps | Leaflet.js + CartoCDN Positron tiles |
| Local storage | IndexedDB (offline-first) |
| Cloud sync | Firebase Firestore |
| Authentication | Firebase Authentication (Google Sign-In) |
| Hosting | Google Cloud Storage + Cloud Load Balancer |
| CDN | Google Cloud CDN |
| Domain | Custom domain with Google-managed SSL |

---

## Project Structure

```
Drive Tracker/
├── index.html          # App shell — all UI structure
├── app.js              # Core app logic (map, GPS, telemetry, history, vehicles)
├── auth.js             # Firebase Authentication
├── sync.js             # Firestore bidirectional sync engine
├── styles.css          # Custom styles layered on Tailwind CDN
├── sw.js               # Service Worker (cache strategies, offline support)
├── manifest.json       # PWA manifest
├── icons/              # App icons (16, 32, 180, 192, 512px)
├── ui-theme/           # Slate + Orange design system (shared with FuelTracker)
├── CHANGELOG.md        # Version history
├── DEPLOY.md           # GCP deployment guide
└── cloudbuild.yaml     # Cloud Build CI/CD pipeline
```

---

## GPS Recording Strategy

DriveTracker uses a **15-metre distance threshold** for GPS point capture — recording a new point only when the device has moved ≥15m from the last recorded point. This matches Google Maps' capture strategy and provides:

- ~70% fewer points than time-based recording
- Automatic density scaling (more detail on winding roads, fewer on straight highways)
- Drives up to ~35 miles fit in a single Firestore document

Drives exceeding **5,000 GPS points** are automatically split into numbered parts (Part 1 of 2, etc.) with no data loss. GPX/KML export and map view always combine all parts seamlessly.

---

## Cloud Architecture

```
Browser (PWA)
    │
    ├── IndexedDB          — local offline store (drives + vehicles)
    │
    ├── Firebase Auth      — Google Sign-In, JWT validation
    │
    ├── Firestore          — cloud sync (metadata + GPS coordinates)
    │
    └── GCS Bucket         — static file hosting
          └── Cloud CDN → custom domain
```

---

## Deployment

See [DEPLOY.md](DEPLOY.md) for full GCP deployment instructions including:
- GCS static hosting setup
- Cloud Load Balancer + SSL configuration
- Cloud Build CI/CD pipeline
- Cache-control header strategy

### Quick deploy
```bash
# Versioned assets (1-hour cache)
gsutil -m -h "Cache-Control:public, max-age=3600, must-revalidate" \
  cp app.js styles.css manifest.json gs://drive-tracker-497900/

# No-cache files (always fresh)
gsutil -h "Cache-Control:no-cache, must-revalidate" \
  cp index.html auth.js sync.js gs://drive-tracker-497900/

# Service worker (never cache)
gsutil -h "Cache-Control:no-cache, no-store, must-revalidate" \
  cp sw.js gs://drive-tracker-497900/sw.js

# Invalidate CDN
gcloud compute url-maps invalidate-cdn-cache drive-tracker-urlmap \
  --path "/*" --project=drive-tracker-497900
```

> **Important:** Always bump `?v=N` in `index.html` and `sw.js` `SHELL_ASSETS` when modifying `app.js` or `styles.css`.

---

## Version History

See [CHANGELOG.md](CHANGELOG.md).

---

## License

Private — all rights reserved.
