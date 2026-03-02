/**
 * KnowledgeGraphService for RepoSpector
 *
 * In-memory knowledge graph with IndexedDB persistence.
 * Stores code symbols (functions, classes, methods) and their relationships
 * (CALLS, IMPORTS, DEFINES, EXTENDS, IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS).
 *
 * Inspired by GitNexus's graph architecture, adapted for Chrome extension constraints.
 */

const DB_NAME = 'repospector_knowledge_graph';
const DB_VERSION = 1;
const NODE_STORE = 'graph_nodes';
const REL_STORE = 'graph_relationships';
const META_STORE = 'graph_meta';

export class KnowledgeGraphService {
    constructor() {
        this.nodes = new Map();
        this.relationships = new Map();
        this.db = null;

        this._forwardAdj = null;
        this._reverseAdj = null;
    }

    async init() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains(NODE_STORE)) {
                    const nodeStore = db.createObjectStore(NODE_STORE, { keyPath: 'id' });
                    nodeStore.createIndex('repoId', 'repoId', { unique: false });
                    nodeStore.createIndex('label', 'label', { unique: false });
                }

                if (!db.objectStoreNames.contains(REL_STORE)) {
                    const relStore = db.createObjectStore(REL_STORE, { keyPath: 'id' });
                    relStore.createIndex('repoId', 'repoId', { unique: false });
                    relStore.createIndex('type', 'type', { unique: false });
                    relStore.createIndex('sourceId', 'sourceId', { unique: false });
                    relStore.createIndex('targetId', 'targetId', { unique: false });
                }

                if (!db.objectStoreNames.contains(META_STORE)) {
                    db.createObjectStore(META_STORE, { keyPath: 'repoId' });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };

            request.onerror = () => reject(request.error);
        });
    }

    addNode(node) {
        if (!this.nodes.has(node.id)) {
            this.nodes.set(node.id, node);
            this._invalidateAdjacency();
        }
    }

    addRelationship(rel) {
        if (!this.relationships.has(rel.id)) {
            this.relationships.set(rel.id, rel);
            this._invalidateAdjacency();
        }
    }

    getNode(id) {
        return this.nodes.get(id) || null;
    }

    getAllNodes() {
        return Array.from(this.nodes.values());
    }

    getNodesByLabel(label) {
        const result = [];
        for (const node of this.nodes.values()) {
            if (node.label === label) result.push(node);
        }
        return result;
    }

    getNodesByFile(filePath) {
        const result = [];
        for (const node of this.nodes.values()) {
            if (node.properties?.filePath === filePath) result.push(node);
        }
        return result;
    }

    findNodeByName(name) {
        const matches = [];
        for (const node of this.nodes.values()) {
            if (node.properties?.name === name) matches.push(node);
        }
        return matches;
    }

    getRelationshipsFrom(nodeId) {
        const result = [];
        for (const rel of this.relationships.values()) {
            if (rel.sourceId === nodeId) result.push(rel);
        }
        return result;
    }

    getRelationshipsTo(nodeId) {
        const result = [];
        for (const rel of this.relationships.values()) {
            if (rel.targetId === nodeId) result.push(rel);
        }
        return result;
    }

    getRelationshipsByType(type) {
        const result = [];
        for (const rel of this.relationships.values()) {
            if (rel.type === type) result.push(rel);
        }
        return result;
    }

    get nodeCount() {
        return this.nodes.size;
    }

    get relationshipCount() {
        return this.relationships.size;
    }

    getForwardAdjacency() {
        if (this._forwardAdj) return this._forwardAdj;

        this._forwardAdj = new Map();
        for (const rel of this.relationships.values()) {
            if (rel.type === 'CALLS') {
                if (!this._forwardAdj.has(rel.sourceId)) {
                    this._forwardAdj.set(rel.sourceId, []);
                }
                this._forwardAdj.get(rel.sourceId).push({
                    targetId: rel.targetId,
                    confidence: rel.confidence,
                    reason: rel.reason
                });
            }
        }
        return this._forwardAdj;
    }

    getReverseAdjacency() {
        if (this._reverseAdj) return this._reverseAdj;

        this._reverseAdj = new Map();
        for (const rel of this.relationships.values()) {
            if (rel.type === 'CALLS') {
                if (!this._reverseAdj.has(rel.targetId)) {
                    this._reverseAdj.set(rel.targetId, []);
                }
                this._reverseAdj.get(rel.targetId).push({
                    sourceId: rel.sourceId,
                    confidence: rel.confidence,
                    reason: rel.reason
                });
            }
        }
        return this._reverseAdj;
    }

    _invalidateAdjacency() {
        this._forwardAdj = null;
        this._reverseAdj = null;
    }

    /**
     * Persist current graph to IndexedDB for a repo
     */
    async save(repoId) {
        await this.init();

        const tx = this.db.transaction([NODE_STORE, REL_STORE, META_STORE], 'readwrite');

        const nodeStore = tx.objectStore(NODE_STORE);
        const relStore = tx.objectStore(REL_STORE);
        const metaStore = tx.objectStore(META_STORE);

        // Clear existing data for this repo
        await this._clearIndex(nodeStore, 'repoId', repoId);
        await this._clearIndex(relStore, 'repoId', repoId);

        for (const node of this.nodes.values()) {
            nodeStore.put({ ...node, repoId });
        }

        for (const rel of this.relationships.values()) {
            relStore.put({ ...rel, repoId });
        }

        metaStore.put({
            repoId,
            nodeCount: this.nodes.size,
            relationshipCount: this.relationships.size,
            timestamp: Date.now()
        });

        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Load graph for a specific repo from IndexedDB
     */
    async load(repoId) {
        await this.init();

        this.clear();

        const tx = this.db.transaction([NODE_STORE, REL_STORE], 'readonly');

        const nodes = await this._getAllByIndex(tx.objectStore(NODE_STORE), 'repoId', repoId);
        const rels = await this._getAllByIndex(tx.objectStore(REL_STORE), 'repoId', repoId);

        for (const node of nodes) {
            const { repoId: _rid, ...cleanNode } = node;
            this.nodes.set(cleanNode.id, cleanNode);
        }

        for (const rel of rels) {
            const { repoId: _rid, ...cleanRel } = rel;
            this.relationships.set(cleanRel.id, cleanRel);
        }

        this._invalidateAdjacency();
        return { nodeCount: this.nodes.size, relationshipCount: this.relationships.size };
    }

    /**
     * Check if a graph exists for a repo
     */
    async hasGraph(repoId) {
        await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([META_STORE], 'readonly');
            const request = tx.objectStore(META_STORE).get(repoId);
            request.onsuccess = () => resolve(!!request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete graph for a repo
     */
    async delete(repoId) {
        await this.init();

        const tx = this.db.transaction([NODE_STORE, REL_STORE, META_STORE], 'readwrite');

        await this._clearIndex(tx.objectStore(NODE_STORE), 'repoId', repoId);
        await this._clearIndex(tx.objectStore(REL_STORE), 'repoId', repoId);
        tx.objectStore(META_STORE).delete(repoId);

        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    clear() {
        this.nodes.clear();
        this.relationships.clear();
        this._invalidateAdjacency();
    }

    getStats() {
        const labels = {};
        for (const node of this.nodes.values()) {
            labels[node.label] = (labels[node.label] || 0) + 1;
        }

        const relTypes = {};
        for (const rel of this.relationships.values()) {
            relTypes[rel.type] = (relTypes[rel.type] || 0) + 1;
        }

        return {
            nodeCount: this.nodes.size,
            relationshipCount: this.relationships.size,
            nodesByLabel: labels,
            relationshipsByType: relTypes
        };
    }

    /**
     * Generate a deterministic node/relationship ID
     */
    static generateId(label, qualifier) {
        return `${label}:${qualifier}`;
    }

    // --- IndexedDB helpers ---

    _getAllByIndex(store, indexName, value) {
        return new Promise((resolve, reject) => {
            const request = store.index(indexName).getAll(value);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    _clearIndex(store, indexName, value) {
        return new Promise((resolve, reject) => {
            const index = store.index(indexName);
            const request = index.openCursor(IDBKeyRange.only(value));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
}

export default KnowledgeGraphService;
