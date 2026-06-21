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

# Short CDN TTL on versioned assets — the CDN strips query strings so the
# ?v=N cache-busting strategy only works at the browser level. 5-minute
# max-age ensures CDN nodes serve fresh content within 5 minutes of a deploy
# without requiring an explicit cache invalidation.
gsutil setmeta -h "Cache-Control:public, max-age=300" "$BUCKET/app.js"
gsutil setmeta -h "Cache-Control:public, max-age=300" "$BUCKET/styles.css"
gsutil setmeta -h "Cache-Control:public, max-age=300" "$BUCKET/ui-theme/theme.css"

# Best-effort CDN invalidation for immediate propagation.
# Requires compute.urlMaps.invalidateCache permission (see BUG-001).
# Degrades gracefully to the 5-minute TTL above if this fails.
gcloud compute url-maps invalidate-cdn-cache drive-tracker-urlmap --path "/*" --async || true

echo "Done. Live at https://drivetracker.soccerwrek.net"
