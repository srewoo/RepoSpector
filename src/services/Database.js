export const DB_NAME = 'RepoSpectorDB';
export const DB_VERSION = 4;

let dbPromise = null;

export async function getDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            console.error('Database connection error:', request.error);
            reject(request.error);
        };

        request.onsuccess = () => {
            resolve(request.result);
        };

        request.onupgradeneeded = () => {
            const db = request.result;

            // 1. VectorStore
            if (!db.objectStoreNames.contains('repo_vectors')) {
                const store = db.createObjectStore('repo_vectors', { keyPath: 'id' });
                store.createIndex('repoId', 'repoId', { unique: false });
                store.createIndex('filePath', 'filePath', { unique: false });
            }

            // 2. PRSessionManager
            if (!db.objectStoreNames.contains('pr_sessions')) {
                const store = db.createObjectStore('pr_sessions', { keyPath: 'sessionId' });
                store.createIndex('prUrl', 'prUrl', { unique: false });
                store.createIndex('repoId', 'repoId', { unique: false });
                store.createIndex('createdAt', 'createdAt', { unique: false });
                store.createIndex('updatedAt', 'updatedAt', { unique: false });
            }

            // 3. PRThreadManager
            if (!db.objectStoreNames.contains('pr_threads')) {
                const store = db.createObjectStore('pr_threads', { keyPath: 'threadId' });
                store.createIndex('sessionId', 'sessionId', { unique: false });
                store.createIndex('prUrl', 'prIdentifier.url', { unique: false });
                store.createIndex('updatedAt', 'updatedAt', { unique: false });
                store.createIndex('status', 'status', { unique: false });
            }

            // 4. ReviewMetricsService
            if (!db.objectStoreNames.contains('review_metrics')) {
                const store = db.createObjectStore('review_metrics', {
                    keyPath: 'id',
                    autoIncrement: true
                });
                store.createIndex('repoId', 'repoId', { unique: false });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('prUrl', 'prUrl', { unique: false });
            }
        };
    });

    return dbPromise;
}
