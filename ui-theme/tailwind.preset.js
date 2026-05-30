/**
 * Tailwind preset — Slate + Orange theme.
 *
 * Drop into a project's tailwind.config.js via:
 *   module.exports = {
 *     presets: [require('./theme/tailwind.preset.js')],
 *     content: [...your paths],
 *   }
 *
 * Override any value here in your own config to rebrand. The `brand` palette
 * is intentionally named generically so this preset can be reused as-is.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        // Primary CTA / accent. Replace with your brand colour by editing
        // these six stops (or overriding in your own config).
        brand: {
          50:  '#fff7ed',
          100: '#ffedd5',
          400: '#fb923c',
          500: '#f97316',
          600: '#ea580c',
          700: '#c2410c',
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto',
               'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
