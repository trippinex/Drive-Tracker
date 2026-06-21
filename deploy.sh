#!/bin/bash
set -e

BUCKET="gs://drive-tracker-497900"

echo "Deploying to $BUCKET..."

gsutil -m rsync -r -d \
  -x "sw\.js|app2?\.js|index\.html|\.git|\.env|\.claude|\.firebase|DEPLOY\.md|CHANGELOG\.md|README\.md|ROADMAP\.md|cloudbuild\.yaml|generate-config\.ps1|firebase\.json|\.firebaserc|deploy\.sh|ui-theme/|graphify-out/|config\.js" \
  . "$BUCKET"

# ui-theme/theme.css is required by the service worker shell — deploy it explicitly
gsutil cp ui-theme/theme.css "$BUCKET/ui-theme/theme.css"

# Upload critical files atomically with no-cache so the CDN header is set at the moment of upload
# and there is no race window where rsync writes the file without the header.
# app.js is also uploaded as-is so users still on the old CDN-cached index.html (which
# references /app.js?v=30) get the latest JS code without breaking their page.
gsutil -h "Cache-Control:no-cache, no-store, must-revalidate" cp index.html "$BUCKET/index.html"
gsutil -h "Cache-Control:no-cache, no-store, must-revalidate" cp app.js "$BUCKET/app.js"
gsutil -h "Cache-Control:no-cache, no-store, must-revalidate" cp app.js "$BUCKET/app2.js"
gsutil -h "Cache-Control:no-cache, no-store, must-revalidate" cp sw.js "$BUCKET/sw.js"

# Invalidate Cloud CDN so changes are visible immediately
gcloud compute url-maps invalidate-cdn-cache drive-tracker-urlmap --path "/*" --async || \
  echo "WARNING: CDN invalidation failed (missing compute.urlMaps.invalidateCache IAM permission). Stale CDN entries will expire within 24h. The SW v37 patches stale index.html in the meantime."

echo "Done. Live at https://drivetracker.soccerwrek.net"
