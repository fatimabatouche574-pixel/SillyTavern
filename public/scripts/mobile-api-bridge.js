// public/scripts/mobile-api-bridge.js
// Overrides window.fetch to mock SillyTavern's backend when running in a client-only environment (e.g. Capacitor WebView)

(function () {
    // Detect if we should enable the mobile api bridge
    // Enabled if window.Capacitor is present or if manually forced via localStorage flag
    const isMobileApp = window.Capacitor !== undefined || localStorage.getItem('st_force_mobile_api') === 'true';
    if (!isMobileApp) {
        console.log("Running in standard server-backed mode.");
        return;
    }

    console.log("Initializing SillyTavern Mobile API Bridge...");

    // IndexedDB Virtual Filesystem (VFS) Helpers
    const DB_NAME = 'SillyTavernMobileStore';
    const STORE_NAME = 'VirtualFS';

    function getDB() {
        return new Promise((resolve, reject) => {
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
    }

    async function fsGet(key) {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function fsSet(key, value) {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(value, key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async function fsDelete(key) {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async function fsKeys() {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAllKeys();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    // Seeding default content if empty
    async function seedInitialData() {
        if (localStorage.getItem('st_mobile_seeded') === 'true') return;

        try {
            console.log("Seeding default data...");
            // Seed settings
            const settingsRes = await fetch('/default-content/settings.json');
            if (settingsRes.ok) {
                const settings = await settingsRes.json();
                await fsSet('settings', settings);
            }

            // Seed user profile
            await fsSet('user_me', {
                handle: 'default-user',
                name: 'You',
                avatar: 'default-content/user-default.png'
            });

            // Seed Seraphina character (if card image is available)
            const charCardRes = await fetch('/default-content/default_Seraphina.png');
            if (charCardRes.ok) {
                const blob = await charCardRes.blob();
                const reader = new FileReader();
                const base64Data = await new Promise((resolve) => {
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
                
                const isChinese = navigator.language.toLowerCase().startsWith('zh');
                const seraphina = {
                    id: 'default_seraphina',
                    avatar: base64Data, // Save base64 image data
                    name: isChinese ? '塞拉菲娜' : 'Seraphina',
                    description: isChinese ? '一个贴心的 AI 助手。' : 'A helpful AI companion.',
                    personality: isChinese ? '温柔、体贴、善于分析。' : 'Kind, thoughtful, and analytical.',
                    first_mes: isChinese ? '你好！我是塞拉菲娜，你的默认助手。今天有什么我可以帮你的吗？' : 'Hello! I am Seraphina, your default assistant. How can I help you today?',
                    scenario: '',
                    mes_example: ''
                };
                await fsSet('character:default_seraphina', seraphina);
            }

            localStorage.setItem('st_mobile_seeded', 'true');
            console.log("Seeding complete.");
        } catch (err) {
            console.error("Failed to seed initial data:", err);
        }
    }

    // Call seed check
    seedInitialData();

    // Mock API implementations
    const apiMock = {
        'GET:/api/users/me': async () => {
            return await fsGet('user_me') || { handle: 'default-user', name: 'You', avatar: 'default-content/user-default.png' };
        },
        'GET:/api/users/get': async () => {
            return [await apiMock['GET:/api/users/me']()];
        },
        'GET:/api/settings/get': async () => {
            return await fsGet('settings') || {};
        },
        'POST:/api/settings/save': async (url, init) => {
            const body = JSON.parse(init.body);
            await fsSet('settings', body);
            return { success: true };
        },
        'POST:/api/secrets/read': async (url, init) => {
            const body = JSON.parse(init.body);
            const secrets = await fsGet('secrets') || {};
            return { value: secrets[body.key] || '' };
        },
        'POST:/api/secrets/write': async (url, init) => {
            const body = JSON.parse(init.body);
            const secrets = await fsGet('secrets') || {};
            secrets[body.key] = body.value;
            await fsSet('secrets', secrets);
            return { success: true };
        },
        'POST:/api/characters/all': async () => {
            const keys = await fsKeys();
            const charKeys = keys.filter(k => k.startsWith('character:'));
            const list = [];
            for (const key of charKeys) {
                const char = await fsGet(key);
                list.push({
                    avatar: char.id, // ID as the avatar URL reference
                    name: char.name,
                    description: char.description
                });
            }
            return list;
        },
        'POST:/api/characters/get': async (url, init) => {
            const body = JSON.parse(init.body);
            const char = await fsGet(`character:${body.avatar}`);
            return char || {};
        },
        'POST:/api/characters/create': async (url, init) => {
            const body = JSON.parse(init.body);
            const id = 'char_' + Date.now();
            const char = {
                id: id,
                avatar: body.avatar || '',
                name: body.name || 'Unnamed',
                description: body.description || '',
                personality: body.personality || '',
                first_mes: body.first_mes || '',
                scenario: body.scenario || '',
                mes_example: body.mes_example || ''
            };
            await fsSet(`character:${id}`, char);
            return { avatar: id };
        },
        'POST:/api/chats/recent': async () => {
            const recent = await fsGet('chats_recent') || [];
            return recent;
        },
        'POST:/api/chats/get': async (url, init) => {
            const body = JSON.parse(init.body);
            const key = `chat:${body.avatar}:${body.file_name}`;
            const chat = await fsGet(key);
            return chat || [];
        },
        'POST:/api/chats/save': async (url, init) => {
            const body = JSON.parse(init.body);
            const key = `chat:${body.avatar}:${body.file_name}`;
            await fsSet(key, body.chat || []);
            
            let recent = await fsGet('chats_recent') || [];
            recent = recent.filter(r => r.avatar !== body.avatar);
            recent.unshift({
                avatar: body.avatar,
                file_name: body.file_name,
                updated: Date.now()
            });
            await fsSet('chats_recent', recent);
            return { success: true };
        },
        'POST:/api/backends/chat-completions/generate': async (url, init) => {
            const requestData = JSON.parse(init.body);
            const source = requestData.chat_completion_source;
            const secrets = await fsGet('secrets') || {};
            
            let apiUrl = '';
            let apiKey = '';
            let headers = { 'Content-Type': 'application/json' };
            let body = {};

            if (source === 'openai') {
                apiUrl = requestData.reverse_proxy || 'https://api.openai.com/v1/chat/completions';
                apiKey = requestData.reverse_proxy ? requestData.proxy_password : secrets['api_key_openai'];
                headers['Authorization'] = `Bearer ${apiKey}`;
                body = {
                    model: requestData.model,
                    messages: requestData.messages.map(m => ({ role: m.role, content: m.content })),
                    temperature: requestData.temperature,
                    max_tokens: requestData.max_tokens,
                    stream: requestData.stream,
                    stop: requestData.stop
                };
            } else if (source === 'claude') {
                apiUrl = 'https://api.anthropic.com/v1/messages';
                apiKey = secrets['api_key_claude'];
                headers['x-api-key'] = apiKey;
                headers['anthropic-version'] = '2023-06-01';
                headers['anthropic-dangerous-direct-browser-access'] = 'true';
                body = {
                    model: requestData.model,
                    messages: requestData.messages.map(m => ({ role: m.role, content: m.content })),
                    max_tokens: requestData.max_tokens || 1024,
                    stream: requestData.stream
                };
            } else {
                throw new Error(`Unsupported completion source in Mobile Bridge: ${source}`);
            }

            return await fetch(apiUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body),
                signal: init.signal
            });
        }
    };

    // Override fetch
    const originalFetch = window.fetch;
    window.fetch = async function (resource, init) {
        const urlStr = typeof resource === 'string' ? resource : resource.url;
        
        let path = urlStr;
        if (path.startsWith(window.location.origin)) {
            path = path.slice(window.location.origin.length);
        }

        const method = (init && init.method) || 'GET';
        const apiKey = `${method.toUpperCase()}:${path.split('?')[0]}`;

        if (apiMock[apiKey]) {
            console.log(`[Mobile Bridge Intercept] ${apiKey}`);
            try {
                const res = await apiMock[apiKey](urlStr, init);
                if (res instanceof Response) {
                    return res;
                }
                return new Response(JSON.stringify(res), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (err) {
                console.error(`[Mobile Bridge Intercept Error] ${apiKey}:`, err);
                return new Response(JSON.stringify({ error: err.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        if (path.startsWith('/api/')) {
            console.warn(`[Mobile Bridge Warning] Unhandled API endpoint: ${apiKey}`);
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return originalFetch(resource, init);
    };

})();
