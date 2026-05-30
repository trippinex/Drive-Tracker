# Slate + Orange UI Theme

A small, opinionated UI kit extracted from the FuelTrack PWA. Designed for
**mobile-first Flask/Jinja apps** that use **Tailwind CSS** and want a polished
look without writing CSS from scratch.

## What's in the box

| File | What it is |
|---|---|
| `tailwind.preset.js` | Tailwind config preset — brand colour palette + theme extensions |
| `theme.input.css` | Source CSS — base-layer fixes + component classes (`.card`, `.btn-primary`, etc.) |
| `theme.css` | Pre-built, minified CSS for quick prototyping without a build step |
| `starter/base.html` | Reference Jinja base template showing the nav + flash + main pattern |
| `starter/manifest.json` | PWA web app manifest template |
| `starter/sample.html` | Visual gallery — every component on one page |

## Design tokens

- **Brand palette** (`brand-50` … `brand-700`) — orange. Defined in the preset; rename or recolour as you like.
- **Neutrals** — Tailwind's `slate` scale (`slate-50` for surfaces, `slate-800` for primary text).
- **Radius** — `rounded-lg` for inputs/buttons, `rounded-xl` for cards.
- **Tap target** — 44 × 44 px minimum (Apple HIG).
- **Container** — `max-w-6xl mx-auto px-4` (centred, 1152 px on desktop).
- **Mobile font size** — `text-base` (16 px) on form inputs to stop iOS auto-zoom on focus.

## Quick start — with a Tailwind build pipeline

1. Copy `tailwind.preset.js` and `theme.input.css` into your project (suggested path: `theme/`).
2. In your `tailwind.config.js`:
   ```js
   module.exports = {
     presets: [require('./theme/tailwind.preset.js')],
     content: ['./templates/**/*.html', './static/js/**/*.js'],
   }
   ```
3. Create your own `app.input.css`:
   ```css
   @import './theme/theme.input.css';
   /* your project-specific styles here */
   ```
4. Build:
   ```bash
   npx tailwindcss -i ./app.input.css -o ./static/css/app.css --minify
   ```
5. Link the result from your base template (`<link rel="stylesheet" href="...">`).

## Quick start — without a build step (prototyping)

Just drop `theme.css` into your project and link it:

```html
<link rel="stylesheet" href="theme.css" />
```

You get all the component classes pre-baked. Caveat: you can only use the
utility classes that the prebuilt bundle saw — if you want more, run the build.

## Rebranding

To change the orange to a different colour, edit `tailwind.preset.js`:

```js
brand: {
  50:  '#…', 100: '#…', 400: '#…',
  500: '#…',   // primary CTA colour
  600: '#…',   // hover
  700: '#…',   // active / pressed
}
```

Use a tool like [uicolors.app](https://uicolors.app) to generate a complete 9-stop palette from a single hex value.

## PWA setup

1. Copy `starter/manifest.json`, replace name + colours.
2. Generate icon files (192 px, 512 px, plus a 180 px Apple touch icon).
3. In your base `<head>`:
   ```html
   <link rel="manifest" href="/static/manifest.json" />
   <link rel="apple-touch-icon" href="/static/icons/touch-180.png" />
   <meta name="apple-mobile-web-app-capable" content="yes" />
   <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
   <meta name="apple-mobile-web-app-title" content="YourApp" />
   <meta name="theme-color" content="#1e293b" />
   ```

## Components included

- `.card` — surface
- `.metric-card`, `.metric-label`, `.metric-value`, `.metric-sub` — dashboard stat card
- `.nav-link` — top nav link with `.active` modifier
- `.btn-primary`, `.btn-secondary`, `.btn-danger` — buttons (44 px min)
- `.form-label`, `.form-input`, `.form-select` — form controls (iOS-zoom-safe)
- `.alert-success`, `.alert-error` — flash messages

See `starter/sample.html` for every component in context.

## Browser fixes baked into the base layer

- `touch-action: manipulation` on interactive elements (kills iOS double-tap zoom)
- Hidden number-input spinners (look ugly on mobile)
- `min-width: 0; max-width: 100%; -webkit-appearance: none` on date/time inputs (iOS Safari otherwise renders them at intrinsic widths that overflow narrow containers)

## License / attribution

Use freely. Attribution appreciated but not required.
