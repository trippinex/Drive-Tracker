/**
 * Build config used ONLY for generating the prebuilt theme.css bundle.
 * Scans the starter sample HTML so every utility used in the gallery is
 * included.
 *
 * To rebuild after editing theme.input.css or the sample:
 *   cd ui-theme
 *   npx tailwindcss -c build.config.js -i ./theme.input.css -o ./theme.css --minify
 *
 * This file is NOT used by the main FuelTrack app.
 */
module.exports = {
  presets: [require('./tailwind.preset.js')],
  content: ['./starter/**/*.html'],
}
