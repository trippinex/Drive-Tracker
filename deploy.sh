#!/bin/bash
set -e

BUCKET="gs://drive-tracker-497900"

echo "Deploying to $BUCKET..."

gsutil -m rsync -r -d \
  -x "sw\.js|\.git|\.env|\.claude|\.firebase|DEPLOY\.md|CHANGELOG\.md|README\.md|ROADMAP\.md|cloudbuild\.yaml|generate-config\.ps1|firebase\.json|\.firebaserc|deploy\.sh|ui-theme/|graphify-out/|config\.js" \
  . "$BUCKET"

# ui-theme/theme.css is required by the service worker shell — deploy it explicitly
gsutil cp ui-theme/theme.css "$BUCKET/ui-theme/theme.css"

# Entry point and service worker must never be cached
gsutil cp sw.js "$BUCKET/sw.js"
gsutil setmeta -h "Cache-Control:no-cache, no-store, must-revalidate" "$BUCKET/sw.js"
gsutil setmeta -h "Cache-Control:no-cache, no-store, must-revalidate" "$BUCKET/index.html"

# Invalidate Cloud CDN so changes are visible immediately
gcloud compute url-maps invalidate-cdn-cache drive-tracker-urlmap --path "/*" --async

echo "Done. Live at https://drivetracker.soccerwrek.net"
