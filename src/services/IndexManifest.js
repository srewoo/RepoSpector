/**
 * Index Manifest for RepoSpector
 *
 * Tracks file hashes and chunk mappings for incremental indexing.
 * Enables efficient re-indexing of only changed files.
 */

/**
 * Calculate hash for content (using FNV-1a algorithm for speed)
 */
export function hashContent(content) {
    if (!content) return '0';

    let hash = 2166136261; // FNV offset basis
    for (let i = 0; i < content.length; i++) {
        hash ^= content.charCodeAt(i);
        hash = (hash * 16777619) >>> 0; // FNV prime, unsigned
    }
    return hash.toString(16);
}

/**
 * Index Manifest class
 */
export class IndexManifest {
    constructor(repoId, options = {}) {
        this.repoId = repoId;
        this.version = options.version || 1;

        // File entries: Map<filePath, FileEntry>
        // FileEntry: { hash, chunkIds, lastIndexed, size, language }
        this.files = new Map();

        // Chunk to file mapping: Map<chunkId, filePath>
        this.chunkToFile = new Map();

        // Metadata
        this.metadata = {
            createdAt: Date.now(),
            updatedAt: Date.now(),
            totalFiles: 0,
            totalChunks: 0,
            indexVersion: options.indexVersion || '1.0'
        };
    }

    /**
     * Add or update a file entry
     * @param {string} filePath
     * @param {string} content - Full file content
     * @param {Array<string>} chunkIds
     * @param {Object} metadata
     * @param {Object} chunkHashes - Optional Map/Object of chunkId -> contentHash for chunk-level caching
     */
    addFile(filePath, content, chunkIds = [], metadata = {}, chunkHashes = null) {
        const hash = hashContent(content);
        const existingEntry = this.files.get(filePath);

        // Remove old chunk mappings
        if (existingEntry) {
            for (const chunkId of existingEntry.chunkIds) {
                this.chunkToFile.delete(chunkId);
            }
            this.metadata.totalChunks -= existingEntry.chunkIds.length;
        }

        // Add new entry
        const entry = {
            hash,
            chunkIds,
            chunkHashes: chunkHashes || {},
            lastIndexed: Date.now(),
            size: content?.length || 0,
            language: metadata.language || this.detectLanguage(filePath),
            ...metadata
        };

        this.files.set(filePath, entry);

        // Update chunk mappings
        for (const chunkId of chunkIds) {
            this.chunkToFile.set(chunkId, filePath);
        }

        // Update metadata
        if (!existingEntry) {
            this.metadata.totalFiles++;
        }
        this.metadata.totalChunks += chunkIds.length;
        this.metadata.updatedAt = Date.now();

        return entry;
    }

    /**
     * Compare chunks of a changed file against new chunks
     * Returns which chunks can be reused vs which need re-embedding
     *
     * @param {string} filePath
     * @param {Array<{id: string, content: string}>} newChunks - New chunks with id and content
     * @returns {{ reuse: string[], reEmbed: string[], remove: string[] }}
     */
    compareChunks(filePath, newChunks) {
        const entry = this.files.get(filePath);
        const oldChunkHashes = entry?.chunkHashes || {};
        const oldChunkIds = new Set(entry?.chunkIds || []);

        const result = {
            reuse: [],    // Chunk IDs where content hash matches — skip embedding
            reEmbed: [],  // Chunk IDs where content changed or is new — need embedding
            remove: []    // Old chunk IDs no longer present — delete from store
        };

        const newChunkIds = new Set();

        for (const chunk of newChunks) {
            newChunkIds.add(chunk.id);
            const newHash = hashContent(chunk.content);
            const oldHash = oldChunkHashes[chunk.id];

            if (oldHash && oldHash === newHash) {
                result.reuse.push(chunk.id);
            } else {
                result.reEmbed.push(chunk.id);
            }
        }

        // Find chunks that existed before but are gone now
        for (const oldId of oldChunkIds) {
            if (!newChunkIds.has(oldId)) {
                result.remove.push(oldId);
            }
        }

        return result;
    }

    /**
     * Remove a file from the manifest
     */
    removeFile(filePath) {
        const entry = this.files.get(filePath);
        if (!entry) return null;

        // Remove chunk mappings
        for (const chunkId of entry.chunkIds) {
            this.chunkToFile.delete(chunkId);
        }

        // Remove file entry
        this.files.delete(filePath);

        // Update metadata
        this.metadata.totalFiles--;
        this.metadata.totalChunks -= entry.chunkIds.length;
        this.metadata.updatedAt = Date.now();

        return entry;
    }

    /**
     * Get file entry
     */
    getFile(filePath) {
        return this.files.get(filePath);
    }

    /**
     * Check if file has changed
     */
    hasFileChanged(filePath, newContent) {
        const entry = this.files.get(filePath);
        if (!entry) return true; // New file

        const newHash = hashContent(newContent);
        return entry.hash !== newHash;
    }

