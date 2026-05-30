# DriveTracker â€” Production Deployment Guide

Two equally valid paths: **GCS static hosting** (lower-level, fine-grained control)
or **Firebase Hosting** (zero-config CDN, free SSL, preview channels). Pick one.

---

## Option A â€” Google Cloud Storage (GCS) Static Hosting

### 1. Prerequisites

```bash
# Install Google Cloud CLI
# https://cloud.google.com/sdk/docs/install

gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### 2. Create and configure the bucket

```bash
BUCKET="DriveTracker-app"          # must be globally unique; try DriveTracker-yourname
REGION="us-central1"

# Create bucket
gcloud storage buckets create gs://$BUCKET \
  --location=$REGION \
  --uniform-bucket-level-access

# Allow public reads
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member="allUsers" \
  --role="roles/storage.objectViewer"

# Configure static website index / 404 pages
gcloud storage buckets update gs://$BUCKET \
  --web-main-page-suffix=index.html \
  --web-error-page=index.html      # SPA â€” serve index for unknown paths too
```

### 3. Deploy manually (first time or local testing)

```bash
# All assets â€” 1-hour browser cache
gsutil -m rsync -r -d \
  -h "Cache-Control:public, max-age=3600, must-revalidate" \
  -x "sw\.js" \
  . gs://$BUCKET/

# Service worker â€” MUST be no-cache
gsutil cp \
  -h "Cache-Control:no-cache, no-store, must-revalidate" \
  sw.js gs://$BUCKET/sw.js
```

### 4. (Optional) Map to a custom domain via Cloud Load Balancer

GCS alone serves over `storage.googleapis.com`. For a vanity domain + global CDN:

1. Reserve a global static IP: `gcloud compute addresses create DriveTracker-ip --global`
2. Create a backend bucket pointing at your GCS bucket.
3. Create an HTTPS load balancer (Cloud Armor optional).
4. Point your DNS A record at the reserved IP.
5. Provision a Google-managed SSL certificate on the load balancer.

Full walkthrough: https://cloud.google.com/storage/docs/hosting-static-website

---

## Option B â€” Firebase Hosting (Recommended for most developers)

Firebase Hosting gives you a global CDN, automatic HTTPS, preview channels,
and one-command deploys â€” all on the free Spark plan up to 10 GB/month transfer.

### 1. Install Firebase CLI and initialise

```bash
npm install -g firebase-tools
firebase login

# In your project directory:
firebase init hosting
# Answer the prompts:
#   Public directory: .  (or dist if you add a build step)
#   Single-page app:  N  (we have a real index.html)
#   Overwrite index:  N
```

This creates `firebase.json` and `.firebaserc` in your project root.

### 2. Configure firebase.json

Replace the generated file with the following (critical for sw.js cache headers):

```json
{
  "hosting": {
    "public": ".",
    "ignore": [
      "firebase.json",
      ".firebaserc",
      "DEPLOY.md",
      "cloudbuild.yaml",
      ".claude/**",
      "node_modules/**",
      ".git/**"
    ],
    "headers": [
      {
        "source": "/sw.js",
        "headers": [
          { "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" },
          { "key": "Service-Worker-Allowed", "value": "/" }
        ]
      },
      {
        "source": "/manifest.json",
        "headers": [
          { "key": "Cache-Control", "value": "public, max-age=86400" }
        ]
      },
      {
        "source": "**/*.@(js|css|png|jpg|svg|ico|woff2)",
        "headers": [
          { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
        ]
      },
      {
        "source": "**",
        "headers": [
          { "key": "X-Content-Type-Options", "value": "nosniff" },
          { "key": "X-Frame-Options",         "value": "SAMEORIGIN" },
          { "key": "Referrer-Policy",          "value": "strict-origin-when-cross-origin" }
        ]
      }
    ],
    "rewrites": [
      { "source": "**", "destination": "/index.html" }
    ]
  }
}
```

### 3. Deploy

```bash
firebase deploy --only hosting
# Output: Hosting URL: https://DriveTracker-app.web.app
```

### 4. Preview channels (staging / PR previews)

```bash
# Create a temporary preview URL that expires in 7 days
firebase hosting:channel:deploy preview --expires 7d
# Output: https://DriveTracker-app--preview-<hash>.web.app
```

---

## Option C â€” Cloud Build CI/CD (automated deploys on git push)

The included `cloudbuild.yaml` automates the GCS deploy path.  
To wire it up with GitHub:

### 1. Connect your repository

```bash
# Enable required APIs
gcloud services enable cloudbuild.googleapis.com storage.googleapis.com

# Open the Cloud Build triggers page in GCP Console:
# https://console.cloud.google.com/cloud-build/triggers
# â†’ Connect Repository â†’ GitHub â†’ Select your repo
```

### 2. Create the trigger

```bash
gcloud builds triggers create github \
  --repo-owner=YOUR_GITHUB_USERNAME \
  --repo-name=DriveTracker \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml \
  --substitutions="_BUCKET=DriveTracker-app,_REGION=us-central1"
```

### 3. Grant Cloud Build access to GCS

```bash
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format="value(projectNumber)")
CB_SA="$PROJECT_NUMBER@cloudbuild.gserviceaccount.com"

gcloud storage buckets add-iam-policy-binding gs://DriveTracker-app \
  --member="serviceAccount:$CB_SA" \
  --role="roles/storage.objectAdmin"
```

### 4. Verify the pipeline

Push a change to `main`:
```bash
git add . && git commit -m "chore: trigger build" && git push origin main
```

Then watch in the console: https://console.cloud.google.com/cloud-build/builds

---

## PWA Icon Generation

The manifest references `icons/icon-192.png` and `icons/icon-512.png`.  
Generate them from any source image:

```bash
# Using sharp-cli (Node)
npm install -g sharp-cli
sharp -i logo.png -o icons/icon-192.png resize 192 192
sharp -i logo.png -o icons/icon-512.png resize 512 512
```

Or use https://maskable.app to create maskable icons with safe-zone padding.

---

## Checklist before going live

- [ ] Replace placeholder icons in `icons/` with real branded assets
- [ ] Verify `manifest.json` `start_url` matches your deployed domain
- [ ] Test the PWA install prompt on Android Chrome and iOS Safari
- [ ] Confirm `sw.js` is served with `Cache-Control: no-cache` (check DevTools â†’ Network)
- [ ] Test offline: load the app, toggle Airplane mode, reload â€” map tiles should serve from cache
- [ ] Test the Wake Lock: start a drive, lock screen manually â€” it should stay on
- [ ] Validate GPX export opens in Google Earth / Strava route builder
- [ ] Run Lighthouse PWA audit â€” target 90+ score
