// public/scripts/mobile-api-bridge.js
//
// Serverless / client-only bridge for SillyTavern.
//
// SillyTavern is normally a client/server app: the browser UI talks to a
// Node.js backend over dozens of HTTP endpoints. When the app is packaged as a
// standalone Android APK (Capacitor WebView) there is no backend, so every one
// of those calls 404s. The very first call in firstLoadInit() is
// `fetch('/csrf-token')`; when it fails the whole init throws and you get a
// black screen.
//
// This script patches window.fetch *before* any other script runs and emulates
// the backend entirely in the WebView:
//   - configuration / presets are served from the bundled /default-content
//   - user data (settings, secrets, characters, chats, personas) is persisted
//     in IndexedDB on the device
//   - LLM chat-completion requests are sent directly to the provider's API
//     (OpenAI, Claude, OpenRouter, Google, DeepSeek, Mistral, xAI, Groq,
//     a generic OpenAI-compatible "Custom" endpoint, ...). On Capacitor the
//     native CapacitorHttp layer handles these so there are no CORS issues.
//
// The goal is twofold: (1) never throw during init -> no black screen, and
// (2) make the core "configure an API key and chat with a character" loop work
// fully offline.

(function () {
    'use strict';

    // ----------------------------------------------------------------- detect
    // IMPORTANT: detection is LAZY (evaluated when a request actually fires),
    // not at script-load time. Capacitor may not have injected `window.Capacitor`
    // yet while this <head> script runs, so deciding now risks wrongly disabling
    // the bridge -> /csrf-token hits the network -> black screen. By the time the
    // app issues its first request (during init, after full load) Capacitor is
    // ready, so the check is reliable.
    function shouldEmulate() {
        try {
            if (localStorage.getItem('st_force_mobile_api') === 'false') return false;
            if (localStorage.getItem('st_force_mobile_api') === 'true') return true;
        } catch (e) { /* localStorage may be unavailable */ }
        if (typeof window.Capacitor !== 'undefined') return true;
        const proto = window.location.protocol;
        if (proto === 'capacitor:' || proto === 'file:') return true;
        // Capacitor Android with androidScheme:https serves from https://localhost
        // (no port). A real ST server is virtually never at exactly that origin.
        if (proto === 'https:' && window.location.hostname === 'localhost' &&
            (window.location.port === '' || window.location.port === '443')) {
            return true;
        }
        return false;
    }

    console.log('[Mobile Bridge] Loaded; emulation decided per-request.');

    // Capture the real fetch *before* we override it. On Capacitor this is the
    // native-backed fetch (CapacitorHttp) which bypasses CORS for outbound calls.
    const originalFetch = window.fetch.bind(window);

    // --------------------------------------------------------- IndexedDB store
    const DB_NAME = 'SillyTavernMobileStore';
    const STORE_NAME = 'VirtualFS';
    let dbPromise = null;

    function getDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
        return dbPromise;
    }

    async function fsGet(key) {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function fsSet(key, value) {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).put(value, key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async function fsDelete(key) {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async function fsKeys() {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).getAllKeys();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    // ------------------------------------------------------- bundled defaults
    // Fetch a bundled asset (served from the APK's assets) as text/json/blob.
    async function fetchAsset(path) {
        try {
            const res = await originalFetch(path, { cache: 'force-cache' });
            if (!res.ok) return null;
            return res;
        } catch {
            return null;
        }
    }

    async function fetchAssetJson(path) {
        const res = await fetchAsset(path);
        if (!res) return null;
        try { return await res.json(); } catch { return null; }
    }

    // Build the faithful /api/settings/get response from /default-content.
    // The backend assembles this from a freshly-seeded user directory; we do the
    // same by reading the default-content manifest (index.json) and grouping the
    // files by type. Cached after the first build.
    let cachedDefaults = null;

    async function buildDefaultBundle() {
        if (cachedDefaults) return cachedDefaults;

        const manifest = await fetchAssetJson('/default-content/index.json') || [];

        const byType = {};
        for (const entry of manifest) {
            (byType[entry.type] = byType[entry.type] || []).push(entry.filename);
        }

        // Read every file of a given type, returning { fileContents[], fileNames[] }
        // where fileContents are raw JSON strings (as the frontend expects) and
        // names are the basename without extension.
        async function readPresetType(type) {
            const files = byType[type] || [];
            const results = await Promise.all(files.map(async (filename) => {
                const res = await fetchAsset('/default-content/' + filename);
                if (!res) return null;
                const text = await res.text();
                const base = filename.split('/').pop().replace(/\.[^.]+$/, '');
                return { text, base };
            }));
            const fileContents = [];
            const fileNames = [];
            for (const r of results) {
                if (!r) continue;
                fileContents.push(r.text);
                fileNames.push(r.base);
            }
            return { fileContents, fileNames };
        }

        // Read every file of a type as parsed objects (themes, moving UI, etc.).
        async function readParsedType(type) {
            const files = byType[type] || [];
            const results = await Promise.all(files.map(f => fetchAssetJson('/default-content/' + f)));
            return results.filter(Boolean);
        }

        const kobold = await readPresetType('kobold_preset');
        const novel = await readPresetType('novel_preset');
        const openai = await readPresetType('openai_preset');
        const textgen = await readPresetType('textgen_preset');

        cachedDefaults = {
            kobold,
            novel,
            openai,
            textgen,
            context: await readParsedType('context'),
            instruct: await readParsedType('instruct'),
            sysprompt: await readParsedType('sysprompt'),
            reasoning: await readParsedType('reasoning'),
            themes: await readParsedType('theme'),
            movingUIPresets: await readParsedType('moving_ui'),
            quickReplyPresets: await readParsedType('quick_replies'),
        };
        return cachedDefaults;
    }

    // ------------------------------------------------------------ seed on first run
    async function seedInitialData() {
        try {
            const existing = await fsGet('settings');
            if (!existing) {
                const settings = await fetchAssetJson('/default-content/settings.json');
                if (settings) {
                    // Stored as a JSON string to mirror the backend's settings file.
                    await fsSet('settings', JSON.stringify(settings));
                }
            }
            const user = await fsGet('user_me');
            if (!user) {
                await fsSet('user_me', {
                    handle: 'default-user',
                    name: 'User',
                    avatar: 'img/user-default.png',
                    admin: true,
                    enabled: true,
                    created: 0,
                    password: false,
                });
            }
        } catch (err) {
            console.error('[Mobile Bridge] Seeding failed:', err);
        }
    }

    let seedPromise = null;
    function ensureSeed() {
        if (!seedPromise) seedPromise = seedInitialData();
        return seedPromise;
    }

    // ---------------------------------------------------------------- secrets
    // Stored shape: { [key]: [{ id, label, value, active }] }
    async function getSecretsStore() {
        return (await fsGet('secrets')) || {};
    }

    function getActiveSecretValue(store, key) {
        const arr = store[key];
        if (!Array.isArray(arr) || arr.length === 0) return '';
        const active = arr.find(x => x.active) || arr[0];
        return active ? (active.value || '') : '';
    }

    // Public-facing secret state: hides values, keeps id/label/active for the UI.
    function buildSecretState(store) {
        const state = {};
        for (const [key, arr] of Object.entries(store)) {
            if (Array.isArray(arr) && arr.length) {
                state[key] = arr.map(x => ({ id: x.id, label: x.label, active: !!x.active }));
            }
        }
        return state;
    }

    let secretIdCounter = 1;
    function makeSecretId() {
        // Avoid Date.now()/Math.random() reliance issues; monotonic is enough here.
        return 'sec_' + (secretIdCounter++) + '_' + (performance.now() | 0);
    }

    // ------------------------------------------------- chat completion routing
    // OpenAI-compatible providers: just a base URL + secret key name. Everything
    // speaks the OpenAI /chat/completions schema and returns the OpenAI shape.
    const OPENAI_COMPATIBLE = {
        openai: { url: 'https://api.openai.com/v1/chat/completions', secret: 'api_key_openai' },
        openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', secret: 'api_key_openrouter' },
        deepseek: { url: 'https://api.deepseek.com/chat/completions', secret: 'api_key_deepseek' },
        mistralai: { url: 'https://api.mistral.ai/v1/chat/completions', secret: 'api_key_mistralai' },
        xai: { url: 'https://api.x.ai/v1/chat/completions', secret: 'api_key_xai' },
        groq: { url: 'https://api.groq.com/openai/v1/chat/completions', secret: 'api_key_groq' },
        cohere: { url: 'https://api.cohere.ai/v2/chat', secret: 'api_key_cohere' },
        perplexity: { url: 'https://api.perplexity.ai/chat/completions', secret: 'api_key_perplexity' },
        // Google exposes an OpenAI-compatible surface; simplest path to support it.
        makersuite: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', secret: 'api_key_makersuite' },
    };

    function normalizeOpenAiMessages(messages) {
        return (messages || []).map(m => ({
            role: m.role,
            content: m.content,
            ...(m.name ? { name: m.name } : {}),
        }));
    }

    // Convert OpenAI-style messages to the Anthropic Messages API format.
    function toClaudeFormat(generateData) {
        const system = [];
        const messages = [];
        for (const m of generateData.messages || []) {
            if (m.role === 'system') {
                system.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
                continue;
            }
            messages.push({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: m.content,
            });
        }
        // Anthropic requires the first message to be from the user.
        if (messages.length === 0 || messages[0].role !== 'user') {
            messages.unshift({ role: 'user', content: '...' });
        }
        if (generateData.assistant_prefill) {
            messages.push({ role: 'assistant', content: generateData.assistant_prefill });
        }
        const body = {
            model: generateData.model,
            max_tokens: generateData.max_tokens || 4096,
            messages,
        };
        if (system.length) body.system = system.join('\n\n');
        if (typeof generateData.temperature === 'number') body.temperature = generateData.temperature;
        if (typeof generateData.top_p === 'number') body.top_p = generateData.top_p;
        if (typeof generateData.top_k === 'number' && generateData.top_k > 0) body.top_k = generateData.top_k;
        if (Array.isArray(generateData.stop) && generateData.stop.length) body.stop_sequences = generateData.stop;
        return body;
    }

    function buildOpenAiBody(generateData) {
        const body = {
            model: generateData.model,
            messages: normalizeOpenAiMessages(generateData.messages),
            stream: false,
        };
        if (typeof generateData.temperature === 'number') body.temperature = generateData.temperature;
        if (typeof generateData.top_p === 'number') body.top_p = generateData.top_p;
        if (typeof generateData.frequency_penalty === 'number') body.frequency_penalty = generateData.frequency_penalty;
        if (typeof generateData.presence_penalty === 'number') body.presence_penalty = generateData.presence_penalty;
        if (generateData.max_tokens) body.max_tokens = generateData.max_tokens;
        if (Array.isArray(generateData.stop) && generateData.stop.length) body.stop = generateData.stop;
        if (generateData.logit_bias) body.logit_bias = generateData.logit_bias;
        if (generateData.n && generateData.n > 1) body.n = generateData.n;
        return body;
    }

    // Returns { content, role } extracted from a provider response, normalized.
    async function callProvider(generateData) {
        const source = generateData.chat_completion_source;
        const store = await getSecretsStore();

        // Reverse proxy: an OpenAI-compatible base URL + password used as the key.
        if (generateData.reverse_proxy) {
            let base = generateData.reverse_proxy.replace(/\/$/, '');
            if (!/\/chat\/completions$/.test(base)) base += '/chat/completions';
            const res = await originalFetch(base, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (generateData.proxy_password || ''),
                },
                body: JSON.stringify(buildOpenAiBody(generateData)),
            });
            return extractOpenAiContent(await res.json());
        }

        if (source === 'claude') {
            const apiKey = getActiveSecretValue(store, 'api_key_claude');
            const res = await originalFetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true',
                },
                body: JSON.stringify(toClaudeFormat(generateData)),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error.message || 'Claude API error');
            const text = Array.isArray(data.content)
                ? data.content.filter(p => p.type === 'text').map(p => p.text).join('')
                : '';
            return { content: text, role: 'assistant' };
        }

        if (source === 'custom') {
            const apiKey = getActiveSecretValue(store, 'api_key_custom');
            let url = (generateData.custom_url || '').replace(/\/$/, '');
            if (!url) throw new Error('Custom endpoint URL is not set.');
            if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
            // Allow user-supplied extra headers ("Name: Value" per line).
            if (generateData.custom_include_headers) {
                for (const line of String(generateData.custom_include_headers).split('\n')) {
                    const idx = line.indexOf(':');
                    if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                }
            }
            const res = await originalFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(buildOpenAiBody(generateData)),
            });
            return extractOpenAiContent(await res.json());
        }

        const cfg = OPENAI_COMPATIBLE[source];
        if (cfg) {
            const apiKey = getActiveSecretValue(store, cfg.secret);
            const res = await originalFetch(cfg.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + apiKey,
                },
                body: JSON.stringify(buildOpenAiBody(generateData)),
            });
            return extractOpenAiContent(await res.json());
        }

        throw new Error('Provider "' + source + '" is not supported in serverless mode. ' +
            'Use Chat Completion with OpenAI, Claude, OpenRouter, Google, DeepSeek, Mistral, xAI, Groq, or a Custom (OpenAI-compatible) endpoint.');
    }

    function extractOpenAiContent(data) {
        if (data && data.error) {
            throw new Error((data.error && data.error.message) || 'API returned an error');
        }
        const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
        const msg = choice && (choice.message || choice.delta);
        return { content: (msg && msg.content) || '', role: (msg && msg.role) || 'assistant' };
    }

    // Build the response the frontend expects, honoring stream vs non-stream.
    function buildGenerationResponse(reply, wantStream) {
        if (wantStream) {
            // Emit a single OpenAI-style SSE chunk with the full text, then DONE.
            // The frontend's SSE parser reads delta.content and stops on [DONE].
            const chunk = {
                choices: [{ index: 0, delta: { role: reply.role, content: reply.content }, finish_reason: null }],
            };
            const done = {
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            };
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
                    controller.enqueue(encoder.encode('data: ' + JSON.stringify(done) + '\n\n'));
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                },
            });
            return new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            });
        }
        const body = {
            choices: [{
                index: 0,
                message: { role: reply.role, content: reply.content },
                finish_reason: 'stop',
            }],
        };
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ------------------------------------------------------------- API handlers
    // Each handler returns either a plain object (auto-wrapped as JSON 200) or a
    // Response instance (returned as-is).
    const handlers = {
        // -- bootstrap / health -------------------------------------------------
        'GET:/csrf-token': async () => ({ token: 'serverless-no-csrf' }),
        'GET:/version': async () => {
            const pkg = await fetchAssetJson('/manifest.json');
            return {
                agent: 'SillyTavern/serverless',
                pkgVersion: (pkg && pkg.version) || 'mobile',
                gitRevision: null,
                gitBranch: null,
            };
        },
        'POST:/api/ping': async () => ({ ok: true }),

        // -- users --------------------------------------------------------------
        'GET:/api/users/me': async () => (await fsGet('user_me')) || { handle: 'default-user', name: 'User' },
        'POST:/api/users/get': async () => [(await fsGet('user_me')) || { handle: 'default-user', name: 'User' }],
        'POST:/api/users/me': async () => (await fsGet('user_me')) || { handle: 'default-user', name: 'User' },

        // -- settings -----------------------------------------------------------
        'POST:/api/settings/get': async () => {
            await ensureSeed();
            const settingsStr = (await fsGet('settings')) || '{}';
            const d = await buildDefaultBundle();
            return {
                settings: settingsStr,
                koboldai_settings: d.kobold.fileContents,
                koboldai_setting_names: d.kobold.fileNames,
                world_names: [],
                novelai_settings: d.novel.fileContents,
                novelai_setting_names: d.novel.fileNames,
                openai_settings: d.openai.fileContents,
                openai_setting_names: d.openai.fileNames,
                textgenerationwebui_presets: d.textgen.fileContents,
                textgenerationwebui_preset_names: d.textgen.fileNames,
                themes: d.themes,
                movingUIPresets: d.movingUIPresets,
                quickReplyPresets: d.quickReplyPresets,
                instruct: d.instruct,
                context: d.context,
                sysprompt: d.sysprompt,
                reasoning: d.reasoning,
                enable_extensions: false,
                enable_extensions_auto_update: false,
                enable_accounts: false,
                request_compression: { enabled: false, minPayloadSize: 0, maxPayloadSize: 0, timeout: 0 },
            };
        },
        'POST:/api/settings/save': async (url, init) => {
            const body = init && init.body ? JSON.parse(init.body) : {};
            // The frontend posts the settings object directly; persist as a string.
            await fsSet('settings', JSON.stringify(body));
            return { result: 'ok' };
        },
        'POST:/api/settings/get-snapshots': async () => [],

        // -- secrets ------------------------------------------------------------
        'POST:/api/secrets/read': async () => buildSecretState(await getSecretsStore()),
        'POST:/api/secrets/write': async (url, init) => {
            const { key, value, label } = JSON.parse(init.body);
            const store = await getSecretsStore();
            const arr = Array.isArray(store[key]) ? store[key] : [];
            arr.forEach(x => { x.active = false; });
            const id = makeSecretId();
            arr.push({ id, label: label || '', value, active: true });
            store[key] = arr;
            await fsSet('secrets', store);
            return { id };
        },
        'POST:/api/secrets/find': async (url, init) => {
            const { key, id } = JSON.parse(init.body);
            const store = await getSecretsStore();
            const arr = store[key];
            if (!Array.isArray(arr) || !arr.length) return { value: '' };
            const found = id ? arr.find(x => x.id === id) : (arr.find(x => x.active) || arr[0]);
            return { value: found ? found.value : '' };
        },
        'POST:/api/secrets/delete': async (url, init) => {
            const { key, id } = JSON.parse(init.body);
            const store = await getSecretsStore();
            if (Array.isArray(store[key])) {
                store[key] = id ? store[key].filter(x => x.id !== id) : store[key].filter(x => x.active === false);
                if (store[key].length && !store[key].some(x => x.active)) store[key][0].active = true;
                if (!store[key].length) delete store[key];
                await fsSet('secrets', store);
            }
            return { ok: true };
        },
        'POST:/api/secrets/rotate': async (url, init) => {
            const { key, id } = JSON.parse(init.body);
            const store = await getSecretsStore();
            if (Array.isArray(store[key])) {
                store[key].forEach(x => { x.active = (x.id === id); });
                await fsSet('secrets', store);
            }
            return { ok: true };
        },
        'POST:/api/secrets/settings': async () => ({ allowKeysExposure: true }),
        'POST:/api/secrets/view': async () => buildSecretState(await getSecretsStore()),

        // -- characters ---------------------------------------------------------
        'POST:/api/characters/all': async () => {
            const keys = await fsKeys();
            const list = [];
            for (const k of keys.filter(k => typeof k === 'string' && k.startsWith('character:'))) {
                const c = await fsGet(k);
                if (c) list.push(c);
            }
            return list;
        },
        'POST:/api/characters/get': async (url, init) => {
            const { avatar } = JSON.parse(init.body);
            return (await fsGet('character:' + avatar)) || {};
        },
        'POST:/api/characters/create': async (url, init) => {
            const body = init && init.body ? JSON.parse(init.body) : {};
            const avatar = (body.ch_name ? body.ch_name.replace(/[^a-z0-9]/gi, '_') : 'char') + '_' + makeSecretId() + '.png';
            const char = buildCharacterObject(body, avatar);
            await fsSet('character:' + avatar, char);
            return avatar;
        },
        'POST:/api/characters/edit': async (url, init) => {
            const body = init && init.body ? JSON.parse(init.body) : {};
            const avatar = body.avatar_url || body.avatar;
            if (avatar) {
                const existing = (await fsGet('character:' + avatar)) || {};
                const updated = buildCharacterObject(body, avatar, existing);
                await fsSet('character:' + avatar, updated);
            }
            return { ok: true };
        },
        'POST:/api/characters/delete': async (url, init) => {
            const body = init && init.body ? JSON.parse(init.body) : {};
            const avatar = body.avatar_url || body.avatar;
            if (avatar) await fsDelete('character:' + avatar);
            return { ok: true };
        },
        'POST:/api/characters/chats': async () => [],

        // -- chats --------------------------------------------------------------
        'POST:/api/chats/get': async (url, init) => {
            const body = init && init.body ? JSON.parse(init.body) : {};
            const key = 'chat:' + body.avatar_url + ':' + body.file_name;
            return (await fsGet(key)) || [];
        },
        'POST:/api/chats/save': async (url, init) => {
            const body = init && init.body ? JSON.parse(init.body) : {};
            const key = 'chat:' + body.avatar_url + ':' + body.file_name;
            await fsSet(key, body.chat || []);
            return { result: 'ok' };
        },
        'POST:/api/chats/delete': async (url, init) => {
            const body = init && init.body ? JSON.parse(init.body) : {};
            await fsDelete('chat:' + body.avatar_url + ':' + body.chatfile);
            return { ok: true };
        },
        'POST:/api/chats/rename': async () => ({ ok: true }),
        'POST:/api/chats/search': async () => [],
        'POST:/api/chats/group/get': async () => [],
        'POST:/api/chats/group/save': async () => ({ ok: true }),

        // -- avatars / backgrounds / groups (lists) -----------------------------
        'POST:/api/avatars/get': async () => [],
        'POST:/api/backgrounds/all': async () => [],
        'POST:/api/groups/all': async () => [],

        // -- generation ---------------------------------------------------------
        'POST:/api/backends/chat-completions/generate': async (url, init) => {
            const generateData = JSON.parse(init.body);
            const reply = await callProvider(generateData);
            return buildGenerationResponse(reply, !!generateData.stream);
        },
        'POST:/api/backends/chat-completions/status': async (url, init) => {
            // Report connection as valid; we can't reliably list models for every
            // provider without extra calls, so return an empty model list.
            return { data: [] };
        },
    };

    // Assemble a character card object from a create/edit form post.
    function buildCharacterObject(body, avatar, existing) {
        existing = existing || {};
        const name = body.ch_name || body.name || existing.name || 'Unnamed';
        return {
            name,
            avatar,
            description: body.description ?? existing.description ?? '',
            personality: body.personality ?? existing.personality ?? '',
            scenario: body.scenario ?? existing.scenario ?? '',
            first_mes: body.first_mes ?? existing.first_mes ?? '',
            mes_example: body.mes_example ?? existing.mes_example ?? '',
            creatorcomment: body.creator_notes ?? existing.creatorcomment ?? '',
            tags: existing.tags || [],
            talkativeness: body.talkativeness ?? existing.talkativeness ?? '0.5',
            fav: existing.fav || false,
            create_date: existing.create_date || '',
            chat: existing.chat || (name + ' - chat'),
            data: {
                name,
                description: body.description ?? existing.description ?? '',
                personality: body.personality ?? existing.personality ?? '',
                scenario: body.scenario ?? existing.scenario ?? '',
                first_mes: body.first_mes ?? existing.first_mes ?? '',
                mes_example: body.mes_example ?? existing.mes_example ?? '',
                creator_notes: body.creator_notes ?? '',
                system_prompt: body.system_prompt ?? '',
                post_history_instructions: body.post_history_instructions ?? '',
                tags: [],
                creator: body.creator ?? '',
                character_version: body.character_version ?? '',
                alternate_greetings: existing?.data?.alternate_greetings || [],
                extensions: existing?.data?.extensions || {},
            },
        };
    }

    // Endpoints whose callers expect a JSON array when we have nothing to return.
    const ARRAY_FALLBACK = /\/(all|get|list|recent|search|discover|chats|presets)\b/;

    // ------------------------------------------------------------- fetch shim
    window.fetch = async function (resource, init) {
        let urlStr;
        try {
            urlStr = typeof resource === 'string' ? resource : (resource && resource.url) || String(resource);
        } catch {
            return originalFetch(resource, init);
        }

        let path = urlStr;
        if (path.startsWith(window.location.origin)) {
            path = path.slice(window.location.origin.length);
        }
        // Ignore the query string for matching.
        const cleanPath = path.split('?')[0];

        // Only intercept same-origin app endpoints; everything else (provider
        // APIs, bundled assets fetched without a leading slash, etc.) passes through.
        const isAppEndpoint = cleanPath.startsWith('/api/') ||
            cleanPath === '/csrf-token' || cleanPath === '/version';

        // Decide emulation lazily, per request (see shouldEmulate comment above).
        if (!isAppEndpoint || !shouldEmulate()) {
            if (typeof window !== 'undefined') window.__stMode = isAppEndpoint ? 'passthrough' : window.__stMode;
            return originalFetch(resource, init);
        }

        if (typeof window !== 'undefined') {
            window.__stMode = 'emulated (serverless)';
            window.__stLastReq = ((init && init.method) || 'GET').toUpperCase() + ' ' + cleanPath;
        }

        const method = ((init && init.method) || (resource && resource.method) || 'GET').toUpperCase();
        const handlerKey = method + ':' + cleanPath;

        const handler = handlers[handlerKey] ||
            // Fall back to a method-agnostic match (some calls vary GET/POST).
            handlers['POST:' + cleanPath] || handlers['GET:' + cleanPath];

        if (handler) {
            try {
                const result = await handler(urlStr, init || {});
                if (result instanceof Response) return result;
                return new Response(JSON.stringify(result), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (err) {
                console.error('[Mobile Bridge] Handler error for ' + handlerKey + ':', err);
                return new Response(JSON.stringify({ error: { message: err && err.message ? err.message : String(err) } }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        // Unhandled app endpoint: return a benign empty value so callers that
        // don't guard their .json() don't throw. Arrays for list-like paths.
        console.warn('[Mobile Bridge] Unhandled endpoint, returning empty: ' + handlerKey);
        const empty = ARRAY_FALLBACK.test(cleanPath) ? '[]' : '{}';
        return new Response(empty, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };

    console.log('[Mobile Bridge] fetch override installed.');
})();