    /**
     * Compare manifest with new file list
     * Returns { toAdd, toUpdate, toRemove, unchanged }
     */
    compare(newFiles) {
        const result = {
            toAdd: [],      // Files not in manifest
            toUpdate: [],   // Files with different hash
            toRemove: [],   // Files in manifest but not in newFiles
            unchanged: []   // Files with same hash
        };

        const newFilePaths = new Set();

        for (const file of newFiles) {
            const { path, content } = file;
            newFilePaths.add(path);

            const existingEntry = this.files.get(path);

            if (!existingEntry) {
                result.toAdd.push(file);
            } else {
                const newHash = hashContent(content);
                if (existingEntry.hash !== newHash) {
                    result.toUpdate.push({
                        ...file,
                        oldChunkIds: existingEntry.chunkIds
                    });
                } else {
                    result.unchanged.push(path);
                }
            }
        }

        // Find removed files
        for (const [filePath] of this.files) {
            if (!newFilePaths.has(filePath)) {
                result.toRemove.push({
                    path: filePath,
                    chunkIds: this.files.get(filePath).chunkIds
                });
            }
        }

        return result;
    }

    /**
     * Get chunk IDs for a file
     */
    getChunkIds(filePath) {
        const entry = this.files.get(filePath);
        return entry ? entry.chunkIds : [];
    }

    /**
     * Get file path for a chunk
     */
    getFileForChunk(chunkId) {
        return this.chunkToFile.get(chunkId);
    }

    /**
     * Get all chunk IDs
     */
    getAllChunkIds() {
        return Array.from(this.chunkToFile.keys());
    }

    /**
     * Get all file paths
     */
    getAllFilePaths() {
        return Array.from(this.files.keys());
    }

    /**
     * Detect language from file extension
     */
    detectLanguage(filePath) {
        const ext = filePath.split('.').pop()?.toLowerCase();
        const languageMap = {
            'js': 'javascript',
            'jsx': 'javascript',
            'ts': 'typescript',
            'tsx': 'typescript',
            'py': 'python',
            'java': 'java',
            'rb': 'ruby',
            'go': 'go',
            'rs': 'rust',
            'c': 'c',
            'cpp': 'cpp',
            'h': 'c',
            'hpp': 'cpp',
            'cs': 'csharp',
            'php': 'php',
            'swift': 'swift',
            'kt': 'kotlin',
            'scala': 'scala',
            'vue': 'vue',
            'svelte': 'svelte',
            'html': 'html',
            'css': 'css',
            'scss': 'scss',
            'less': 'less',
            'json': 'json',
            'yaml': 'yaml',
            'yml': 'yaml',
            'md': 'markdown',
            'sql': 'sql'
        };

        return languageMap[ext] || 'unknown';
    }

    /**
     * Get statistics
     */
    getStats() {
        const stats = {
            repoId: this.repoId,
            ...this.metadata,
            filesByLanguage: {},
            averageChunksPerFile: 0
        };

        // Count files by language
        for (const [, entry] of this.files) {
            const lang = entry.language || 'unknown';
            stats.filesByLanguage[lang] = (stats.filesByLanguage[lang] || 0) + 1;
        }

        // Calculate average chunks per file
        if (this.metadata.totalFiles > 0) {
            stats.averageChunksPerFile =
                this.metadata.totalChunks / this.metadata.totalFiles;
        }

        return stats;
    }

    /**
     * Export manifest to JSON
     */
    toJSON() {
        return {
            repoId: this.repoId,
            version: this.version,
            metadata: this.metadata,
            files: Array.from(this.files.entries()).map(([path, entry]) => ({
                path,
                ...entry
            })),
            chunkToFile: Array.from(this.chunkToFile.entries())
        };
    }

    /**
     * Import manifest from JSON
     */
    static fromJSON(json) {
        const manifest = new IndexManifest(json.repoId, {
            version: json.version,
            indexVersion: json.metadata?.indexVersion
        });

        manifest.metadata = json.metadata || manifest.metadata;

        // Restore files
        for (const file of json.files || []) {
            const { path, ...entry } = file;
            manifest.files.set(path, entry);
        }

        // Restore chunk mappings
        for (const [chunkId, filePath] of json.chunkToFile || []) {
            manifest.chunkToFile.set(chunkId, filePath);
        }

        return manifest;
    }

    /**
     * Clear manifest
     */
    clear() {
        this.files.clear();
        this.chunkToFile.clear();
        this.metadata.totalFiles = 0;
        this.metadata.totalChunks = 0;
        this.metadata.updatedAt = Date.now();
    }
}

/**
 * Manifest Store - manages manifests in IndexedDB
 */
export class ManifestStore {
    constructor(dbName = 'RepoSpectorManifests') {
        this.dbName = dbName;
        this.storeName = 'manifests';
        this.db = null;
    }

    /**
     * Initialize the database
     */
    async init() {
        if (this.db) return this.db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onerror = () => reject(request.error);

            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, {
                        keyPath: 'repoId'
                    });
                    store.createIndex('updatedAt', 'metadata.updatedAt', { unique: false });
                }
            };
        });
    }

    /**
     * Save manifest
     */
    async save(manifest) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const data = manifest.toJSON();
            const request = store.put(data);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(data);
        });
    }

    /**
     * Load manifest
     */
    async load(repoId) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(repoId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                if (request.result) {
                    resolve(IndexManifest.fromJSON(request.result));
                } else {
                    resolve(null);
                }
            };
        });
    }

    /**
     * Delete manifest
     */
    async delete(repoId) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(repoId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(true);
        });
    }

    /**
     * List all manifests
     */
    async list() {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                resolve(request.result.map(json => ({
                    repoId: json.repoId,
                    metadata: json.metadata,
                    totalFiles: json.metadata?.totalFiles || 0,
                    totalChunks: json.metadata?.totalChunks || 0
                })));
            };
        });
    }

    /**
     * Close database connection
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

export default {
    IndexManifest,
    ManifestStore,
    hashContent
};
