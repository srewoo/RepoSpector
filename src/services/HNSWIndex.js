/**
 * HNSWIndex - Lightweight Hierarchical Navigable Small World graph
 *
 * Pure-JS approximate nearest neighbor implementation for Chrome extensions.
 * Designed for <10k vectors at 384-1536 dimensions.
 *
 * References:
 * - Malkov & Yashunin, "Efficient and robust approximate nearest neighbor
 *   search using Hierarchical Navigable Small World graphs" (2016)
 */

export class HNSWIndex {
    constructor(options = {}) {
        this.M = options.M || 16;                           // Max connections per layer
        this.Mmax0 = options.Mmax0 || this.M * 2;          // Max connections at layer 0
        this.efConstruction = options.efConstruction || 200; // Search width during build
        this.efSearch = options.efSearch || 50;              // Search width during query
        this.mL = 1.0 / Math.log(this.M);                  // Level generation factor

        this.nodes = new Map();     // id -> { vector, neighbors: [Map<id, true>] }
        this.entryPoint = null;
        this.maxLevel = -1;
    }

    get size() {
        return this.nodes.size;
    }

    /**
     * Insert a vector into the index
     */
    insert(id, vector) {
        const level = this._randomLevel();
        const node = {
            vector,
            neighbors: []
        };
        for (let i = 0; i <= level; i++) {
            node.neighbors.push(new Map());
        }
        this.nodes.set(id, node);

        if (this.entryPoint === null) {
            this.entryPoint = id;
            this.maxLevel = level;
            return;
        }

        let currObj = this.entryPoint;

        // Phase 1: Greedy descent from top to level+1
        for (let lc = this.maxLevel; lc > level; lc--) {
            const nearest = this._searchLayer(vector, [currObj], 1, lc);
            currObj = nearest[0].id;
        }

        // Phase 2: Insert at each layer from min(level, maxLevel) down to 0
        for (let lc = Math.min(level, this.maxLevel); lc >= 0; lc--) {
            const candidates = this._searchLayer(vector, [currObj], this.efConstruction, lc);
            const maxConn = lc === 0 ? this.Mmax0 : this.M;
            const neighbors = this._selectNeighbors(vector, candidates, maxConn);

            // Connect new node to selected neighbors (bidirectional)
            for (const nb of neighbors) {
                node.neighbors[lc].set(nb.id, true);

                const nbNode = this.nodes.get(nb.id);
                if (nbNode && nbNode.neighbors[lc]) {
                    nbNode.neighbors[lc].set(id, true);
                    // Prune neighbor if over capacity
                    if (nbNode.neighbors[lc].size > maxConn) {
                        this._pruneConnections(nb.id, lc, maxConn);
                    }
                }
            }

            if (candidates.length > 0) {
                currObj = candidates[0].id;
            }
        }

        if (level > this.maxLevel) {
            this.entryPoint = id;
            this.maxLevel = level;
        }
    }

    /**
     * Search for k nearest neighbors
     * @returns {Array<{id, distance}>} sorted by distance ascending
     */
    search(queryVector, k = 10) {
        if (!this.entryPoint || this.nodes.size === 0) return [];

        let currObj = this.entryPoint;

        // Greedy descent from top to layer 1
        for (let lc = this.maxLevel; lc > 0; lc--) {
            const nearest = this._searchLayer(queryVector, [currObj], 1, lc);
            currObj = nearest[0].id;
        }

        // Search at layer 0 with efSearch width
        const ef = Math.max(this.efSearch, k);
        const candidates = this._searchLayer(queryVector, [currObj], ef, 0);

        // Return top-k
        return candidates.slice(0, k);
    }

    /**
     * Remove a vector from the index
     */
    remove(id) {
        const node = this.nodes.get(id);
        if (!node) return;

        // Disconnect from all neighbors
        for (let lc = 0; lc < node.neighbors.length; lc++) {
            for (const nbId of node.neighbors[lc].keys()) {
                const nbNode = this.nodes.get(nbId);
                if (nbNode && nbNode.neighbors[lc]) {
                    nbNode.neighbors[lc].delete(id);
                }
            }
        }

        this.nodes.delete(id);

        // Update entry point if we deleted it
        if (this.entryPoint === id) {
            if (this.nodes.size === 0) {
                this.entryPoint = null;
                this.maxLevel = -1;
            } else {
                this.entryPoint = this.nodes.keys().next().value;
                this.maxLevel = this.nodes.get(this.entryPoint).neighbors.length - 1;
            }
        }
    }

