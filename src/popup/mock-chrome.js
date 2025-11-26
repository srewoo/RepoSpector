console.log('🔧 Initializing Mock Chrome API');

if (typeof window.chrome === 'undefined') {
    window.chrome = {};
}

if (!window.chrome.runtime) {
    window.chrome.runtime = {
        sendMessage: (message) => {
            console.log('Mock sendMessage:', message);
            return Promise.resolve({ success: true, data: 'Mock response' });
        },
        onMessage: {
            addListener: (callback) => {
                console.log('Mock onMessage listener added');
            },
            removeListener: (callback) => {
                console.log('Mock onMessage listener removed');
            }
        }
    };
}

if (!window.chrome.tabs) {
    window.chrome.tabs = {
        query: (queryInfo) => {
            console.log('Mock tabs.query:', queryInfo);
            return Promise.resolve([{
                id: 123,
                url: 'https://github.com/owner/repo/blob/main/src/utils/math.js',
                title: 'Mock GitHub Page'
            }]);
        }
    };
}

if (!window.chrome.storage) {
    window.chrome.storage = {
        local: {
            get: (keys, callback) => {
                console.log('Mock storage.local.get:', keys);
                const result = {};
                const keyList = Array.isArray(keys) ? keys : [keys];
                keyList.forEach(key => {
                    const value = localStorage.getItem(key);
                    if (value) {
                        try {
                            result[key] = JSON.parse(value);
                        } catch (e) {
                            result[key] = value;
                        }
                    }
                });
                if (callback) callback(result);
                return Promise.resolve(result);
            },
            set: (items, callback) => {
                console.log('Mock storage.local.set:', items);
                Object.entries(items).forEach(([key, value]) => {
                    localStorage.setItem(key, JSON.stringify(value));
                });
                if (callback) callback();
                return Promise.resolve();
            }
        }
    };
}
