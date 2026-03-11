/**
 * overlay-editor.js — GlassStudio v1.1
 * Single-file, no-build visual design editor.
 * Public API: window.GlassStudio
 */
(function () {
    'use strict';

    // ─── SECTION 1: Core State ───────────────────────────────────────────────
    let activeElement = null;
    let editorContainer = null;
    let showSidebarBtn = null;
    let targetScope = 'page';
    let _initialized = false;

    // v1.1 Feature State
    let _batchElements = new Set();          // Feature 10: Batch Edit
    let _styleClipboard = null;              // Feature 1: Copy/Paste Styles
    let _hoverStyleTag = null;               // Feature 4: Transition Builder
    let _spacingOverlay = null;              // Feature 6: Spacing Visualizer
    let _spacingVisible = false;             // Feature 6
    let _spacingScrollHandler = null;        // Feature 6
    let _spacingResizeHandler = null;        // Feature 6
    let _originalBodyStyle = null;           // Feature 7: Responsive Preview
    let _shortcutOverlay = null;             // Feature 9: Shortcut Overlay
    let _activePresetCategory = 'all';       // Feature 11: Preset Categories

    // ─── Performance Utilities ──────────────────────────────────────────────
    function _raf(fn) {
        let pending = false;
        return function () {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; fn(); });
        };
    }

    function _debounce(fn, ms) {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), ms);
        };
    }

    let _els = {};
    let _treeLastEditableCount = -1;
    let _treeLastActiveElement = null;

    // ─── SECTION 2: Undo / Redo Stacks ───────────────────────────────────────
    const undoStack = [];
    const redoStack = [];
    const MAX_UNDO = 50;

    function pushUndoState(element, propertyHint) {
        if (!element) return;
        undoStack.push({
            element: element,
            cssText: element.style.cssText,
            innerHTML: element.innerHTML,
            label: propertyHint || 'change',
            timestamp: Date.now()
        });
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
        _emitter.emit('change', { element, property: propertyHint || null });
        renderHistoryPanel('append');
    }

    function performUndo() {
        if (undoStack.length === 0) return;
        const state = undoStack.pop();
        redoStack.push({
            element: state.element,
            cssText: state.element.style.cssText,
            innerHTML: state.element.innerHTML,
            label: state.label,
            timestamp: Date.now()
        });
        state.element.style.cssText = state.cssText;
        state.element.innerHTML = state.innerHTML;
        syncSlidersToTarget();
        _emitter.emit('undo', { element: state.element });
        renderHistoryPanel();
    }

    function performRedo() {
        if (redoStack.length === 0) return;
        const state = redoStack.pop();
        undoStack.push({
            element: state.element,
            cssText: state.element.style.cssText,
            innerHTML: state.element.innerHTML,
            label: state.label,
            timestamp: Date.now()
        });
        state.element.style.cssText = state.cssText;
        state.element.innerHTML = state.innerHTML;
        syncSlidersToTarget();
        _emitter.emit('redo', { element: state.element });
        renderHistoryPanel();
    }

    // ─── Feature 8: History Panel ────────────────────────────────────────────
    function renderHistoryPanel(mode) {
        const list = _els.historyList || document.getElementById('ai-history-list');
        if (!list) return;
        if (undoStack.length === 0) {
            list.innerHTML = '<div style="font-size:10px; color:rgba(255,255,255,0.4); text-align:center;">No history yet.</div>';
            return;
        }

        // Append mode: add single new entry instead of full rebuild
        if (mode === 'append' && undoStack.length > 0) {
            const prev = list.querySelector('.ai-history-current');
            if (prev) prev.classList.remove('ai-history-current');
            const entry = undoStack[undoStack.length - 1];
            const tag = entry.element.tagName.toLowerCase();
            const time = new Date(entry.timestamp);
            const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const div = document.createElement('div');
            div.className = 'ai-history-entry ai-history-current';
            div.dataset.historyIndex = String(undoStack.length - 1);
            div.innerHTML = `<span class="ai-history-label">${entry.label}</span><span class="ai-history-meta">&lt;${tag}&gt; ${timeStr}</span>`;
            list.insertBefore(div, list.firstChild);
            // Trim excess entries from DOM
            while (list.children.length > MAX_UNDO) list.removeChild(list.lastChild);
            return;
        }

        // Full rebuild (undo/redo/jump)
        list.innerHTML = undoStack.map((entry, i) => {
            const tag = entry.element.tagName.toLowerCase();
            const time = new Date(entry.timestamp);
            const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const isCurrent = i === undoStack.length - 1;
            return `<div class="ai-history-entry${isCurrent ? ' ai-history-current' : ''}" data-history-index="${i}">
                <span class="ai-history-label">${entry.label}</span>
                <span class="ai-history-meta">&lt;${tag}&gt; ${timeStr}</span>
            </div>`;
        }).reverse().join('');
    }

    // ─── Feature 10: Batch Edit Helpers ──────────────────────────────────────
    function _applyToAllTargets(fn) {
        const primary = targetScope === 'page' ? document.body : activeElement;
        if (primary) fn(primary);
        _batchElements.forEach(el => {
            if (el !== primary) fn(el);
        });
    }

    function _updateBatchBadge() {
        const badge = _els.batchBadge;
        if (!badge) return;
        if (_batchElements.size > 0) {
            badge.style.display = 'inline-flex';
            badge.textContent = _batchElements.size + ' selected';
        } else {
            badge.style.display = 'none';
        }
    }

    function _clearBatch() {
        _batchElements.forEach(el => el.removeAttribute('data-batch-selected'));
        _batchElements.clear();
        _updateBatchBadge();
    }

    // ─── SECTION 3: Event Emitter ─────────────────────────────────────────────
    const _emitter = {
        _listeners: {},

        on(event, cb) {
            if (!this._listeners[event]) this._listeners[event] = [];
            this._listeners[event].push({ cb, once: false });
        },

        once(event, cb) {
            if (!this._listeners[event]) this._listeners[event] = [];
            this._listeners[event].push({ cb, once: true });
        },

        off(event, cb) {
            if (!this._listeners[event]) return;
            this._listeners[event] = this._listeners[event].filter(l => l.cb !== cb);
        },

        emit(event, data) {
            if (!this._listeners[event]) return;
            const snapshot = [...this._listeners[event]];
            snapshot.forEach(({ cb, once }) => {
                try { cb(data); } catch(e) { console.error('GlassStudio event error:', e); }
                if (once) this.off(event, cb);
            });
        },

        clear() {
            this._listeners = {};
        }
    };

    // ─── SECTION 4: Listener Registry (for destroy) ──────────────────────────
    const _listenerRegistry = [];

    function _addListener(target, event, handler, options) {
        if (!target) return;
        target.addEventListener(event, handler, options || false);
        _listenerRegistry.push({ target, event, handler, options: options || false });
    }

    // ─── SECTION 5: Change Tracking ──────────────────────────────────────────
    const _changeMap = new WeakMap();
    const _trackedElements = [];

    function _snapshotOriginal(element) {
        if (!element || _changeMap.has(element)) return;
        _changeMap.set(element, {
            originalCssText: element.style.cssText,
            originalInnerHTML: element.innerHTML
        });
        _trackedElements.push(element);
    }

    function _getChangesImpl() {
        const result = [];
        _trackedElements.forEach(el => {
            if (!_changeMap.has(el)) return;
            const snap = _changeMap.get(el);
            if (el.style.cssText !== snap.originalCssText || el.innerHTML !== snap.originalInnerHTML) {
                result.push({
                    element: el,
                    originalCssText: snap.originalCssText,
                    currentCssText: el.style.cssText,
                    originalInnerHTML: snap.originalInnerHTML,
                    currentInnerHTML: el.innerHTML
                });
            }
        });
        return result;
    }

    // ─── SECTION 6: Plugin Registry ──────────────────────────────────────────
    const _plugins = {};

    function _registerPlugin(name, plugin) {
        if (_plugins[name]) {
            console.warn(`GlassStudio: plugin "${name}" is already registered.`);
            return window.GlassStudio;
        }

        const pluginAPI = {
            on:         (e, cb)  => _emitter.on(e, cb),
            off:        (e, cb)  => _emitter.off(e, cb),
            getTarget:  ()       => targetScope === 'page' ? document.body : activeElement,
            select:     (el)     => window.GlassStudio.select(el),
            deselect:   ()       => window.GlassStudio.deselect(),
            getChanges: ()       => _getChangesImpl()
        };

        _plugins[name] = { plugin };

        if (plugin.panel && editorContainer) {
            const { title, html, onMount } = plugin.panel;
            const tabId = `ai-plugin-tab-${name}`;

            const tabBtn = document.createElement('button');
            tabBtn.className = 'ai-tab-btn';
            tabBtn.dataset.tab = tabId;
            tabBtn.textContent = title;
            const tabHeader = editorContainer.querySelector('.ai-editor-tabs-header');
            if (tabHeader) tabHeader.appendChild(tabBtn);

            _addListener(tabBtn, 'click', () => {
                editorContainer.querySelectorAll('.ai-tab-btn').forEach(b => b.classList.remove('active'));
                editorContainer.querySelectorAll('.ai-tab-content').forEach(c => c.classList.remove('active'));
                tabBtn.classList.add('active');
                tabContent.classList.add('active');
            });

            const tabContent = document.createElement('div');
            tabContent.className = 'ai-tab-content';
            tabContent.id = tabId;
            tabContent.innerHTML = html || '';
            const footer = editorContainer.querySelector('.ai-export-footer');
            if (footer) editorContainer.insertBefore(tabContent, footer);
            else editorContainer.appendChild(tabContent);

            _plugins[name].tabBtn = tabBtn;
            _plugins[name].tabContent = tabContent;

            if (typeof onMount === 'function') onMount(tabContent);
        }

        if (typeof plugin.init === 'function') plugin.init(pluginAPI);
        return window.GlassStudio;
    }

    // ─── SECTION 7: Configuration & Theming ──────────────────────────────────
    let _config = {
        rewriteHandler: null,
        theme: null,
        showBtnPosition: null
    };

    const PRESET_STORAGE_KEY = 'ai-editor-v13-presets';
    // Migrate from older storage formats
    ['ai-editor-v8-presets', 'ai-editor-v12-presets'].forEach(oldKey => {
        const oldData = localStorage.getItem(oldKey);
        if (oldData && !localStorage.getItem(PRESET_STORAGE_KEY)) {
            try {
                const old = JSON.parse(oldData);
                const migrated = old.map(p => ({ ...p, category: p.category || 'Custom' }));
                localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(migrated));
            } catch(e) {}
        }
        localStorage.removeItem(oldKey);
    });

    const _THEMES = {
        dark: {
            bg: 'rgba(18, 18, 28, 0.4)',
            blur: 'blur(48px) saturate(160%)',
            border: 'rgba(255, 255, 255, 0.12)',
            text: '#f8fafc',
            muted: '#94a3b8',
            primary: '#38bdf8',
            primaryHover: '#0ea5e9',
            shadow: '10px 0 40px rgba(0, 0, 0, 0.6)'
        },
        light: {
            bg: 'rgba(248, 250, 252, 0.85)',
            blur: 'blur(32px) saturate(120%)',
            border: 'rgba(0, 0, 0, 0.12)',
            text: '#0f172a',
            muted: '#64748b',
            primary: '#3b82f6',
            primaryHover: '#2563eb',
            shadow: '10px 0 40px rgba(0, 0, 0, 0.1)'
        },
        midnight: {
            bg: 'rgba(5, 5, 15, 0.6)',
            blur: 'blur(64px) saturate(180%)',
            border: 'rgba(139, 92, 246, 0.3)',
            text: '#e2e8f0',
            muted: '#8b92a5',
            primary: '#a855f7',
            primaryHover: '#9333ea',
            shadow: '10px 0 40px rgba(88, 28, 135, 0.5)'
        }
    };

    function _applyTheme(theme) {
        if (!editorContainer) return;
        const t = typeof theme === 'string' ? _THEMES[theme] : theme;
        if (!t) return;

        const propMap = {
            bg:           '--ai-editor-bg',
            blur:         '--ai-editor-blur',
            border:       '--ai-editor-border',
            text:         '--ai-editor-text',
            muted:        '--ai-editor-muted',
            primary:      '--ai-editor-primary',
            primaryHover: '--ai-editor-primary-hover',
            shadow:       '--ai-editor-shadow-drop'
        };

        Object.entries(t).forEach(([key, value]) => {
            if (propMap[key]) {
                editorContainer.style.setProperty(propMap[key], value);
                if (showSidebarBtn) showSidebarBtn.style.setProperty(propMap[key], value);
            }
        });

        editorContainer.dataset.theme = typeof theme === 'string' ? theme : 'custom';
    }

    // ─── SECTION 8: WCAG Contrast Utilities ──────────────────────────────────
    function _parseColorToRgb(colorStr) {
        if (!colorStr) return null;
        const rgb = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
        if (colorStr.startsWith('#')) {
            const hex = colorStr.replace(/^#/, '');
            const full = hex.length === 3
                ? hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2]
                : hex;
            return {
                r: parseInt(full.substring(0,2), 16),
                g: parseInt(full.substring(2,4), 16),
                b: parseInt(full.substring(4,6), 16)
            };
        }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = colorStr;
            ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            return { r: d[0], g: d[1], b: d[2] };
        } catch(e) { return null; }
    }

    function _relativeLuminance({ r, g, b }) {
        const sRGB = [r, g, b].map(c => {
            c = c / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * sRGB[0] + 0.7152 * sRGB[1] + 0.0722 * sRGB[2];
    }

    function _contrastRatio(color1Str, color2Str) {
        const c1 = _parseColorToRgb(color1Str);
        const c2 = _parseColorToRgb(color2Str);
        if (!c1 || !c2) return null;
        const L1 = _relativeLuminance(c1);
        const L2 = _relativeLuminance(c2);
        const lighter = Math.max(L1, L2);
        const darker  = Math.min(L1, L2);
        return (lighter + 0.05) / (darker + 0.05);
    }

    function _updateContrastBadge(optComp) {
        const ratioEl  = _els.contrastRatio;
        const badgeAA  = _els.badgeAA;
        const badgeAAA = _els.badgeAAA;
        if (!ratioEl) return;

        const t = targetScope === 'page' ? document.body : activeElement;
        if (!t || t.tagName === 'IMG') { ratioEl.textContent = '—'; badgeAA.className = 'ai-badge'; badgeAAA.className = 'ai-badge'; return; }

        const comp  = optComp || window.getComputedStyle(t);
        const ratio = _contrastRatio(comp.color, comp.backgroundColor);
        if (!ratio) { ratioEl.textContent = '—'; return; }

        ratioEl.textContent = ratio.toFixed(2) + ':1';
        badgeAA.className  = 'ai-badge ' + (ratio >= 4.5  ? 'ai-badge-pass' : 'ai-badge-fail');
        badgeAAA.className = 'ai-badge ' + (ratio >= 7.0  ? 'ai-badge-pass' : 'ai-badge-fail');
    }

    // ─── SECTION 9: Export Functions (module scope) ──────────────────────────
    function exportCleanHTML() {
        const clone = document.documentElement.cloneNode(true);
        const editor = clone.querySelector('#ai-floating-editor-container');
        if (editor) editor.remove();
        const showBtnNode = clone.querySelector('#ai-show-sidebar-btn');
        if (showBtnNode) showBtnNode.remove();
        clone.querySelectorAll('[data-editable-active="true"]').forEach(el => el.removeAttribute('data-editable-active'));
        clone.querySelectorAll('script').forEach(s => {
            if (s.src && s.src.includes('overlay-editor.js') || s.textContent.includes('overlay-editor.js')) s.remove();
        });
        return '<!DOCTYPE html>\n' + clone.outerHTML;
    }

    function triggerExportSuccess(msg) {
        const status = _els.exportStatus;
        if (status) {
            status.innerText = msg;
            status.style.opacity = '1';
            setTimeout(() => status.style.opacity = '0', 2000);
        }
    }

    function _buildSelector(element) {
        if (element.id) return '#' + element.id;
        const classes = [...element.classList].filter(c => !c.startsWith('ai-'));
        if (classes.length > 0) return '.' + classes.join('.');
        return element.tagName.toLowerCase();
    }

    function _exportCSSImpl() {
        const changes = _getChangesImpl();
        if (changes.length === 0) return '/* No changes detected */';
        return changes.map(({ element, currentCssText }) => {
            if (!currentCssText) return '';
            const selector = _buildSelector(element);
            return `${selector} {\n  ${currentCssText.split(';').filter(s=>s.trim()).join(';\n  ')};\n}`;
        }).filter(Boolean).join('\n\n');
    }

    function _exportReactImpl() {
        const changes = _getChangesImpl();
        if (changes.length === 0) return '// No changes detected';
        return changes.map(({ element, currentCssText }) => {
            const selector = _buildSelector(element);
            const styleObj = currentCssText.split(';')
                .filter(s => s.trim() && s.includes(':'))
                .map(rule => {
                    const [prop, ...rest] = rule.split(':');
                    const key = prop.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                    return `  ${key}: "${rest.join(':').trim()}"`;
                }).join(',\n');
            return `// ${selector}\nconst style = {\n${styleObj}\n};`;
        }).join('\n\n');
    }

    const _TAILWIND_MAP = {
        'font-weight': { '700': 'font-bold', '600': 'font-semibold', '500': 'font-medium', '400': 'font-normal', '300': 'font-light' },
        'text-align':  { 'left': 'text-left', 'center': 'text-center', 'right': 'text-right' },
        'text-transform': { 'uppercase': 'uppercase', 'lowercase': 'lowercase', 'capitalize': 'capitalize' },
        'border-radius': { '9999px': 'rounded-full', '8px': 'rounded-lg', '4px': 'rounded', '0px': 'rounded-none' },
        'opacity': { '0': 'opacity-0', '0.5': 'opacity-50', '0.75': 'opacity-75', '1': 'opacity-100' },
        'display': { 'flex': 'flex', 'grid': 'grid', 'block': 'block', 'inline': 'inline', 'none': 'hidden' }
    };

    function _exportTailwindImpl() {
        const changes = _getChangesImpl();
        if (changes.length === 0) return '<!-- No changes detected -->';
        return changes.map(({ element, currentCssText }) => {
            const selector = _buildSelector(element);
            const classes = [];
            const unmapped = [];
            currentCssText.split(';').filter(s => s.trim() && s.includes(':')).forEach(rule => {
                const [prop, ...rest] = rule.split(':');
                const key = prop.trim();
                const val = rest.join(':').trim();
                const map = _TAILWIND_MAP[key];
                if (map && map[val]) classes.push(map[val]);
                else unmapped.push(`${key}: ${val}`);
            });
            const unmappedNote = unmapped.length
                ? `\n  /* Unmapped: ${unmapped.join('; ')} */`
                : '';
            return `/* ${selector} */\nclassName="${classes.join(' ')}"${unmappedNote}`;
        }).join('\n\n');
    }

    // ─── SVG Icons ───────────────────────────────────────────────────────────
    const icons = {
        sparkle: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"></path></svg>`,
        hide: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>`,
        show: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>`,
        bold: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 12h9a4 4 0 014 4 4 4 0 01-4 4H6z"></path></svg>`,
        italic: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 8m-8-8l-4 8"></path></svg>`,
        alignLeft: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h10M4 18h16"></path></svg>`,
        alignCenter: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M7 12h10M4 18h16"></path></svg>`,
        alignRight: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M10 12h10M4 18h16"></path></svg>`
    };

    const colors = ['#f8fafc', '#94a3b8', '#a855f7', '#3b82f6', '#10b981', '#f43f5e', '#eab308', '#000000'];
    const gradients = [
        'linear-gradient(135deg, #a855f7, #ec4899, #f43f5e)',
        'linear-gradient(135deg, #3b82f6, #06b6d4, #10b981)',
        'linear-gradient(135deg, #f59e0b, #f43f5e)',
        'linear-gradient(135deg, #1e293b, #0f172a)',
        'linear-gradient(135deg, #6366f1, #a855f7)',
        'linear-gradient(45deg, #ff9a9e 0%, #fecfef 99%, #fecfef 100%)',
        'linear-gradient(120deg, #84fab0 0%, #8fd3f4 100%)',
        'linear-gradient(to right, #43e97b 0%, #38f9d7 100%)',
        'linear-gradient(to top, #30cfd0 0%, #330867 100%)',
        'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        'radial-gradient(circle 248px at center, #16d9e3 0%, #30c7ec 47%, #46aef7 100%)',
        'linear-gradient(to right, #ff758c 0%, #ff7eb3 100%)',
        'linear-gradient(to right, #00c6ff, #0072ff)',
        'radial-gradient(circle, #ff00cc, #333399)',
        'linear-gradient(to right, #11998e, #38ef7d)',
        'linear-gradient(45deg, #243B55, #141E30)'
    ];
    const sizes = [{l: 'S', v: '0.875em'}, {l: 'M', v: '1em'}, {l: 'L', v: '1.25em'}, {l: 'XL', v: '1.5em'}, {l: '2X', v: '2em'}];

    // ─── Feature 9: Keyboard Shortcut Data ──────────────────────────────────
    const _SHORTCUTS = [
        { keys: 'Ctrl+Z', desc: 'Undo' },
        { keys: 'Ctrl+Shift+Z', desc: 'Redo' },
        { keys: 'Ctrl+\\', desc: 'Toggle sidebar' },
        { keys: 'Escape', desc: 'Deselect / Page mode' },
        { keys: '1–4', desc: 'Switch visible tabs' },
        { keys: 'Shift+Click', desc: 'Batch select elements' },
        { keys: 'Ctrl+Shift+C', desc: 'Copy element style' },
        { keys: 'Ctrl+Shift+V', desc: 'Paste element style' },
        { keys: '?', desc: 'Show this shortcut overlay' }
    ];

    function _showShortcutOverlay() {
        if (_shortcutOverlay) return;
        _shortcutOverlay = document.createElement('div');
        _shortcutOverlay.id = 'ai-shortcut-overlay';
        _shortcutOverlay.innerHTML = `
            <div class="ai-shortcut-modal">
                <h3>Keyboard Shortcuts</h3>
                ${_SHORTCUTS.map(s => `<div class="ai-shortcut-row">
                    <span class="ai-shortcut-desc">${s.desc}</span>
                    <span class="ai-shortcut-keys">${s.keys}</span>
                </div>`).join('')}
            </div>`;
        document.body.appendChild(_shortcutOverlay);
        const close = (e) => {
            if (e.key === 'Escape' || e.target === _shortcutOverlay) {
                _hideShortcutOverlay();
                document.removeEventListener('keydown', close);
                _shortcutOverlay?.removeEventListener('click', close);
            }
        };
        document.addEventListener('keydown', close);
        _shortcutOverlay.addEventListener('click', close);
    }

    function _hideShortcutOverlay() {
        if (_shortcutOverlay) {
            _shortcutOverlay.remove();
            _shortcutOverlay = null;
        }
    }

    // ─── Feature 6: Spacing Visualizer ───────────────────────────────────────
    function _createSpacingOverlay() {
        if (_spacingOverlay) return;
        _spacingOverlay = document.createElement('div');
        _spacingOverlay.id = 'ai-spacing-overlay';
        _spacingOverlay.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:999998;';
        for (let i = 0; i < 8; i++) {
            _spacingOverlay.appendChild(document.createElement('div'));
        }
        document.body.appendChild(_spacingOverlay);
        _spacingScrollHandler = _raf(_updateSpacingOverlay);
        _spacingResizeHandler = _raf(_updateSpacingOverlay);
        window.addEventListener('scroll', _spacingScrollHandler, true);
        window.addEventListener('resize', _spacingResizeHandler);
    }

    function _destroySpacingOverlay() {
        if (_spacingOverlay) {
            _spacingOverlay.remove();
            _spacingOverlay = null;
        }
        if (_spacingScrollHandler) {
            window.removeEventListener('scroll', _spacingScrollHandler, true);
            _spacingScrollHandler = null;
        }
        if (_spacingResizeHandler) {
            window.removeEventListener('resize', _spacingResizeHandler);
            _spacingResizeHandler = null;
        }
        _spacingVisible = false;
        if (_els.spacingVizBtn) _els.spacingVizBtn.textContent = 'Show Spacing';
    }

    function _updateSpacingOverlay() {
        if (!_spacingOverlay || !_spacingVisible) return;
        const t = targetScope === 'page' ? document.body : activeElement;
        if (!t || t === document.body) {
            [..._spacingOverlay.children].forEach(s => s.style.display = 'none');
            return;
        }
        const rect = t.getBoundingClientRect();
        const comp = getComputedStyle(t);
        const pt = parseFloat(comp.paddingTop) || 0;
        const pr = parseFloat(comp.paddingRight) || 0;
        const pb = parseFloat(comp.paddingBottom) || 0;
        const pl = parseFloat(comp.paddingLeft) || 0;
        const mt = parseFloat(comp.marginTop) || 0;
        const mr = parseFloat(comp.marginRight) || 0;
        const mb = parseFloat(comp.marginBottom) || 0;
        const ml = parseFloat(comp.marginLeft) || 0;
        const s = _spacingOverlay.children;
        // Padding (green)
        s[0].style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${pt}px;background:rgba(16,185,129,0.3);pointer-events:none;`;
        s[1].style.cssText = `position:fixed;top:${rect.top}px;left:${rect.right-pr}px;width:${pr}px;height:${rect.height}px;background:rgba(16,185,129,0.3);pointer-events:none;`;
        s[2].style.cssText = `position:fixed;top:${rect.bottom-pb}px;left:${rect.left}px;width:${rect.width}px;height:${pb}px;background:rgba(16,185,129,0.3);pointer-events:none;`;
        s[3].style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${pl}px;height:${rect.height}px;background:rgba(16,185,129,0.3);pointer-events:none;`;
        // Margin (blue)
        s[4].style.cssText = `position:fixed;top:${rect.top-mt}px;left:${rect.left-ml}px;width:${rect.width+ml+mr}px;height:${mt}px;background:rgba(59,130,246,0.3);pointer-events:none;`;
        s[5].style.cssText = `position:fixed;top:${rect.top}px;left:${rect.right}px;width:${mr}px;height:${rect.height}px;background:rgba(59,130,246,0.3);pointer-events:none;`;
        s[6].style.cssText = `position:fixed;top:${rect.bottom}px;left:${rect.left-ml}px;width:${rect.width+ml+mr}px;height:${mb}px;background:rgba(59,130,246,0.3);pointer-events:none;`;
        s[7].style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left-ml}px;width:${ml}px;height:${rect.height}px;background:rgba(59,130,246,0.3);pointer-events:none;`;
    }

    // ─── Build Sidebar DOM ───────────────────────────────────────────────────
    function buildUIString() {
        const genColorHTML = (list, clz) => list.map(c => `<div class="${clz}" data-val="${c}" style="background: ${c};" aria-label="Apply color ${c}"></div>`).join('');

        return `
            <button id="ai-show-sidebar-btn" title="Show Designer" aria-label="Show sidebar">${icons.show}</button>

            <!-- Top Bar with Targeting & Hide Toggle -->
            <div class="ai-editor-top-bar">
                <div class="ai-editor-title-row">
                    <div class="ai-editor-title">
                        ${icons.sparkle} Glass Studio
                        <span id="ai-batch-badge" class="ai-batch-badge" style="display:none;"></span>
                    </div>
                    <button class="ai-editor-hide-btn" id="ai-btn-hide-sidebar" title="Hide Sidebar" aria-label="Hide sidebar">
                        ${icons.hide}
                    </button>
                </div>

                <!-- Target Selector -->
                <div class="ai-scope-toggle">
                    <button class="ai-scope-btn" data-scope="element" aria-label="Target element">Target: Element</button>
                    <button class="ai-scope-btn active" data-scope="page" aria-label="Target page">Target: Page</button>
                </div>
            </div>

            <!-- Tabs -->
            <div class="ai-editor-tabs-header">
                <button class="ai-tab-btn" data-tab="tab-text" id="ai-nav-text" aria-label="Text tab">Global Text</button>
                <button class="ai-tab-btn active" data-tab="tab-layout" id="ai-nav-layout" aria-label="Layout tab">Page Layout</button>
                <button class="ai-tab-btn" data-tab="tab-effects" id="ai-nav-effects" aria-label="Effects tab">Page Effects</button>
                <button class="ai-tab-btn" data-tab="tab-ai" id="ai-nav-ai" style="display: none;" aria-label="AI tab">AI</button>
                <button class="ai-tab-btn" data-tab="tab-tree" id="ai-nav-tree" aria-label="Inspect tab">Tree</button>
            </div>

            <!-- 1. TEXT TAB -->
            <div class="ai-tab-content" id="tab-text">
                <div class="ai-panel-section">
                    <div class="ai-section-title">Font Engine</div>

                    <select class="ai-select" id="ai-font-family" style="margin-bottom: 8px;" aria-label="Font family">
                        <option value="inherit">Default Font</option>
                        <option value="'Inter', sans-serif">Sans Serif</option>
                        <option value="Georgia, serif">Serif</option>
                        <option value="monospace">Monospace</option>
                    </select>

                    <div class="ai-panel-section side-by-side" style="margin-bottom: 8px;">
                        <select class="ai-select" id="ai-font-weight" aria-label="Font weight">
                            <option value="inherit">Weight</option>
                            <option value="300">Light</option>
                            <option value="400">Normal</option>
                            <option value="600">Semibold</option>
                            <option value="700">Bold</option>
                            <option value="900">Black</option>
                        </select>
                        <div class="ai-color-picker-wrapper" title="Custom Text Color">
                            <input type="color" id="ai-custom-text" class="ai-color-picker-input" aria-label="Custom text color">
                        </div>
                    </div>

                    <div class="ai-editor-toolbar-row">
                        <div class="ai-editor-toolbar-group">
                            <button class="ai-editor-btn" id="ai-cmd-bold" title="Bold" aria-label="Bold">${icons.bold}</button>
                            <button class="ai-editor-btn" id="ai-cmd-italic" title="Italic" aria-label="Italic">${icons.italic}</button>
                        </div>
                        <div class="ai-editor-toolbar-group">
                            <button class="ai-editor-btn" id="ai-cmd-justifyLeft" title="Align Left" aria-label="Align left">${icons.alignLeft}</button>
                            <button class="ai-editor-btn" id="ai-cmd-justifyCenter" title="Align Center" aria-label="Align center">${icons.alignCenter}</button>
                            <button class="ai-editor-btn" id="ai-cmd-justifyRight" title="Align Right" aria-label="Align right">${icons.alignRight}</button>
                        </div>
                    </div>
                </div>

                <div class="ai-panel-section">
                    <div class="ai-section-title">Text Transform</div>
                    <div class="ai-editor-toolbar-row">
                        <div class="ai-editor-toolbar-group" style="width: 100%; display: flex;">
                            <button class="ai-editor-btn text-btn" id="ai-tt-none" style="flex:1;" aria-label="No text transform">Abc</button>
                            <button class="ai-editor-btn text-btn" id="ai-tt-upper" style="flex:1;" aria-label="Uppercase">ABC</button>
                            <button class="ai-editor-btn text-btn" id="ai-tt-lower" style="flex:1;" aria-label="Lowercase">abc</button>
                        </div>
                    </div>
                </div>

                <div class="ai-panel-section">
                    <div class="ai-section-title">Typography Spacing</div>
                    <div class="ai-slider-container">
                        <div class="ai-slider-header"><span>Letter Spacing</span><span class="ai-slider-val" id="ai-val-tracking">0px</span></div>
                        <input type="range" class="ai-slider" id="ai-slider-tracking" min="-5" max="20" step="0.5" value="0" aria-label="Letter spacing">
                    </div>
                    <div class="ai-slider-container">
                        <div class="ai-slider-header"><span>Line Height</span><span class="ai-slider-val" id="ai-val-leading">1.5</span></div>
                        <input type="range" class="ai-slider" id="ai-slider-leading" min="0.5" max="3" step="0.1" value="1.5" aria-label="Line height">
                    </div>
                </div>

                <div class="ai-panel-section">
                    <div class="ai-section-title">Quick Size Tokens</div>
                    <div class="ai-editor-toolbar-row">
                        <div class="ai-editor-toolbar-group" style="width: 100%; display: flex; justify-content: space-between;">
                            ${sizes.map(s => `<button class="ai-editor-btn ai-size-btn" style="flex:1;" data-val="${s.v}" aria-label="Font size ${s.l}">${s.l}</button>`).join('')}
                        </div>
                    </div>
                </div>

                <!-- WCAG Contrast Checker -->
                <div class="ai-panel-section" id="ai-contrast-checker">
                    <div class="ai-section-title">Contrast Checker</div>
                    <div class="ai-contrast-display">
                        <span class="ai-contrast-ratio" id="ai-contrast-ratio">&mdash;</span>
                        <div class="ai-contrast-badges">
                            <span class="ai-badge" id="ai-badge-aa">AA</span>
                            <span class="ai-badge" id="ai-badge-aaa">AAA</span>
                        </div>
                    </div>
                    <div style="font-size: 10px; color: rgba(255,255,255,0.4); margin-top: 4px;">
                        Text color vs. background color (WCAG 2.0)
                    </div>
                </div>
            </div>

            <!-- 2. LAYOUT TAB -->
            <div class="ai-tab-content active" id="tab-layout">

                <div class="ai-panel-section" id="ai-copy-paste-section">
                    <div class="ai-section-title">Style Transfer</div>
                    <div class="ai-editor-toolbar-row">
                        <div class="ai-editor-toolbar-group" style="width:100%;display:flex;">
                            <button class="ai-editor-btn text-btn" id="ai-btn-copy-style" style="flex:1;" aria-label="Copy style">Copy Style</button>
                            <button class="ai-editor-btn text-btn" id="ai-btn-paste-style" style="flex:1;" aria-label="Paste style">Paste Style</button>
                        </div>
                    </div>
                </div>

                <div class="ai-panel-section" id="ai-image-controls" style="display: none; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <div class="ai-section-title">Image Dimensions</div>
                    <div class="ai-config-wrapper" style="gap: 12px;">
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Width</span><span class="ai-slider-val" id="ai-val-img-width">auto</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-img-width" min="10" max="1000" value="0" aria-label="Image width">
                        </div>
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Height</span><span class="ai-slider-val" id="ai-val-img-height">auto</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-img-height" min="10" max="1000" value="0" aria-label="Image height">
                        </div>
                         <button class="ai-secondary-action-btn" id="ai-btn-img-reset" style="padding: 4px; font-size: 10px;" aria-label="Reset image to original proportions">Reset Original Proportions</button>
                    </div>
                </div>

                <div class="ai-panel-section" id="ai-text-layout-controls">
                    <div class="ai-section-title">Spacing & Geometry</div>

                    <div class="ai-slider-container">
                        <div class="ai-slider-header"><span>Padding</span><span class="ai-slider-val" id="ai-val-pad">0px</span></div>
                        <input type="range" class="ai-slider" id="ai-slider-pad" min="0" max="100" value="0" aria-label="Padding">
                    </div>
                </div>

                 <div class="ai-panel-section">
                    <div class="ai-slider-container">
                        <div class="ai-slider-header"><span>Margin</span><span class="ai-slider-val" id="ai-val-marg">0px</span></div>
                        <input type="range" class="ai-slider" id="ai-slider-marg" min="0" max="100" value="0" aria-label="Margin">
                    </div>

                    <div class="ai-slider-container">
                        <div class="ai-slider-header"><span>Border Radius</span><span class="ai-slider-val" id="ai-val-rad">0px</span></div>
                        <input type="range" class="ai-slider" id="ai-slider-rad" min="0" max="100" value="0" aria-label="Border radius">
                    </div>
                </div>

                <div class="ai-panel-section" style="margin-top: 12px;">
                    <div class="ai-section-title">Borders</div>
                    <div class="ai-config-wrapper">
                        <select class="ai-select" id="ai-border-style" style="flex: 1; min-width: 100px;" aria-label="Border style">
                            <option value="none">No Border</option>
                            <option value="solid">Solid</option>
                            <option value="dashed">Dashed</option>
                            <option value="dotted">Dotted</option>
                        </select>
                        <div class="ai-color-picker-wrapper" title="Border Color" style="margin-top: 2px;">
                            <input type="color" id="ai-border-color" class="ai-color-picker-input" value="#38bdf8" aria-label="Border color">
                        </div>
                        <div class="ai-slider-container side" style="margin-top: 8px;">
                            <div class="ai-slider-header"><span>Border Width</span><span class="ai-slider-val" id="ai-val-bwidth">0px</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-bwidth" min="0" max="20" value="0" aria-label="Border width">
                        </div>
                    </div>
                </div>

                <div class="ai-panel-section" id="ai-flexgrid-controls" style="display:none; margin-top:12px;">
                    <div class="ai-section-title">Flex / Grid Layout</div>
                    <div class="ai-editor-toolbar-row" style="margin-bottom:8px;">
                        <div class="ai-editor-toolbar-group" style="width:100%;display:flex;">
                            <button class="ai-editor-btn text-btn ai-display-btn" data-val="flex" style="flex:1;" aria-label="Display flex">Flex</button>
                            <button class="ai-editor-btn text-btn ai-display-btn" data-val="grid" style="flex:1;" aria-label="Display grid">Grid</button>
                            <button class="ai-editor-btn text-btn ai-display-btn" data-val="block" style="flex:1;" aria-label="Display block">Block</button>
                        </div>
                    </div>
                    <select class="ai-select" id="ai-flex-direction" style="margin-bottom:6px;" aria-label="Flex direction">
                        <option value="row">Direction: Row</option>
                        <option value="column">Direction: Column</option>
                        <option value="row-reverse">Row Reverse</option>
                        <option value="column-reverse">Column Reverse</option>
                    </select>
                    <select class="ai-select" id="ai-justify-content" style="margin-bottom:6px;" aria-label="Justify content">
                        <option value="flex-start">Justify: Start</option>
                        <option value="center">Justify: Center</option>
                        <option value="flex-end">Justify: End</option>
                        <option value="space-between">Justify: Between</option>
                        <option value="space-around">Justify: Around</option>
                        <option value="space-evenly">Justify: Evenly</option>
                    </select>
                    <select class="ai-select" id="ai-align-items" style="margin-bottom:6px;" aria-label="Align items">
                        <option value="stretch">Align: Stretch</option>
                        <option value="flex-start">Align: Start</option>
                        <option value="center">Align: Center</option>
                        <option value="flex-end">Align: End</option>
                        <option value="baseline">Align: Baseline</option>
                    </select>
                    <div class="ai-slider-container">
                        <div class="ai-slider-header"><span>Gap</span><span class="ai-slider-val" id="ai-val-gap">0px</span></div>
                        <input type="range" class="ai-slider" id="ai-slider-gap" min="0" max="60" value="0" aria-label="Gap">
                    </div>
                    <div class="ai-editor-toolbar-row" style="margin-top:4px;">
                        <div class="ai-editor-toolbar-group" style="width:100%;display:flex;">
                            <button class="ai-editor-btn text-btn" id="ai-flex-wrap-btn" style="flex:1;" aria-label="Toggle wrap">Wrap: Off</button>
                        </div>
                    </div>
                </div>

                <div class="ai-panel-section" style="margin-top:8px;">
                    <button class="ai-secondary-action-btn" id="ai-btn-spacing-viz" style="padding:6px;font-size:11px;" aria-label="Toggle spacing visualizer">Show Spacing</button>
                </div>
            </div>

            <!-- 3. EFFECTS TAB -->
            <div class="ai-tab-content" id="tab-effects">

                <div class="ai-panel-section" id="ai-image-filters-controls" style="display: none; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <div class="ai-section-title">Optical Filters (Image)</div>
                    <div class="ai-config-wrapper" style="gap: 12px;">
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Grayscale</span><span class="ai-slider-val" id="ai-val-fil-gray">0%</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-fil-gray" min="0" max="100" value="0" aria-label="Grayscale filter">
                        </div>
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Sepia</span><span class="ai-slider-val" id="ai-val-fil-sepia">0%</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-fil-sepia" min="0" max="100" value="0" aria-label="Sepia filter">
                        </div>
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Blur</span><span class="ai-slider-val" id="ai-val-fil-blur">0px</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-fil-blur" min="0" max="20" value="0" aria-label="Blur filter">
                        </div>
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Brightness</span><span class="ai-slider-val" id="ai-val-fil-bright">100%</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-fil-bright" min="0" max="200" value="100" aria-label="Brightness filter">
                        </div>
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Contrast</span><span class="ai-slider-val" id="ai-val-fil-cont">100%</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-fil-cont" min="0" max="200" value="100" aria-label="Contrast filter">
                        </div>
                    </div>
                </div>

                <div class="ai-panel-section">
                    <div class="ai-section-title">Global Opacity</div>
                    <div class="ai-slider-container">
                        <div class="ai-slider-header"><span>Visibility</span><span class="ai-slider-val" id="ai-val-opacity">100%</span></div>
                        <input type="range" class="ai-slider" id="ai-slider-opacity" min="0" max="1" step="0.05" value="1" aria-label="Opacity">
                    </div>
                </div>

                <div class="ai-panel-section" id="ai-text-effects-controls">
                    <div class="ai-section-title">Color Fills</div>
                    <div class="ai-swatch-grid">
                        ${genColorHTML(colors, 'ai-color-swatch ai-bg-color')}
                        <div class="ai-color-picker-wrapper" title="Custom BG Color">
                            <input type="color" id="ai-custom-bg" class="ai-color-picker-input" aria-label="Custom background color">
                        </div>
                    </div>

                    <div class="ai-section-title" style="margin-top: 12px;">Gradient Fills</div>
                    <div class="ai-swatch-grid" style="grid-template-columns: repeat(2, 1fr);">
                        ${gradients.map(c => `<div class="ai-gradient-swatch" data-val="${c}" style="background: ${c}; width: 100%; border-radius: 6px;" aria-label="Apply gradient"></div>`).join('')}
                    </div>

                    <div class="ai-section-title" style="margin-top:12px;">Custom Gradient</div>
                    <div class="ai-config-wrapper" style="gap:10px;">
                        <div class="ai-slider-container">
                            <div class="ai-slider-header"><span>Angle</span><span class="ai-slider-val" id="ai-val-grad-angle">135&deg;</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-grad-angle" min="0" max="360" value="135" aria-label="Gradient angle">
                        </div>
                        <div style="display:flex;gap:8px;align-items:center;width:100%;">
                            <div class="ai-color-picker-wrapper" title="Start Color">
                                <input type="color" id="ai-grad-start" class="ai-color-picker-input" value="#a855f7" aria-label="Gradient start">
                            </div>
                            <div style="flex:1;height:24px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);" id="ai-grad-preview"></div>
                            <div class="ai-color-picker-wrapper" title="End Color">
                                <input type="color" id="ai-grad-end" class="ai-color-picker-input" value="#ec4899" aria-label="Gradient end">
                            </div>
                        </div>
                        <button class="ai-secondary-action-btn" id="ai-btn-apply-gradient" style="padding:6px;font-size:11px;" aria-label="Apply gradient">Apply Gradient</button>
                    </div>

                    <div class="ai-section-title" style="margin-top:12px;">Text Shadow Engine</div>
                    <div class="ai-config-wrapper" id="ai-text-shadow-controls" style="gap:12px;">
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>X Offset</span><span class="ai-slider-val" id="ai-val-ts-x">0px</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-ts-x" min="-20" max="20" value="0" aria-label="Text shadow X">
                        </div>
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Y Offset</span><span class="ai-slider-val" id="ai-val-ts-y">0px</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-ts-y" min="-20" max="20" value="0" aria-label="Text shadow Y">
                        </div>
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Blur</span><span class="ai-slider-val" id="ai-val-ts-blur">0px</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-ts-blur" min="0" max="30" value="0" aria-label="Text shadow blur">
                        </div>
                        <div class="ai-color-picker-wrapper" title="Text Shadow Color" style="margin-top:4px;">
                            <input type="color" id="ai-ts-color" class="ai-color-picker-input" value="#000000" aria-label="Text shadow color">
                        </div>
                    </div>

                    <div class="ai-section-title" style="margin-top:12px;">Hover Transition Builder</div>
                    <div class="ai-config-wrapper" id="ai-transition-controls" style="gap:10px;">
                        <select class="ai-select" id="ai-transition-prop" aria-label="Transition property">
                            <option value="all">Property: All</option>
                            <option value="transform">Transform</option>
                            <option value="opacity">Opacity</option>
                            <option value="background">Background</option>
                            <option value="color">Color</option>
                            <option value="box-shadow">Box Shadow</option>
                        </select>
                        <div class="ai-slider-container">
                            <div class="ai-slider-header"><span>Duration</span><span class="ai-slider-val" id="ai-val-transition-dur">0.3s</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-transition-dur" min="0" max="2" step="0.05" value="0.3" aria-label="Duration">
                        </div>
                        <select class="ai-select" id="ai-transition-ease" aria-label="Easing">
                            <option value="ease">Easing: Ease</option>
                            <option value="ease-in">Ease In</option>
                            <option value="ease-out">Ease Out</option>
                            <option value="ease-in-out">Ease In-Out</option>
                            <option value="linear">Linear</option>
                            <option value="cubic-bezier(0.16, 1, 0.3, 1)">Spring</option>
                        </select>
                        <div class="ai-slider-container">
                            <div class="ai-slider-header"><span>Hover Scale</span><span class="ai-slider-val" id="ai-val-hover-scale">1.0</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-hover-scale" min="0.5" max="1.5" step="0.05" value="1" aria-label="Hover scale">
                        </div>
                        <div style="display:flex;gap:6px;width:100%;">
                            <button class="ai-secondary-action-btn" id="ai-btn-apply-transition" style="flex:1;padding:6px;font-size:11px;" aria-label="Apply transition">Apply</button>
                            <button class="ai-secondary-action-btn" id="ai-btn-preview-transition" style="flex:1;padding:6px;font-size:11px;" aria-label="Preview">Preview</button>
                        </div>
                    </div>
                </div>

                <div class="ai-panel-section" style="margin-top: 12px;">
                    <div class="ai-section-title">Drop Shadow Engine</div>
                    <div class="ai-config-wrapper" style="gap: 12px;">
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Y Offset</span><span class="ai-slider-val" id="ai-val-sh-y">0px</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-sh-y" min="-20" max="50" value="0" aria-label="Shadow Y offset">
                        </div>
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Blur</span><span class="ai-slider-val" id="ai-val-sh-blur">0px</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-sh-blur" min="0" max="100" value="0" aria-label="Shadow blur">
                        </div>
                        <div class="ai-slider-container side">
                            <div class="ai-slider-header"><span>Alpha</span><span class="ai-slider-val" id="ai-val-sh-alpha">0%</span></div>
                            <input type="range" class="ai-slider" id="ai-slider-sh-alpha" min="0" max="1" step="0.05" value="0" aria-label="Shadow opacity">
                        </div>
                    </div>
                </div>
            </div>

            <!-- 4. AI & PRESETS TAB -->
            <div class="ai-tab-content" id="tab-ai">
                <div class="ai-panel-section" id="ai-ai-rewrite-box">
                    <div class="ai-section-title">AI Actions</div>
                    <button class="ai-primary-action-btn" id="ai-btn-rewrite" style="font-size: 11px; padding: 6px; width: 80%; background: none; border: 1px solid var(--ai-editor-primary); color: var(--ai-editor-primary); box-shadow: none;" aria-label="AI rewrite selection">
                        ${icons.sparkle} Rewrite Selection
                    </button>
                    <div style="font-size: 10px; color: rgba(255,255,255,0.4); text-align: center; margin-top: 8px;">Target an element to rewrite it directly.</div>
                </div>

                <hr style="border:0; border-top: 1px solid rgba(255,255,255,0.05); margin: 8px 0;" />

                <div class="ai-panel-section">
                    <div class="ai-section-title">My Presets</div>
                    <div class="ai-preset-categories" id="ai-preset-categories">
                        <button class="ai-preset-cat-btn active" data-cat="all">All</button>
                        <button class="ai-preset-cat-btn" data-cat="Buttons">Buttons</button>
                        <button class="ai-preset-cat-btn" data-cat="Cards">Cards</button>
                        <button class="ai-preset-cat-btn" data-cat="Typography">Type</button>
                        <button class="ai-preset-cat-btn" data-cat="Custom">Custom</button>
                    </div>
                    <div style="display:flex;gap:6px;margin-bottom:8px;">
                        <select class="ai-select" id="ai-preset-cat-select" style="flex:1;" aria-label="Preset category">
                            <option value="Buttons">Buttons</option>
                            <option value="Cards">Cards</option>
                            <option value="Typography">Typography</option>
                            <option value="Custom">Custom</option>
                        </select>
                        <button class="ai-secondary-action-btn" id="ai-btn-save-preset" style="flex:1;padding:6px;font-size:11px;" aria-label="Save preset">+ Save</button>
                    </div>
                    <button class="ai-secondary-action-btn" id="ai-btn-clear-presets" style="padding:4px;font-size:10px;color:#f43f5e;border-color:rgba(244,63,94,0.3);" aria-label="Delete all presets">
                        Clear All Presets
                    </button>
                    <div class="ai-presets-grid" id="ai-presets-box"></div>
                </div>
            </div>

            <!-- 5. ELEMENT TREE TAB -->
            <div class="ai-tab-content" id="tab-tree">
                <div class="ai-panel-section">
                    <div class="ai-section-title">Element Tree</div>
                    <div id="ai-element-tree" class="ai-element-tree"></div>
                </div>
                <div class="ai-panel-section" style="margin-top: 12px;">
                    <div class="ai-section-title">Live CSS</div>
                    <textarea class="ai-code-editor" id="ai-css-editor" rows="8" spellcheck="false" placeholder="Select an element to view its inline styles..." aria-label="Live CSS editor"></textarea>
                    <button class="ai-secondary-action-btn" id="ai-btn-apply-css" style="font-size: 10px; padding: 4px;" aria-label="Apply CSS from editor to element">
                        Apply CSS
                    </button>
                </div>
                <div class="ai-panel-section" style="margin-top:12px;">
                    <div class="ai-section-title">Edit History</div>
                    <div id="ai-history-list" class="ai-element-tree" style="max-height:200px;"></div>
                </div>
            </div>

            <div class="ai-editor-loading-overlay" id="ai-editor-loading">
                <div class="ai-spinner"></div>
            </div>

            <!-- Responsive Preview -->
            <div class="ai-responsive-bar" id="ai-responsive-bar">
                <button class="ai-responsive-btn" data-width="375" aria-label="Mobile preview">Mobile</button>
                <button class="ai-responsive-btn" data-width="768" aria-label="Tablet preview">Tablet</button>
                <button class="ai-responsive-btn" data-width="100%" aria-label="Desktop preview">Desktop</button>
                <span class="ai-responsive-label" id="ai-responsive-label"></span>
            </div>

            <!-- Export Footer with Multi-Format -->
            <div class="ai-export-footer">
                <button id="ai-btn-copy-html" class="ai-button ai-primary-btn" style="width: 100%; margin-bottom: 8px;" aria-label="Copy exported code to clipboard">Copy Code</button>
                <div class="ai-export-format-row">
                    <button class="ai-button ai-secondary-action-btn ai-export-format-active" data-format="html" aria-label="Export as HTML">HTML</button>
                    <button class="ai-button ai-secondary-action-btn" data-format="css" aria-label="Export as CSS">CSS</button>
                    <button class="ai-button ai-secondary-action-btn" data-format="react" aria-label="Export as React JSX">React</button>
                    <button class="ai-button ai-secondary-action-btn" data-format="tailwind" aria-label="Export as Tailwind">Tailwind</button>
                </div>
                <button id="ai-btn-download-html" class="ai-button ai-secondary-action-btn" style="width: 100%; margin-top: 4px;" aria-label="Download file">Download</button>
                <div id="ai-export-status" style="font-size: 11px; color: #10b981; text-align: center; margin-top: 8px; opacity: 0; transition: opacity 0.3s; pointer-events: none;">Copied to Clipboard!</div>
            </div>
        `;
    }

    // ─── Setup Logic ─────────────────────────────────────────────────────────
    function injectEditorUI() {
        if (document.getElementById('ai-floating-editor-container')) return;

        // Phase 1 fix: create container explicitly, build HTML once
        editorContainer = document.createElement('div');
        editorContainer.id = 'ai-floating-editor-container';
        editorContainer.innerHTML = buildUIString();
        document.body.appendChild(editorContainer);

        // Extract show button out of container
        showSidebarBtn = editorContainer.querySelector('#ai-show-sidebar-btn');
        if (showSidebarBtn) document.body.appendChild(showSidebarBtn);

        // Apply configured show button position
        if (showSidebarBtn && _config.showBtnPosition) {
            const pos = _config.showBtnPosition;
            if (pos.top) showSidebarBtn.style.top = pos.top;
            if (pos.left) showSidebarBtn.style.left = pos.left;
            if (pos.bottom) { showSidebarBtn.style.bottom = pos.bottom; showSidebarBtn.style.top = 'auto'; }
            if (pos.right) { showSidebarBtn.style.right = pos.right; showSidebarBtn.style.left = 'auto'; }
        }

        // Drag Physics
        const topBar = editorContainer.querySelector('.ai-editor-top-bar');
        let isDragging = false, startX, startY, startLeft, startTop;

        topBar.style.cursor = 'grab';
        topBar.title = "Drag to move Studio";

        _addListener(topBar, 'mousedown', (e) => {
            if (e.target.closest('button')) return;
            isDragging = true;
            topBar.style.cursor = 'grabbing';
            startX = e.clientX;
            startY = e.clientY;
            const rect = editorContainer.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            document.body.style.userSelect = 'none';
        });

        _addListener(document, 'mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            editorContainer.style.left = `${startLeft + dx}px`;
            editorContainer.style.top = `${startTop + dy}px`;
            editorContainer.style.bottom = 'auto';
            editorContainer.style.transform = 'none';
        });

        _addListener(document, 'mouseup', () => {
            if (isDragging) {
                isDragging = false;
                topBar.style.cursor = 'grab';
                document.body.style.userSelect = '';
            }
        });

        // Export: Multi-format
        let _selectedExportFormat = 'html';

        editorContainer.querySelectorAll('[data-format]').forEach(btn => {
            _addListener(btn, 'click', (e) => {
                editorContainer.querySelectorAll('[data-format]').forEach(b => b.classList.remove('ai-export-format-active'));
                e.currentTarget.classList.add('ai-export-format-active');
                _selectedExportFormat = e.currentTarget.dataset.format;
            });
        });

        const btnCopy = document.getElementById('ai-btn-copy-html');
        if (btnCopy) {
            _addListener(btnCopy, 'click', () => {
                let content;
                if (_selectedExportFormat === 'html')     content = exportCleanHTML();
                else if (_selectedExportFormat === 'css')  content = _exportCSSImpl();
                else if (_selectedExportFormat === 'react') content = _exportReactImpl();
                else if (_selectedExportFormat === 'tailwind') content = _exportTailwindImpl();
                else content = exportCleanHTML();

                navigator.clipboard.writeText(content).then(() => {
                    triggerExportSuccess(_selectedExportFormat.toUpperCase() + ' Copied!');
                });
            });
        }

        const btnDownload = document.getElementById('ai-btn-download-html');
        if (btnDownload) {
            _addListener(btnDownload, 'click', () => {
                let content, filename, mimeType;
                if (_selectedExportFormat === 'html') {
                    content = exportCleanHTML();
                    filename = 'designed-page.html';
                    mimeType = 'text/html';
                } else if (_selectedExportFormat === 'css') {
                    content = _exportCSSImpl();
                    filename = 'styles.css';
                    mimeType = 'text/css';
                } else if (_selectedExportFormat === 'react') {
                    content = _exportReactImpl();
                    filename = 'styles.jsx';
                    mimeType = 'text/javascript';
                } else {
                    content = _exportTailwindImpl();
                    filename = 'tailwind-classes.txt';
                    mimeType = 'text/plain';
                }
                const blob = new Blob([content], { type: mimeType });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                triggerExportSuccess('Download Started!');
            });
        }

        // Toggle Sidebar Visibility
        _addListener(document.getElementById('ai-btn-hide-sidebar'), 'click', hideSidebar);
        if (showSidebarBtn) _addListener(showSidebarBtn, 'click', openSidebar);

        // Scope Toggles
        editorContainer.querySelectorAll('.ai-scope-btn').forEach(btn => {
            _addListener(btn, 'click', (e) => {
                editorContainer.querySelectorAll('.ai-scope-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                targetScope = e.currentTarget.dataset.scope;

                if (targetScope === 'page') {
                    document.body.classList.add('ai-page-targeting-active');
                    if (activeElement) {
                        activeElement.removeAttribute('data-editable-active');
                        activeElement.removeAttribute('contenteditable');
                        activeElement = null;
                        _emitter.emit('deselect');
                    }
                    toggleSmartUI('page');
                } else {
                    document.body.classList.remove('ai-page-targeting-active');
                    if (activeElement && activeElement.tagName !== 'IMG') {
                        activeElement.setAttribute('data-editable-active', 'true');
                        activeElement.setAttribute('contenteditable', 'true');
                    }
                }
                syncSlidersToTarget();
            });
        });

        // Tab Switching
        editorContainer.querySelectorAll('.ai-tab-btn').forEach(btn => {
            _addListener(btn, 'click', (e) => {
                editorContainer.querySelectorAll('.ai-tab-btn').forEach(b => b.classList.remove('active'));
                editorContainer.querySelectorAll('.ai-tab-content').forEach(c => c.classList.remove('active'));
                e.currentTarget.classList.add('active');
                const tabEl = document.getElementById(e.currentTarget.dataset.tab);
                if (tabEl) tabEl.classList.add('active');
            });
        });

        const getTarget = () => targetScope === 'page' ? document.body : activeElement;

        // TEXT FORMATTING with undo coverage (Phase 5)
        ['bold', 'italic', 'justifyLeft', 'justifyCenter', 'justifyRight'].forEach(cmd => {
            _addListener(document.getElementById(`ai-cmd-${cmd}`), 'click', () => {
                const t = getTarget();
                pushUndoState(t, cmd);
                if (activeElement && targetScope === 'element' && activeElement.tagName !== 'IMG') {
                    document.execCommand(cmd, false, null); activeElement.focus();
                } else if (targetScope === 'page') {
                    document.body.style.textAlign = cmd.replace('justify', '').toLowerCase();
                }
            });
        });

        // Text Transforms with undo
        _addListener(document.getElementById('ai-tt-none'), 'click', () => { pushUndoState(getTarget(), 'textTransform'); _applyToAllTargets(t => { t.style.textTransform = 'none'; }); });
        _addListener(document.getElementById('ai-tt-upper'), 'click', () => { pushUndoState(getTarget(), 'textTransform'); _applyToAllTargets(t => { t.style.textTransform = 'uppercase'; }); });
        _addListener(document.getElementById('ai-tt-lower'), 'click', () => { pushUndoState(getTarget(), 'textTransform'); _applyToAllTargets(t => { t.style.textTransform = 'lowercase'; }); });

        // Font family/weight with undo
        _addListener(document.getElementById('ai-font-family'), 'change', (e) => {
            pushUndoState(getTarget(), 'fontFamily'); _applyToAllTargets(t => { t.style.fontFamily = e.target.value; });
        });
        _addListener(document.getElementById('ai-font-weight'), 'change', (e) => {
            pushUndoState(getTarget(), 'fontWeight'); _applyToAllTargets(t => { t.style.fontWeight = e.target.value; });
        });

        // Swatches
        const bindSwatches = (selector, cssProp) => {
            editorContainer.querySelectorAll(selector).forEach(sw => {
                _addListener(sw, 'click', (e) => {
                    const t = getTarget(); if (!t) return;
                    pushUndoState(t, cssProp);
                    const val = e.currentTarget.dataset.val;
                    _applyToAllTargets(el => { el.style[cssProp] = val; });
                    _updateContrastBadge();
                });
            });
        };
        bindSwatches('.ai-size-btn', 'fontSize');
        bindSwatches('.ai-text-color', 'color');
        bindSwatches('.ai-bg-color', 'background');
        bindSwatches('.ai-gradient-swatch', 'background');

        // Custom color inputs with undo (fire on change, not input, for better undo grouping)
        const _debouncedContrastBadge = _debounce(() => _updateContrastBadge(), 150);
        _addListener(document.getElementById('ai-custom-text'), 'input', (e) => {
            _applyToAllTargets(t => { t.style.color = e.target.value; });
            _debouncedContrastBadge();
        });
        _addListener(document.getElementById('ai-custom-text'), 'change', (e) => {
            pushUndoState(getTarget(), 'color');
            _applyToAllTargets(t => { t.style.color = e.target.value; });
            _updateContrastBadge();
        });
        _addListener(document.getElementById('ai-custom-bg'), 'input', (e) => {
            _applyToAllTargets(t => { t.style.background = e.target.value; });
            _debouncedContrastBadge();
        });
        _addListener(document.getElementById('ai-custom-bg'), 'change', (e) => {
            pushUndoState(getTarget(), 'background');
            _applyToAllTargets(t => { t.style.background = e.target.value; });
            _updateContrastBadge();
        });

        // Slider Boilerplate with Phase 1 opacity fix
        const bindSlider = (id, prop, suffix='px', multiplier=1, defaultVal=0) => {
            const slider = document.getElementById(`ai-slider-${id}`);
            const valTag = document.getElementById(`ai-val-${id}`);
            if(!slider) return;
            _addListener(slider, 'mousedown', () => pushUndoState(getTarget(), prop));
            _addListener(slider, 'input', (e) => {
                const v = (e.target.value * multiplier) + suffix;
                if (prop !== 'none') _applyToAllTargets(t => { t.style[prop] = v; });
                if (id === 'opacity') {
                    valTag.innerText = Math.round(e.target.value * 100) + '%';
                } else {
                    valTag.innerText = e.target.value + suffix;
                }
                if(id.startsWith('sh-')) applyShadowFromSliders();
                if(id.startsWith('fil-')) applyFiltersFromSliders();
                if(id.startsWith('ts-')) applyTextShadowFromSliders();
            });

            // Double-click reset
            const header = slider.parentElement.querySelector('.ai-slider-header');
            if(header) {
                _addListener(header, 'dblclick', () => {
                    const t = getTarget();
                    slider.value = defaultVal;
                    if(t) {
                        const v = (defaultVal * multiplier) + suffix;
                        if(prop !== 'none') t.style[prop] = defaultVal === 0 && suffix === 'px' ? '' : v;
                        if(id.startsWith('sh-')) applyShadowFromSliders();
                        if(id.startsWith('fil-')) applyFiltersFromSliders();
                    }
                    if (id === 'opacity') {
                        valTag.innerText = Math.round(defaultVal * 100) + '%';
                    } else {
                        valTag.innerText = defaultVal + suffix;
                    }
                });
                header.style.cursor = 'pointer';
                header.title = 'Double-click to return to default';
            }
        };

        // Layout Sliders
        bindSlider('pad', 'padding');
        bindSlider('marg', 'margin');
        bindSlider('rad', 'borderRadius');
        bindSlider('bwidth', 'borderWidth');
        bindSlider('opacity', 'opacity', '', 1, 1);
        // No second listener for opacity — Phase 1 fix merged into bindSlider

        // Typography Sliders
        bindSlider('tracking', 'letterSpacing');
        bindSlider('leading', 'lineHeight', '', 1, 1.5);

        // Image Sliders
        bindSlider('img-width', 'width');
        bindSlider('img-height', 'height');

        _addListener(document.getElementById('ai-btn-img-reset'), 'click', () => {
            if(activeElement && activeElement.tagName === 'IMG') {
                pushUndoState(activeElement, 'width');
                activeElement.style.width = 'auto';
                activeElement.style.height = 'auto';
                if (_els.sliderImgW) _els.sliderImgW.value = 0;
                if (_els.sliderImgH) _els.sliderImgH.value = 0;
                if (_els.valImgW) _els.valImgW.innerText = 'auto';
                if (_els.valImgH) _els.valImgH.innerText = 'auto';
            }
        });

        // Image Filters Compositor
        bindSlider('fil-gray', 'none');
        bindSlider('fil-sepia', 'none');
        bindSlider('fil-blur', 'none');
        bindSlider('fil-bright', 'none');
        bindSlider('fil-cont', 'none');

        const applyFiltersFromSliders = () => {
            const g = _els.sliderFilGray.value;
            const s = _els.sliderFilSepia.value;
            const b = _els.sliderFilBlur.value;
            const br = _els.sliderFilBright.value;
            const c = _els.sliderFilCont.value;
            const val = `grayscale(${g}%) sepia(${s}%) blur(${b}px) brightness(${br}%) contrast(${c}%)`;
            _applyToAllTargets(t => { if(t.tagName === 'IMG') t.style.filter = val; });
            _els.valFilGray.innerText = g + '%';
            _els.valFilSepia.innerText = s + '%';
            _els.valFilBlur.innerText = b + 'px';
            _els.valFilBright.innerText = br + '%';
            _els.valFilCont.innerText = c + '%';
        };

        // Shadow Compositor
        bindSlider('sh-y', 'none');
        bindSlider('sh-blur', 'none');
        bindSlider('sh-alpha', 'none');

        const applyShadowFromSliders = () => {
            const y = _els.sliderShY.value;
            const b = _els.sliderShBlur.value;
            const a = _els.sliderShAlpha.value;
            const val = a == 0 ? 'none' : `0 ${y}px ${b}px rgba(0,0,0,${a})`;
            _applyToAllTargets(t => { t.style.boxShadow = val; });
        };

        // Text Shadow Compositor (Feature 3)
        const applyTextShadowFromSliders = () => {
            const x = _els.sliderTsX.value;
            const y = _els.sliderTsY.value;
            const b = _els.sliderTsBlur.value;
            const c = _els.tsColor.value;
            const val = (x == 0 && y == 0 && b == 0) ? 'none' : `${x}px ${y}px ${b}px ${c}`;
            _applyToAllTargets(t => { t.style.textShadow = val; });
        };

        // Borders with undo
        _addListener(document.getElementById('ai-border-style'), 'change', (e) => {
            pushUndoState(getTarget(), 'borderStyle');
            _applyToAllTargets(t => {
                t.style.borderStyle = e.target.value;
                if (e.target.value !== 'none' && (!t.style.borderWidth || t.style.borderWidth === '0px')) {
                    t.style.borderWidth = '2px';
                }
            });
            if (_els.sliderBwidth) _els.sliderBwidth.value = 2;
            if (_els.valBwidth) _els.valBwidth.innerText = '2px';
        });
        _addListener(document.getElementById('ai-border-color'), 'input', (e) => {
            _applyToAllTargets(t => { t.style.borderColor = e.target.value; });
        });
        _addListener(document.getElementById('ai-border-color'), 'change', (e) => {
            pushUndoState(getTarget(), 'borderColor');
            _applyToAllTargets(t => { t.style.borderColor = e.target.value; });
        });

        _addListener(document.getElementById('ai-btn-rewrite'), 'click', mockAIAction);
        _addListener(document.getElementById('ai-btn-save-preset'), 'click', saveCurrentAsPreset);
        _addListener(document.getElementById('ai-btn-clear-presets'), 'click', () => {
            if (confirm('Delete all saved presets?')) {
                localStorage.removeItem(PRESET_STORAGE_KEY);
                renderPresetsUI();
            }
        });

        // Apply CSS from code editor
        _addListener(document.getElementById('ai-btn-apply-css'), 'click', () => {
            const t = targetScope === 'page' ? document.body : activeElement;
            if (!t) return;
            pushUndoState(t, 'cssText');
            t.style.cssText = _els.cssEditor.value;
            syncSlidersToTarget();
        });

        // Event delegation for Element Tree (Phase 3)
        _addListener(document.getElementById('ai-element-tree'), 'click', (e) => {
            const node = e.target.closest('.ai-tree-node');
            if (!node) return;
            const editables = document.querySelectorAll('[data-editable="true"]');
            const idx = parseInt(node.dataset.treeIndex);
            if (editables[idx]) editables[idx].click();
        });

        // Event delegation for Presets (Phase 3)
        _addListener(document.getElementById('ai-presets-box'), 'click', (e) => {
            const deleteBtn = e.target.closest('.ai-preset-delete');
            const presetBlock = e.target.closest('.ai-preset-block');

            if (deleteBtn) {
                e.stopPropagation();
                const idx = parseInt(deleteBtn.dataset.index);
                const presets = JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '[]');
                presets.splice(idx, 1);
                localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
                renderPresetsUI();
                return;
            }
            if (presetBlock) {
                const idx = parseInt(presetBlock.dataset.index);
                const presets = JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '[]');
                const t = targetScope === 'page' ? document.body : activeElement;
                if (t && presets[idx]) {
                    pushUndoState(t, 'preset');
                    const p = presets[idx];
                    Object.keys(p).forEach(key => { if (key !== 'id' && p[key]) t.style[key] = p[key]; });
                    syncSlidersToTarget();
                }
            }
        });

        // ── Text Shadow Sliders + Color (Feature 3) ──
        bindSlider('ts-x', 'none');
        bindSlider('ts-y', 'none');
        bindSlider('ts-blur', 'none');
        _addListener(document.getElementById('ai-ts-color'), 'input', () => applyTextShadowFromSliders());
        _addListener(document.getElementById('ai-ts-color'), 'change', () => {
            pushUndoState(getTarget(), 'textShadow'); applyTextShadowFromSliders();
        });

        // ── Gradient Builder (Feature 2) ──
        const updateGradientPreview = () => {
            const angle = _els.sliderGradAngle.value;
            const start = _els.gradStart.value;
            const end = _els.gradEnd.value;
            if (_els.gradPreview) _els.gradPreview.style.background = `linear-gradient(${angle}deg, ${start}, ${end})`;
            if (_els.valGradAngle) _els.valGradAngle.innerText = angle + '\u00B0';
        };
        _addListener(_els.sliderGradAngle, 'input', updateGradientPreview);
        _addListener(_els.gradStart, 'input', updateGradientPreview);
        _addListener(_els.gradEnd, 'input', updateGradientPreview);
        updateGradientPreview();
        _addListener(document.getElementById('ai-btn-apply-gradient'), 'click', () => {
            const angle = _els.sliderGradAngle.value;
            const start = _els.gradStart.value;
            const end = _els.gradEnd.value;
            const val = `linear-gradient(${angle}deg, ${start}, ${end})`;
            pushUndoState(getTarget(), 'background');
            _applyToAllTargets(t => { t.style.background = val; });
        });

        // ── Transition Builder (Feature 4) ──
        _addListener(_els.sliderTransDur, 'input', (e) => {
            _els.valTransDur.innerText = e.target.value + 's';
        });
        _addListener(_els.sliderHoverScale, 'input', (e) => {
            _els.valHoverScale.innerText = parseFloat(e.target.value).toFixed(2);
        });
        _addListener(document.getElementById('ai-btn-apply-transition'), 'click', () => {
            const t = getTarget(); if (!t) return;
            pushUndoState(t, 'transition');
            const prop = _els.transitionProp.value;
            const dur = _els.sliderTransDur.value;
            const ease = _els.transitionEase.value;
            const scale = _els.sliderHoverScale.value;
            _applyToAllTargets(el => { el.style.transition = `${prop} ${dur}s ${ease}`; });
            if (scale != 1) {
                const selector = _buildSelector(t);
                if (!_hoverStyleTag) {
                    _hoverStyleTag = document.createElement('style');
                    _hoverStyleTag.id = 'ai-hover-styles';
                    document.head.appendChild(_hoverStyleTag);
                }
                _hoverStyleTag.textContent = `${selector}:hover { transform: scale(${scale}); }`;
            }
        });
        _addListener(document.getElementById('ai-btn-preview-transition'), 'click', () => {
            const t = getTarget(); if (!t) return;
            const scale = _els.sliderHoverScale.value;
            const dur = _els.sliderTransDur.value;
            const ease = _els.transitionEase.value;
            const origTr = t.style.transition;
            const origTf = t.style.transform;
            t.style.transition = `transform ${dur}s ${ease}`;
            requestAnimationFrame(() => {
                t.style.transform = `scale(${scale})`;
                setTimeout(() => {
                    t.style.transform = origTf || '';
                    setTimeout(() => { t.style.transition = origTr || ''; }, parseFloat(dur) * 1000);
                }, parseFloat(dur) * 1000);
            });
        });

        // ── Copy/Paste Styles (Feature 1) ──
        _addListener(document.getElementById('ai-btn-copy-style'), 'click', () => {
            const t = getTarget();
            if (t) { _styleClipboard = t.style.cssText; _emitter.emit('style:copy', { element: t }); }
        });
        _addListener(document.getElementById('ai-btn-paste-style'), 'click', () => {
            if (!_styleClipboard) return;
            pushUndoState(getTarget(), 'pasteStyle');
            _applyToAllTargets(t => { t.style.cssText = _styleClipboard; });
            syncSlidersToTarget();
            _emitter.emit('style:paste', { style: _styleClipboard });
        });

        // ── Flexbox/Grid Controls (Feature 5) ──
        editorContainer.querySelectorAll('.ai-display-btn').forEach(btn => {
            _addListener(btn, 'click', (e) => {
                pushUndoState(getTarget(), 'display');
                const val = e.currentTarget.dataset.val;
                _applyToAllTargets(el => { el.style.display = val; });
                editorContainer.querySelectorAll('.ai-display-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
            });
        });
        _addListener(_els.flexDirection, 'change', (e) => {
            pushUndoState(getTarget(), 'flexDirection');
            _applyToAllTargets(t => { t.style.flexDirection = e.target.value; });
        });
        _addListener(_els.justifyContent, 'change', (e) => {
            pushUndoState(getTarget(), 'justifyContent');
            _applyToAllTargets(t => { t.style.justifyContent = e.target.value; });
        });
        _addListener(_els.alignItems, 'change', (e) => {
            pushUndoState(getTarget(), 'alignItems');
            _applyToAllTargets(t => { t.style.alignItems = e.target.value; });
        });
        bindSlider('gap', 'gap');
        _addListener(_els.flexWrapBtn, 'click', () => {
            const t = getTarget(); if (!t) return;
            pushUndoState(t, 'flexWrap');
            const isWrap = getComputedStyle(t).flexWrap === 'wrap';
            const val = isWrap ? 'nowrap' : 'wrap';
            _applyToAllTargets(el => { el.style.flexWrap = val; });
            _els.flexWrapBtn.textContent = val === 'wrap' ? 'Wrap: On' : 'Wrap: Off';
        });

        // ── Spacing Visualizer (Feature 6) ──
        _addListener(_els.spacingVizBtn, 'click', () => {
            _spacingVisible = !_spacingVisible;
            _els.spacingVizBtn.textContent = _spacingVisible ? 'Hide Spacing' : 'Show Spacing';
            if (_spacingVisible) { _createSpacingOverlay(); _updateSpacingOverlay(); }
            else _destroySpacingOverlay();
        });

        // ── History Panel Delegation (Feature 8) ──
        _addListener(_els.historyList, 'click', (e) => {
            const entry = e.target.closest('.ai-history-entry');
            if (!entry) return;
            const targetIdx = parseInt(entry.dataset.historyIndex);
            const currentIdx = undoStack.length - 1;
            if (targetIdx < currentIdx) {
                const steps = currentIdx - targetIdx;
                for (let i = 0; i < steps; i++) performUndo();
            }
        });

        // ── Responsive Preview (Feature 7) ──
        editorContainer.querySelectorAll('.ai-responsive-btn').forEach(btn => {
            _addListener(btn, 'click', (e) => {
                const width = e.currentTarget.dataset.width;
                editorContainer.querySelectorAll('.ai-responsive-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                const label = _els.responsiveLabel;
                if (width === '100%') {
                    if (_originalBodyStyle !== null) {
                        document.body.style.maxWidth = _originalBodyStyle.maxWidth || '';
                        document.body.style.margin = _originalBodyStyle.margin || '';
                        _originalBodyStyle = null;
                    }
                    if (label) label.textContent = '';
                } else {
                    if (!_originalBodyStyle) {
                        _originalBodyStyle = { maxWidth: document.body.style.maxWidth, margin: document.body.style.margin };
                    }
                    document.body.style.maxWidth = width + 'px';
                    document.body.style.margin = '0 auto';
                    if (label) label.textContent = width + 'px';
                }
            });
        });

        // ── Preset Category Tabs (Feature 11) ──
        _addListener(document.getElementById('ai-preset-categories'), 'click', (e) => {
            const btn = e.target.closest('.ai-preset-cat-btn');
            if (!btn) return;
            editorContainer.querySelectorAll('.ai-preset-cat-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _activePresetCategory = btn.dataset.cat;
            renderPresetsUI();
        });

        // Prevent sidebar clicks from deselecting text
        _addListener(editorContainer, 'mousedown', (e) => {
            if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'TEXTAREA') {
                e.preventDefault();
            }
        });

        // ── Build _els cache (Phase 3 perf) ──
        const $ = id => document.getElementById('ai-' + id);
        _els = {
            // Sliders + value labels
            sliderPad: $('slider-pad'), valPad: $('val-pad'),
            sliderMarg: $('slider-marg'), valMarg: $('val-marg'),
            sliderRad: $('slider-rad'), valRad: $('val-rad'),
            sliderBwidth: $('slider-bwidth'), valBwidth: $('val-bwidth'),
            sliderTracking: $('slider-tracking'), valTracking: $('val-tracking'),
            sliderOpacity: $('slider-opacity'), valOpacity: $('val-opacity'),
            sliderGap: $('slider-gap'), valGap: $('val-gap'),
            sliderImgW: $('slider-img-width'), valImgW: $('val-img-width'),
            sliderImgH: $('slider-img-height'), valImgH: $('val-img-height'),
            sliderFilGray: $('slider-fil-gray'), valFilGray: $('val-fil-gray'),
            sliderFilSepia: $('slider-fil-sepia'), valFilSepia: $('val-fil-sepia'),
            sliderFilBlur: $('slider-fil-blur'), valFilBlur: $('val-fil-blur'),
            sliderFilBright: $('slider-fil-bright'), valFilBright: $('val-fil-bright'),
            sliderFilCont: $('slider-fil-cont'), valFilCont: $('val-fil-cont'),
            sliderShY: $('slider-sh-y'), sliderShBlur: $('slider-sh-blur'), sliderShAlpha: $('slider-sh-alpha'),
            sliderTsX: $('slider-ts-x'), valTsX: $('val-ts-x'),
            sliderTsY: $('slider-ts-y'), valTsY: $('val-ts-y'),
            sliderTsBlur: $('slider-ts-blur'), valTsBlur: $('val-ts-blur'),
            tsColor: $('ts-color'),
            sliderGradAngle: $('slider-grad-angle'), valGradAngle: $('val-grad-angle'),
            gradStart: $('grad-start'), gradEnd: $('grad-end'), gradPreview: $('grad-preview'),
            sliderTransDur: $('slider-transition-dur'), valTransDur: $('val-transition-dur'),
            sliderHoverScale: $('slider-hover-scale'), valHoverScale: $('val-hover-scale'),
            transitionProp: $('transition-prop'), transitionEase: $('transition-ease'),
            // Dropdowns
            fontWeight: $('font-weight'), borderStyle: $('border-style'),
            flexDirection: $('flex-direction'), justifyContent: $('justify-content'), alignItems: $('align-items'),
            flexWrapBtn: $('flex-wrap-btn'),
            // Containers
            elementTree: $('element-tree'), historyList: $('history-list'),
            presetsBox: $('presets-box'), flexgridControls: $('flexgrid-controls'),
            cssEditor: $('css-editor'), presetCatSelect: $('preset-cat-select'),
            // WCAG badge
            contrastRatio: $('contrast-ratio'), badgeAA: $('badge-aa'), badgeAAA: $('badge-aaa'),
            // Nav tabs
            navText: $('nav-text'), navLayout: $('nav-layout'), navEffects: $('nav-effects'),
            navAi: $('nav-ai'), navTree: $('nav-tree'),
            // Tab content
            tabText: document.getElementById('tab-text'),
            tabLayout: document.getElementById('tab-layout'),
            tabEffects: document.getElementById('tab-effects'),
            tabAi: document.getElementById('tab-ai'),
            tabTree: document.getElementById('tab-tree'),
            // Scope-specific containers
            imgControls: $('image-controls'), txtPadControls: $('text-layout-controls'),
            imgFilters: $('image-filters-controls'), txtEffects: $('text-effects-controls'),
            // Misc
            batchBadge: $('batch-badge'), spacingVizBtn: $('btn-spacing-viz'),
            exportStatus: $('export-status'), loading: $('editor-loading'),
            responsiveLabel: $('responsive-label'),
        };

        renderPresetsUI();

        // Boot State
        openSidebar();
        document.body.classList.add('ai-page-targeting-active');
        toggleSmartUI('page');

        // Apply theme if configured
        if (_config.theme) _applyTheme(_config.theme);

        _emitter.emit('ready');
    }

    // ─── Document Binds ──────────────────────────────────────────────────────
    function bindDocumentEvents() {
        _addListener(document, 'click', (e) => {
            const clickedInsideSidebar = e.target.closest('#ai-floating-editor-container') || e.target.closest('#ai-show-sidebar-btn');
            const clickedEditable = e.target.closest('[data-editable="true"]');

            if (clickedInsideSidebar) return;

            if (clickedEditable) {
                // Shift+click: batch select (Feature 10)
                if (e.shiftKey && activeElement && clickedEditable !== activeElement) {
                    if (_batchElements.has(clickedEditable)) {
                        _batchElements.delete(clickedEditable);
                        clickedEditable.removeAttribute('data-batch-selected');
                    } else {
                        _batchElements.add(clickedEditable);
                        clickedEditable.setAttribute('data-batch-selected', 'true');
                    }
                    _updateBatchBadge();
                    return;
                }

                if (activeElement) {
                    activeElement.removeAttribute('data-editable-active');
                    activeElement.removeAttribute('contenteditable');
                }
                activeElement = clickedEditable;
                activeElement.setAttribute('data-editable-active', 'true');

                // Snapshot original state on first selection (Phase 5)
                _snapshotOriginal(activeElement);

                const scopeType = activeElement.tagName === 'IMG' ? 'image' : 'text';

                if (scopeType === 'text') {
                    activeElement.setAttribute('contenteditable', 'true');
                    activeElement.focus();
                }

                toggleSmartUI(scopeType);

                document.querySelectorAll('.ai-scope-btn').forEach(b => b.classList.remove('active'));
                document.querySelector('[data-scope="element"]').classList.add('active');
                targetScope = 'element';
                document.body.classList.remove('ai-page-targeting-active');

                if (editorContainer.classList.contains('ai-editor-hidden')) openSidebar();
                else syncSlidersToTarget();

                _emitter.emit('select', { element: activeElement });

            } else {
                if (activeElement) {
                    activeElement.removeAttribute('data-editable-active');
                    activeElement.removeAttribute('contenteditable');
                    activeElement = null;
                    _emitter.emit('deselect');
                }
                _clearBatch();

                document.querySelectorAll('.ai-scope-btn').forEach(b => b.classList.remove('active'));
                document.querySelector('[data-scope="page"]').classList.add('active');
                targetScope = 'page';
                document.body.classList.add('ai-page-targeting-active');

                toggleSmartUI('page');
                syncSlidersToTarget();
            }
        });

        _addListener(document.body, 'keydown', (e) => {
            if (activeElement && e.key === 'Enter' && activeElement.tagName.match(/^H[1-6]/)) {
                e.preventDefault();
            }
        });
    }

    // ─── Adaptive Workspace Routing ──────────────────────────────────────────
    function toggleSmartUI(scopeType) {
        if (!editorContainer) return;

        const navText = _els.navText, navLayout = _els.navLayout, navEffects = _els.navEffects;
        const navAi = _els.navAi, navTree = _els.navTree;
        const imgControls = _els.imgControls, txtPadControls = _els.txtPadControls;
        const imgFilters = _els.imgFilters, txtEffects = _els.txtEffects;

        navText.classList.remove('active');
        navLayout.classList.remove('active');
        navEffects.classList.remove('active');
        navAi.classList.remove('active');
        navTree.classList.remove('active');

        _els.tabText.classList.remove('active');
        _els.tabLayout.classList.remove('active');
        _els.tabEffects.classList.remove('active');
        _els.tabAi.classList.remove('active');
        _els.tabTree.classList.remove('active');

        navTree.style.display = 'block';
        navTree.innerText = 'Inspect';

        if (scopeType === 'image') {
            navText.style.display = 'none';
            navLayout.style.display = 'block';
            navEffects.style.display = 'block';
            navAi.style.display = 'none';

            navLayout.innerText = 'Image Layout';
            navEffects.innerText = 'Optics';

            imgControls.style.display = 'block';
            txtPadControls.style.display = 'none';
            imgFilters.style.display = 'block';
            txtEffects.style.display = 'none';

            navLayout.classList.add('active');
            _els.tabLayout.classList.add('active');

        } else if (scopeType === 'text') {
            navText.style.display = 'block';
            navLayout.style.display = 'block';
            navEffects.style.display = 'block';
            navAi.style.display = 'block';

            navText.innerText = 'Typography';
            navLayout.innerText = 'Layout';
            navEffects.innerText = 'Effects';
            navAi.innerText = 'AI';

            imgControls.style.display = 'none';
            txtPadControls.style.display = 'block';
            imgFilters.style.display = 'none';
            txtEffects.style.display = 'block';

            navLayout.classList.add('active');
            _els.tabLayout.classList.add('active');

        } else if (scopeType === 'page') {
            navText.style.display = 'block';
            navLayout.style.display = 'block';
            navEffects.style.display = 'block';
            navAi.style.display = 'block';

            navText.innerText = 'Global Text';
            navLayout.innerText = 'Page Layout';
            navEffects.innerText = 'Page Effects';
            navAi.innerText = 'Workspace';

            imgControls.style.display = 'none';
            txtPadControls.style.display = 'block';
            imgFilters.style.display = 'none';
            txtEffects.style.display = 'block';

            navLayout.classList.add('active');
            _els.tabLayout.classList.add('active');
        }
    }

    // ─── Sidebar Toggle ──────────────────────────────────────────────────────
    function openSidebar() {
        editorContainer.classList.remove('ai-editor-hidden');
        editorContainer.classList.add('ai-editor-active');
        document.body.classList.add('ai-editor-open');
        document.body.classList.remove('ai-editor-closed');
        if(showSidebarBtn) showSidebarBtn.classList.remove('visible');
        syncSlidersToTarget();
        _emitter.emit('open');
    }

    function hideSidebar() {
        editorContainer.classList.add('ai-editor-hidden');
        editorContainer.classList.remove('ai-editor-active');
        document.body.classList.add('ai-editor-closed');
        document.body.classList.remove('ai-editor-open');
        if(showSidebarBtn) showSidebarBtn.classList.add('visible');
        _emitter.emit('close');
    }

    // ─── Sync Sliders ────────────────────────────────────────────────────────
    function syncSlidersToTarget() {
        const t = targetScope === 'page' ? document.body : activeElement;
        if (!t) return;

        const comp = window.getComputedStyle(t);
        const syncS = (slider, valEl, prop, def=0) => {
            let num = parseFloat(comp[prop]);
            if(isNaN(num)) num = def;
            if(slider) { slider.value = num; valEl.innerText = prop==='opacity' ? Math.round(num*100)+'%' : num; }
        };
        syncS(_els.sliderPad, _els.valPad, 'paddingTop');
        syncS(_els.sliderMarg, _els.valMarg, 'marginTop');
        syncS(_els.sliderRad, _els.valRad, 'borderTopLeftRadius');
        syncS(_els.sliderBwidth, _els.valBwidth, 'borderTopWidth');
        syncS(_els.sliderTracking, _els.valTracking, 'letterSpacing');
        syncS(_els.sliderOpacity, _els.valOpacity, 'opacity', 1);

        try {
            let fw = comp.fontWeight;
            const weightMap = { 'normal': '400', 'bold': '700', 'lighter': '300', 'bolder': '900' };
            if (weightMap[fw]) fw = weightMap[fw];
            if (_els.fontWeight) _els.fontWeight.value = fw;
        } catch(e){}
        try { if (_els.borderStyle) _els.borderStyle.value = comp.borderTopStyle && comp.borderTopStyle !== 'none' ? comp.borderTopStyle : 'none'; }catch(e){}

        if (t.tagName === 'IMG') {
            if (_els.sliderImgW) { _els.sliderImgW.value = t.clientWidth || 0; _els.valImgW.innerText = t.clientWidth + 'px'; }
            if (_els.sliderImgH) { _els.sliderImgH.value = t.clientHeight || 0; _els.valImgH.innerText = t.clientHeight + 'px'; }

            const filterStr = comp.filter || '';
            const extractFilter = (name, def) => {
                const match = filterStr.match(new RegExp(name + '\\(([\\d.]+)'));
                return match ? parseFloat(match[1]) : def;
            };
            const syncFilter = (sliderEl, labelEl, name, def, unit) => {
                const val = extractFilter(name, def);
                if (sliderEl) sliderEl.value = val;
                if (labelEl) labelEl.innerText = val + unit;
            };
            syncFilter(_els.sliderFilGray, _els.valFilGray, 'grayscale', 0, '%');
            syncFilter(_els.sliderFilSepia, _els.valFilSepia, 'sepia', 0, '%');
            syncFilter(_els.sliderFilBlur, _els.valFilBlur, 'blur', 0, 'px');
            syncFilter(_els.sliderFilBright, _els.valFilBright, 'brightness', 100, '%');
            syncFilter(_els.sliderFilCont, _els.valFilCont, 'contrast', 100, '%');
        }

        // Sync text shadow (Feature 3)
        const textShadow = comp.textShadow;
        if (textShadow && textShadow !== 'none') {
            const tsMatch = textShadow.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/);
            if (tsMatch) {
                if (_els.sliderTsX) { _els.sliderTsX.value = parseFloat(tsMatch[1]); _els.valTsX.innerText = tsMatch[1] + 'px'; }
                if (_els.sliderTsY) { _els.sliderTsY.value = parseFloat(tsMatch[2]); _els.valTsY.innerText = tsMatch[2] + 'px'; }
                if (_els.sliderTsBlur) { _els.sliderTsBlur.value = parseFloat(tsMatch[3]); _els.valTsBlur.innerText = tsMatch[3] + 'px'; }
            }
        } else {
            if (_els.sliderTsX) { _els.sliderTsX.value = 0; _els.valTsX.innerText = '0px'; }
            if (_els.sliderTsY) { _els.sliderTsY.value = 0; _els.valTsY.innerText = '0px'; }
            if (_els.sliderTsBlur) { _els.sliderTsBlur.value = 0; _els.valTsBlur.innerText = '0px'; }
        }

        // Sync flex/grid controls (Feature 5)
        const flexgrid = _els.flexgridControls;
        if (flexgrid) {
            const shouldShow = (targetScope === 'page') || (t.children.length > 0 && t.tagName !== 'IMG');
            flexgrid.style.display = shouldShow ? 'block' : 'none';
            if (shouldShow) {
                const d = comp.display;
                editorContainer.querySelectorAll('.ai-display-btn').forEach(b => b.classList.toggle('active', b.dataset.val === d));
                try { if (_els.flexDirection) _els.flexDirection.value = comp.flexDirection || 'row'; } catch(e){}
                try { if (_els.justifyContent) _els.justifyContent.value = comp.justifyContent || 'flex-start'; } catch(e){}
                try { if (_els.alignItems) _els.alignItems.value = comp.alignItems || 'stretch'; } catch(e){}
                const gap = parseFloat(comp.gap) || 0;
                if (_els.sliderGap) { _els.sliderGap.value = gap; _els.valGap.innerText = gap + 'px'; }
                if (_els.flexWrapBtn) _els.flexWrapBtn.textContent = comp.flexWrap === 'wrap' ? 'Wrap: On' : 'Wrap: Off';
            }
        }

        // Update spacing overlay (Feature 6)
        if (_spacingVisible) _updateSpacingOverlay();

        buildElementTree();
        updateCodeView();
        _updateContrastBadge(comp);
    }

    // ─── Element Tree (event delegation, no per-node listeners) ──────────────
    function buildElementTree() {
        const treeBox = _els.elementTree;
        if (!treeBox) return;

        const editables = document.querySelectorAll('[data-editable="true"]');
        const count = editables.length;

        // Skip full rebuild if element count unchanged — just toggle active class
        if (count === _treeLastEditableCount && _treeLastActiveElement !== activeElement) {
            treeBox.querySelectorAll('.ai-tree-node').forEach(node => {
                const idx = parseInt(node.dataset.treeIndex);
                node.classList.toggle('ai-tree-active', editables[idx] === activeElement);
            });
            _treeLastActiveElement = activeElement;
            return;
        }

        // Skip entirely if nothing changed
        if (count === _treeLastEditableCount && _treeLastActiveElement === activeElement) return;

        treeBox.innerHTML = [...editables].map((el, i) => {
            const tag = el.tagName.toLowerCase();
            const preview = el.tagName === 'IMG'
                ? `&lt;img&gt; ${el.alt || 'image'}`
                : `&lt;${tag}&gt; ${el.textContent.substring(0, 28).trim()}${el.textContent.length > 28 ? '...' : ''}`;
            const isActive = el === activeElement ? ' ai-tree-active' : '';
            return `<div class="ai-tree-node${isActive}" data-tree-index="${i}">${preview}</div>`;
        }).join('');

        _treeLastEditableCount = count;
        _treeLastActiveElement = activeElement;
    }

    function updateCodeView() {
        const t = targetScope === 'page' ? document.body : activeElement;
        const editor = _els.cssEditor;
        if (!t || !editor) return;
        const css = t.style.cssText;
        editor.value = css ? css.split(';').filter(s => s.trim()).join(';\n') + ';' : '';
    }

    // ─── Presets (event delegation, no per-node listeners) ───────────────────
    function saveCurrentAsPreset() {
        const t = targetScope === 'page' ? document.body : activeElement;
        if (!t) return;
        const comp = window.getComputedStyle(t);
        const catSelect = _els.presetCatSelect;
        const category = catSelect ? catSelect.value : 'Custom';

        const preset = {
            id: Date.now().toString(),
            category: category,
            color: t.style.color || comp.color,
            background: t.style.background || comp.background,
            padding: t.style.padding || comp.padding,
            borderRadius: t.style.borderRadius || comp.borderRadius,
            boxShadow: t.style.boxShadow || comp.boxShadow,
            fontFamily: t.style.fontFamily || comp.fontFamily,
            border: t.style.border || comp.border
        };

        const existing = JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '[]');
        existing.push(preset);
        localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(existing));
        renderPresetsUI();
    }

    function renderPresetsUI() {
        const box = _els.presetsBox || document.getElementById('ai-presets-box');
        if (!box) return;

        const allPresets = JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '[]');
        const filtered = _activePresetCategory === 'all'
            ? allPresets
            : allPresets.filter(p => p.category === _activePresetCategory);

        if (filtered.length === 0) {
            box.style.gridTemplateColumns = '1fr';
            box.innerHTML = '<div style="font-size:10px; color: rgba(255,255,255,0.4); text-align: center;">No presets in this category.</div>';
            return;
        }

        box.style.gridTemplateColumns = 'repeat(3, 1fr)';
        box.innerHTML = filtered.map((p) => {
            const globalIdx = allPresets.indexOf(p);
            return `<div class="ai-preset-block" data-index="${globalIdx}"
                 title="${p.category || 'Custom'} Preset"
                 style="background: ${p.background}; border-radius: min(4px, ${p.borderRadius}); box-shadow: ${p.boxShadow}; border: ${p.border};">
                <button class="ai-preset-delete" data-index="${globalIdx}" title="Delete Preset" aria-label="Delete preset">&times;</button>
            </div>`;
        }).join('');
    }

    // ─── AI Rewrite (Configurable Hook) ──────────────────────────────────────
    async function mockAIAction() {
        if (!activeElement || targetScope === 'page') {
            alert("Please target a specific element to rewrite its content.");
            return;
        }
        if (activeElement.tagName === 'IMG') {
            alert("Cannot rewrite text inside an image block.");
            return;
        }

        pushUndoState(activeElement, 'innerHTML');
        const loading = _els.loading;
        loading.classList.add('active');

        try {
            if (typeof _config.rewriteHandler === 'function') {
                const result = await _config.rewriteHandler(activeElement.innerHTML, activeElement);
                if (result) activeElement.innerHTML = result;
            } else {
                await new Promise(r => setTimeout(r, 800));
                activeElement.innerHTML += ' <em>(AI rewrite placeholder)</em>';
            }
        } catch (err) {
            console.error('AI Rewrite failed:', err);
        } finally {
            loading.classList.remove('active');
        }
    }

    // ─── Keyboard Shortcuts ──────────────────────────────────────────────────
    function bindKeyboardShortcuts() {
        _addListener(document, 'keydown', (e) => {
            const isTyping = activeElement
                && activeElement.getAttribute('contenteditable') === 'true'
                && document.activeElement === activeElement;

            if (e.key === 'Escape') {
                if (_shortcutOverlay) { _hideShortcutOverlay(); return; }
                if (activeElement) {
                    activeElement.removeAttribute('data-editable-active');
                    activeElement.removeAttribute('contenteditable');
                    activeElement = null;
                    _emitter.emit('deselect');
                }
                _clearBatch();
                document.querySelectorAll('.ai-scope-btn').forEach(b => b.classList.remove('active'));
                document.querySelector('[data-scope="page"]').classList.add('active');
                targetScope = 'page';
                document.body.classList.add('ai-page-targeting-active');
                toggleSmartUI('page');
                syncSlidersToTarget();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                performUndo();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
                e.preventDefault();
                performRedo();
                return;
            }

            // Copy/Paste style shortcuts (Feature 1)
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
                e.preventDefault();
                const t = targetScope === 'page' ? document.body : activeElement;
                if (t) { _styleClipboard = t.style.cssText; _emitter.emit('style:copy', { element: t }); }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
                e.preventDefault();
                if (_styleClipboard) {
                    pushUndoState(targetScope === 'page' ? document.body : activeElement, 'pasteStyle');
                    _applyToAllTargets(t => { t.style.cssText = _styleClipboard; });
                    syncSlidersToTarget();
                    _emitter.emit('style:paste', { style: _styleClipboard });
                }
                return;
            }

            if (isTyping) return;

            // Shortcut overlay (Feature 9)
            if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                _showShortcutOverlay();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
                e.preventDefault();
                if (editorContainer.classList.contains('ai-editor-hidden')) openSidebar();
                else hideSidebar();
                return;
            }

            if (e.key >= '1' && e.key <= '4' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const tabs = editorContainer.querySelectorAll('.ai-tab-btn');
                const visibleTabs = [...tabs].filter(t => t.style.display !== 'none');
                const idx = parseInt(e.key) - 1;
                if (visibleTabs[idx]) visibleTabs[idx].click();
            }
        });
    }

    // ─── Destroy ─────────────────────────────────────────────────────────────
    function destroy() {
        _emitter.emit('destroy');
        _emitter.clear();

        // Destroy all plugins
        Object.values(_plugins).forEach(({ plugin }) => {
            if (typeof plugin.destroy === 'function') plugin.destroy();
        });
        Object.keys(_plugins).forEach(k => delete _plugins[k]);

        // Remove all registered DOM event listeners
        _listenerRegistry.forEach(({ target, event, handler, options }) => {
            try { target.removeEventListener(event, handler, options); } catch(e) {}
        });
        _listenerRegistry.length = 0;

        // Remove DOM nodes
        const panel = document.getElementById('ai-floating-editor-container');
        if (panel) panel.remove();
        const showBtn = document.getElementById('ai-show-sidebar-btn');
        if (showBtn) showBtn.remove();

        // Remove body classes
        document.body.classList.remove('ai-editor-open', 'ai-editor-closed', 'ai-page-targeting-active');
        document.body.style.userSelect = '';

        // Clear deselect active element
        if (activeElement) {
            activeElement.removeAttribute('data-editable-active');
            activeElement.removeAttribute('contenteditable');
        }

        // Clean up v1.1 features
        _clearBatch();
        _destroySpacingOverlay();
        _hideShortcutOverlay();
        if (_hoverStyleTag) { _hoverStyleTag.remove(); _hoverStyleTag = null; }
        if (_originalBodyStyle) {
            document.body.style.maxWidth = _originalBodyStyle.maxWidth || '';
            document.body.style.margin = _originalBodyStyle.margin || '';
            _originalBodyStyle = null;
        }
        _styleClipboard = null;
        _activePresetCategory = 'all';
        _els = {};
        _treeLastEditableCount = -1;
        _treeLastActiveElement = null;

        // Clear state
        undoStack.length = 0;
        redoStack.length = 0;
        activeElement = null;
        editorContainer = null;
        showSidebarBtn = null;
        targetScope = 'page';
        _initialized = false;
        _trackedElements.length = 0;
    }

    // ─── PUBLIC API ──────────────────────────────────────────────────────────
    window.GlassStudio = {
        init(options) {
            if (_initialized) return window.GlassStudio;
            if (options) Object.assign(_config, options);
            injectEditorUI();
            bindDocumentEvents();
            bindKeyboardShortcuts();
            _initialized = true;
            return window.GlassStudio;
        },

        destroy,

        on(event, cb)  { _emitter.on(event, cb); return window.GlassStudio; },
        once(event, cb) { _emitter.once(event, cb); return window.GlassStudio; },
        off(event, cb) { _emitter.off(event, cb); return window.GlassStudio; },

        select(element) {
            if (!element || !element.hasAttribute('data-editable')) return window.GlassStudio;
            element.click();
            return window.GlassStudio;
        },

        deselect() {
            if (activeElement) {
                activeElement.removeAttribute('data-editable-active');
                activeElement.removeAttribute('contenteditable');
                activeElement = null;
                _emitter.emit('deselect');
                toggleSmartUI('page');
                syncSlidersToTarget();
            }
            return window.GlassStudio;
        },

        getChanges() { return _getChangesImpl(); },

        exportHTML()     { return exportCleanHTML(); },
        exportCSS()      { return _exportCSSImpl(); },
        exportReact()    { return _exportReactImpl(); },
        exportTailwind() { return _exportTailwindImpl(); },

        undo()  { performUndo(); return window.GlassStudio; },
        redo()  { performRedo(); return window.GlassStudio; },

        configure(opts) {
            Object.assign(_config, opts);
            if (opts.theme) _applyTheme(opts.theme);
            return window.GlassStudio;
        },

        registerPlugin(name, plugin) {
            return _registerPlugin(name, plugin);
        },

        setLoading(active) {
            const overlay = _els.loading;
            if (overlay) overlay.classList.toggle('active', active);
            return window.GlassStudio;
        },

        get version() { return '1.1.0'; }
    };

    // Backwards-compatible alias
    window.OverlayEditor = {
        configure: (opts) => window.GlassStudio.configure(opts),
        undo:  () => window.GlassStudio.undo(),
        redo:  () => window.GlassStudio.redo()
    };

    // ─── Auto-Boot ───────────────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.GlassStudio.init());
    } else {
        window.GlassStudio.init();
    }

})();