    /**
     * Search a single layer using greedy beam search
     * @returns {Array<{id, distance}>} sorted by distance ascending
     */
    _searchLayer(queryVector, entryPointIds, ef, layer) {
        const visited = new Set(entryPointIds);

        // candidates: min-heap by distance (closest first)
        // results: max-heap by distance (farthest first for pruning)
        const candidates = [];
        const results = [];

        for (const epId of entryPointIds) {
            const epNode = this.nodes.get(epId);
            if (!epNode) continue;
            const dist = this._cosineDistance(queryVector, epNode.vector);
            candidates.push({ id: epId, distance: dist });
            results.push({ id: epId, distance: dist });
        }

        candidates.sort((a, b) => a.distance - b.distance);
        results.sort((a, b) => b.distance - a.distance); // farthest first

        while (candidates.length > 0) {
            const nearest = candidates.shift(); // closest unprocessed
            const farthest = results[0];        // farthest result

            if (nearest.distance > farthest.distance) break;

            // Explore neighbors of nearest candidate
            const nearestNode = this.nodes.get(nearest.id);
            if (!nearestNode || !nearestNode.neighbors[layer]) continue;

            for (const nbId of nearestNode.neighbors[layer].keys()) {
                if (visited.has(nbId)) continue;
                visited.add(nbId);

                const nbNode = this.nodes.get(nbId);
                if (!nbNode) continue;

                const dist = this._cosineDistance(queryVector, nbNode.vector);
                const farthestResult = results[0];

                if (results.length < ef || dist < farthestResult.distance) {
                    candidates.push({ id: nbId, distance: dist });
                    candidates.sort((a, b) => a.distance - b.distance);

                    results.push({ id: nbId, distance: dist });
                    results.sort((a, b) => b.distance - a.distance);

                    if (results.length > ef) {
                        results.shift(); // Remove farthest
                    }
                }
            }
        }

        return results.sort((a, b) => a.distance - b.distance);
    }

    /**
     * Select best neighbors using simple distance heuristic
     */
    _selectNeighbors(queryVector, candidates, M) {
        return candidates
            .sort((a, b) => a.distance - b.distance)
            .slice(0, M);
    }

    /**
     * Prune connections when a node has too many neighbors
     */
    _pruneConnections(nodeId, layer, maxConn) {
        const node = this.nodes.get(nodeId);
        if (!node || !node.neighbors[layer]) return;

        const neighbors = Array.from(node.neighbors[layer].keys());
        if (neighbors.length <= maxConn) return;

        // Score all neighbors by distance and keep closest
        const scored = neighbors.map(nbId => {
            const nbNode = this.nodes.get(nbId);
            const dist = nbNode ? this._cosineDistance(node.vector, nbNode.vector) : Infinity;
            return { id: nbId, distance: dist };
        }).sort((a, b) => a.distance - b.distance);

        // Rebuild neighbor set with only top maxConn
        node.neighbors[layer] = new Map();
        for (let i = 0; i < Math.min(maxConn, scored.length); i++) {
            node.neighbors[layer].set(scored[i].id, true);
        }
    }

    /**
     * Random level generation (geometric distribution)
     */
    _randomLevel() {
        let level = 0;
        while (Math.random() < (1.0 / this.M) && level < 16) {
            level++;
        }
        return level;
    }

    /**
     * Cosine distance (1 - cosine_similarity) with loop unrolling
     */
    _cosineDistance(a, b) {
        if (!a || !b || a.length !== b.length) return 1;

        const len = a.length;
        let dot = 0, normA = 0, normB = 0;

        const unroll = len - (len % 4);
        let i = 0;
        for (; i < unroll; i += 4) {
            const a0 = a[i], a1 = a[i + 1], a2 = a[i + 2], a3 = a[i + 3];
            const b0 = b[i], b1 = b[i + 1], b2 = b[i + 2], b3 = b[i + 3];
            dot += a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
            normA += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
            normB += b0 * b0 + b1 * b1 + b2 * b2 + b3 * b3;
        }
        for (; i < len; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        if (normA === 0 || normB === 0) return 1;
        return 1 - (dot / (Math.sqrt(normA) * Math.sqrt(normB)));
    }

    /**
     * Serialize to JSON for IndexedDB persistence
     */
    toJSON() {
        const nodes = [];
        for (const [id, node] of this.nodes) {
            nodes.push({
                id,
                vector: Array.from(node.vector),
                neighbors: node.neighbors.map(layer =>
                    Array.from(layer.keys())
                )
            });
        }
        return {
            M: this.M,
            Mmax0: this.Mmax0,
            efConstruction: this.efConstruction,
            efSearch: this.efSearch,
            maxLevel: this.maxLevel,
            entryPoint: this.entryPoint,
            nodes
        };
    }

    /**
     * Deserialize from JSON
     */
    static fromJSON(json) {
        const index = new HNSWIndex({
            M: json.M,
            Mmax0: json.Mmax0,
            efConstruction: json.efConstruction,
            efSearch: json.efSearch
        });
        index.maxLevel = json.maxLevel;
        index.entryPoint = json.entryPoint;

        for (const n of json.nodes) {
            index.nodes.set(n.id, {
                vector: n.vector instanceof Float32Array ? n.vector : new Float32Array(n.vector),
                neighbors: n.neighbors.map(layer => {
                    const map = new Map();
                    for (const nbId of layer) map.set(nbId, true);
                    return map;
                })
            });
        }

        return index;
    }
}
