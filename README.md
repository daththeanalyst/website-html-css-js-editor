# GlassStudio

**A zero-dependency, drop-in visual CSS / HTML / JS editor for any website.**

GlassStudio is a single-file vanilla JavaScript plugin that adds a floating sidebar editor to any web page. Click any element marked as editable and start tweaking colors, fonts, layouts, effects, and more — all in real time, with a glassmorphism UI.

> **[Live Demo](https://daththeanalyst.github.io/website-html-css-js-editor/)** — click any element on the demo page to try it.

---

## Features

GlassStudio v1.1 ships with **11 professional editing tools**:

| # | Feature | Description |
|---|---------|-------------|
| 1 | **Copy & Paste Styles** | Ctrl+Shift+C/V to copy an element's full style and paste it onto others |
| 2 | **Gradient Builder** | Pick start/end colors + angle, preview live, apply linear gradients |
| 3 | **Text Shadow Controls** | X/Y offset, blur, and color sliders for text shadows |
| 4 | **CSS Transition Builder** | Set property, duration, easing, and hover scale with live preview |
| 5 | **Flexbox & Grid Controls** | Toggle display, direction, justify, align, gap, and wrap visually |
| 6 | **Spacing Visualizer** | Overlay showing padding (green) and margin (blue), updates on scroll |
| 7 | **Responsive Preview** | Switch between Mobile (375px), Tablet (768px), and Desktop widths |
| 8 | **History Panel** | Timestamped undo/redo history — click any entry to jump back |
| 9 | **Keyboard Shortcuts** | Full shortcut support — press `?` to see the overlay |
| 10 | **Batch Editing** | Shift+click to select multiple elements, apply changes to all at once |
| 11 | **Presets & Categories** | Save style presets by category, apply them to any element |

**Plus the core toolkit**: color swatches, background gradients, typography controls (font family, weight, size, tracking, leading, text transform), spacing sliders (padding, margin, border-radius, border-width), opacity, box shadow, image filters (grayscale, sepia, blur, brightness, contrast), image resizing, WCAG contrast checker, multi-format export (HTML, CSS, React JSX, Tailwind), inline content editing, and an element tree inspector.

---

## Quick Start

### 1. Include the files

```html
<link rel="stylesheet" href="overlay-editor.css">
<script src="overlay-editor.js"></script>
```

### 2. Mark editable elements

```html
<h1 data-editable="true">Click me to edit</h1>
<p data-editable="true">I'm editable too.</p>
<img src="photo.jpg" data-editable="true" />
```

### 3. Done

GlassStudio auto-initializes on page load. Click any editable element and the sidebar appears.

---

## API

GlassStudio exposes a public API on `window.GlassStudio`:

```js
// Manual initialization (with options)
GlassStudio.init({
    theme: 'dark',          // 'dark' | 'light' | 'midnight' | custom object
    rewriteHandler: null,   // async (html, element) => newHtml
    showBtnPosition: null   // { top, left, bottom, right }
});

// Select / deselect elements programmatically
GlassStudio.select(document.querySelector('#hero'));
GlassStudio.deselect();

// Undo / Redo
GlassStudio.undo();
GlassStudio.redo();

// Get all changes made during the session
const changes = GlassStudio.getChanges();
// Returns: [{ element, originalCssText, currentCssText, originalInnerHTML, currentInnerHTML }]

// Export
const html = GlassStudio.exportHTML();       // Clean HTML without editor markup
const css  = GlassStudio.exportCSS();        // CSS rules for changed elements
const jsx  = GlassStudio.exportReact();      // React inline style objects
const tw   = GlassStudio.exportTailwind();   // Tailwind class mappings

// Runtime configuration
GlassStudio.configure({ theme: 'midnight' });

// Show/hide loading overlay
GlassStudio.setLoading(true);

// Full teardown (removes all DOM, listeners, and state)
GlassStudio.destroy();

// Version
console.log(GlassStudio.version); // "1.1.0"
```

### Events

```js
GlassStudio.on('ready',      ()      => { /* editor initialized */ });
GlassStudio.on('select',     (data)  => { /* data.element selected */ });
GlassStudio.on('deselect',   ()      => { /* element deselected */ });
GlassStudio.on('change',     (data)  => { /* data.element, data.property */ });
GlassStudio.on('undo',       (data)  => { /* undo performed */ });
GlassStudio.on('redo',       (data)  => { /* redo performed */ });
GlassStudio.on('style:copy', (data)  => { /* style copied */ });
GlassStudio.on('style:paste',(data)  => { /* style pasted */ });
GlassStudio.on('open',       ()      => { /* sidebar opened */ });
GlassStudio.on('close',      ()      => { /* sidebar closed */ });
GlassStudio.on('destroy',    ()      => { /* teardown started */ });
```

### Plugins

```js
GlassStudio.registerPlugin('my-plugin', {
    panel: {
        title: 'My Plugin',
        html: '<div>Custom UI here</div>',
        onMount(container) { /* runs after panel is added to DOM */ }
    },
    init(api) {
        // api.on, api.off, api.getTarget, api.select, api.deselect, api.getChanges
        api.on('change', (data) => console.log('Change detected:', data));
    },
    destroy() { /* cleanup */ }
});
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + Z` | Undo |
| `Ctrl + Shift + Z` | Redo |
| `Ctrl + \` | Toggle sidebar |
| `Escape` | Deselect / Page mode |
| `1` — `4` | Switch tabs |
| `Shift + Click` | Batch-select elements |
| `Ctrl + Shift + C` | Copy element style |
| `Ctrl + Shift + V` | Paste element style |
| `?` | Show shortcut overlay |

---

## Theming

Three built-in themes: `dark` (default), `light`, and `midnight`. You can also pass a custom theme object:

```js
GlassStudio.configure({
    theme: {
        bg: 'rgba(18, 18, 28, 0.4)',
        blur: 'blur(48px) saturate(160%)',
        border: 'rgba(255, 255, 255, 0.12)',
        text: '#f8fafc',
        muted: '#94a3b8',
        primary: '#38bdf8',
        primaryHover: '#0ea5e9',
        shadow: '10px 0 40px rgba(0, 0, 0, 0.6)'
    }
});
```

---

## Architecture

GlassStudio is built as a single **IIFE** (Immediately Invoked Function Expression) with zero global pollution beyond `window.GlassStudio`:

- **Event Emitter** — synchronous pub/sub for all lifecycle events
- **Listener Registry** — tracks every `addEventListener` call for clean `destroy()` teardown
- **Change Tracking** — `WeakMap` + companion array snapshots original state on first selection
- **Plugin Registry** — dynamic tab injection with scoped API
- **Performance Optimized** — `requestAnimationFrame` throttling, DOM element caching (`_els`), debounced WCAG calculations, incremental DOM updates for element tree and history panel

### File Structure

```
overlay-editor.css   — 858 lines  — Glassmorphism UI, animations, themes
overlay-editor.js    — 2,404 lines — Complete editor logic, zero dependencies
index.html           — Demo / landing page
```

---

## License

MIT

---

Built by [Dath](https://github.com/daththeanalyst)
