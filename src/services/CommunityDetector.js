/**
 * CommunityDetector for RepoSpector
 *
 * Pure-JS implementation of the Louvain community detection algorithm.
 * Groups symbols into functional clusters based on CALLS, EXTENDS, and
 * IMPLEMENTS edges — so the LLM can say "this belongs to the Auth cluster"
 * instead of just listing file paths.
 *
 * No external dependencies. Adapted from the Louvain method:
 *   Blondel, V.D. et al. (2008) "Fast unfolding of communities in large networks"
 *
 * GitNexus uses graphology + Leiden; we use a lighter Louvain to avoid
 * adding ~30KB of dependencies for the Chrome extension.
 */

import { KnowledgeGraphService } from './KnowledgeGraphService.js';

const CLUSTERING_REL_TYPES = new Set(['CALLS', 'EXTENDS', 'IMPLEMENTS']);
const SYMBOL_TYPES = new Set(['Function', 'Class', 'Method', 'Interface']);

const GENERIC_FOLDERS = new Set([
    'src', 'lib', 'core', 'utils', 'common', 'shared', 'helpers',
    'internal', 'pkg', 'cmd', 'app', 'main', 'dist', 'build', 'out'
]);

export class CommunityDetector {
    /**
     * @param {import('./KnowledgeGraphService.js').KnowledgeGraphService} graph
     */
    constructor(graph) {
        this.graph = graph;
    }

    /**
     * Detect communities and add them to the knowledge graph
     *
     * @returns {Object} { communities, memberships, stats }
     */
    detect() {
        // Step 1: Build adjacency from the knowledge graph (undirected, symbols only)
        const { adj, nodeSet } = this._buildUndirectedGraph();

        if (nodeSet.size === 0) {
            return { communities: [], memberships: new Map(), stats: { totalCommunities: 0, modularity: 0 } };
        }

        // Step 2: Run Louvain
        const { communities: communityMap, modularity } = this._louvain(adj, nodeSet);

        // Step 3: Group by community, skip singletons
        const communityMembers = new Map();
        for (const [nodeId, commId] of communityMap) {
            if (!communityMembers.has(commId)) communityMembers.set(commId, []);
            communityMembers.get(commId).push(nodeId);
        }

        // Step 4: Build community nodes
        const communities = [];
        const memberships = new Map();
        let commIndex = 0;

        for (const [_commId, memberIds] of communityMembers) {
            if (memberIds.length < 2) continue;

            const commNodeId = `comm_${commIndex}`;
            const label = this._generateLabel(memberIds, adj);
            const cohesion = this._calculateCohesion(memberIds, adj);

            communities.push({
                id: commNodeId,
                label,
                heuristicLabel: label,
                cohesion,
                symbolCount: memberIds.length
            });

            // Add community node to graph
            this.graph.addNode({
                id: commNodeId,
                label: 'Community',
                properties: {
                    name: label,
                    filePath: '',
                    heuristicLabel: label,
                    cohesion,
                    symbolCount: memberIds.length
                }
            });

            // Add MEMBER_OF edges
            for (const nodeId of memberIds) {
                memberships.set(nodeId, commNodeId);

                this.graph.addRelationship({
                    id: KnowledgeGraphService.generateId('MEMBER_OF', `${nodeId}->${commNodeId}`),
                    sourceId: nodeId,
                    targetId: commNodeId,
                    type: 'MEMBER_OF',
                    confidence: 1.0,
                    reason: 'louvain-algorithm'
                });
            }

            commIndex++;
        }

        communities.sort((a, b) => b.symbolCount - a.symbolCount);

        return {
            communities,
            memberships,
            stats: {
                totalCommunities: communities.length,
                modularity: Math.round(modularity * 1000) / 1000,
                nodesProcessed: nodeSet.size
            }
        };
    }

    // --- Louvain algorithm ---

    _louvain(adj, nodeSet) {
        const nodes = Array.from(nodeSet);
        const community = new Map();
        const totalWeight = this._totalEdgeWeight(adj, nodeSet);

        if (totalWeight === 0) {
            nodes.forEach((n, i) => community.set(n, i));
            return { communities: community, modularity: 0 };
        }

        // Initialize: each node in its own community
        nodes.forEach((n, i) => community.set(n, i));

        let improved = true;
        let iterations = 0;
        const MAX_ITERATIONS = 20;

        while (improved && iterations < MAX_ITERATIONS) {
            improved = false;
            iterations++;

            // Shuffle nodes for randomization
            const shuffled = [...nodes];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }

            for (const node of shuffled) {
                const currentComm = community.get(node);
                const neighbors = adj.get(node) || new Map();

                // Calculate modularity gain for moving to each neighboring community
                const neighborComms = new Map();
                for (const [neighbor, weight] of neighbors) {
                    const nComm = community.get(neighbor);
                    neighborComms.set(nComm, (neighborComms.get(nComm) || 0) + weight);
                }

                let bestComm = currentComm;
                let bestGain = 0;

                const ki = this._nodeDegree(node, adj);
                const m2 = 2 * totalWeight;

                for (const [candidateComm, edgesToComm] of neighborComms) {
                    if (candidateComm === currentComm) continue;

                    // Simplified modularity gain calculation
                    const sumIn = this._communityInternalWeight(candidateComm, community, adj);
                    const sumTot = this._communityTotalDegree(candidateComm, community, adj);
                    const kiIn = edgesToComm;

                    const gain = (kiIn - (sumTot * ki) / m2) / m2;

                    if (gain > bestGain) {
                        bestGain = gain;
                        bestComm = candidateComm;
                    }
                }

                if (bestComm !== currentComm) {
                    community.set(node, bestComm);
                    improved = true;
                }
            }
        }

        // Renumber communities to be contiguous
        const commMap = new Map();
        let nextId = 0;
        const renumbered = new Map();

        for (const [node, comm] of community) {
            if (!commMap.has(comm)) commMap.set(comm, nextId++);
            renumbered.set(node, commMap.get(comm));
        }

        const modularity = this._calculateModularity(renumbered, adj, totalWeight);

        return { communities: renumbered, modularity };
    }

    // --- Graph building ---

    _buildUndirectedGraph() {
        const adj = new Map();
        const nodeSet = new Set();

        // Add symbol nodes
        for (const node of this.graph.nodes.values()) {
            if (SYMBOL_TYPES.has(node.label)) {
                nodeSet.add(node.id);
                if (!adj.has(node.id)) adj.set(node.id, new Map());
            }
        }

        // Add edges (undirected, skip self-loops)
        for (const rel of this.graph.relationships.values()) {
            if (!CLUSTERING_REL_TYPES.has(rel.type)) continue;
            if (!nodeSet.has(rel.sourceId) || !nodeSet.has(rel.targetId)) continue;
            if (rel.sourceId === rel.targetId) continue;

            const srcAdj = adj.get(rel.sourceId);
            const tgtAdj = adj.get(rel.targetId);

            srcAdj.set(rel.targetId, (srcAdj.get(rel.targetId) || 0) + 1);
            tgtAdj.set(rel.sourceId, (tgtAdj.get(rel.sourceId) || 0) + 1);
        }

        return { adj, nodeSet };
    }

    // --- Modularity helpers ---

    _totalEdgeWeight(adj, nodeSet) {
        let total = 0;
        for (const nodeId of nodeSet) {
            const neighbors = adj.get(nodeId) || new Map();
            for (const weight of neighbors.values()) {
                total += weight;
            }
        }
        return total / 2; // Each edge counted twice
    }

    _nodeDegree(nodeId, adj) {
        const neighbors = adj.get(nodeId) || new Map();
        let degree = 0;
        for (const weight of neighbors.values()) {
            degree += weight;
        }
        return degree;
    }

    _communityInternalWeight(commId, community, adj) {
        let internal = 0;
        for (const [node, comm] of community) {
            if (comm !== commId) continue;
            const neighbors = adj.get(node) || new Map();
            for (const [neighbor, weight] of neighbors) {
                if (community.get(neighbor) === commId) {
                    internal += weight;
                }
            }
        }
        return internal / 2;
    }

    _communityTotalDegree(commId, community, adj) {
        let total = 0;
        for (const [node, comm] of community) {
            if (comm !== commId) continue;
            total += this._nodeDegree(node, adj);
        }
        return total;
    }

    _calculateModularity(community, adj, totalWeight) {
        if (totalWeight === 0) return 0;
        const m2 = 2 * totalWeight;
        let Q = 0;

        const communities = new Set(community.values());

        for (const comm of communities) {
            const members = [];
            for (const [node, c] of community) {
                if (c === comm) members.push(node);
            }

            let Lc = 0; // Internal edges
            let kc = 0; // Total degree

            for (const node of members) {
                const neighbors = adj.get(node) || new Map();
                for (const [neighbor, weight] of neighbors) {
                    if (community.get(neighbor) === comm) Lc += weight;
                    kc += weight;
                }
            }

            Lc /= 2;
            Q += (Lc / totalWeight) - Math.pow(kc / m2, 2);
        }

        return Q;
    }

    // --- Labeling ---

    _generateLabel(memberIds, _adj) {
        const folderCounts = new Map();

        for (const nodeId of memberIds) {
            const node = this.graph.getNode(nodeId);
            if (!node?.properties?.filePath) continue;

            const parts = node.properties.filePath.split('/').filter(Boolean);
            if (parts.length >= 2) {
                const folder = parts[parts.length - 2];
                if (!GENERIC_FOLDERS.has(folder.toLowerCase())) {
                    folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
                }
            }
        }

        // Find most common folder
        let bestFolder = '';
        let maxCount = 0;
        for (const [folder, count] of folderCounts) {
            if (count > maxCount) {
                maxCount = count;
                bestFolder = folder;
            }
        }

        if (bestFolder) {
            return bestFolder.charAt(0).toUpperCase() + bestFolder.slice(1);
        }

        // Fallback: common name prefix
        const names = memberIds
            .map(id => this.graph.getNode(id)?.properties?.name)
            .filter(Boolean);

        if (names.length > 2) {
            const prefix = this._commonPrefix(names);
            if (prefix.length > 2) {
                return prefix.charAt(0).toUpperCase() + prefix.slice(1);
            }
        }

        return `Cluster_${memberIds.length}`;
    }

    _commonPrefix(strings) {
        if (strings.length === 0) return '';
        const sorted = strings.slice().sort();
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        let i = 0;
        while (i < first.length && first[i] === last[i]) i++;
        return first.substring(0, i);
    }

    _calculateCohesion(memberIds, adj) {
        if (memberIds.length <= 1) return 1.0;

        const memberSet = new Set(memberIds);
        let internalEdges = 0;

        for (const nodeId of memberIds) {
            const neighbors = adj.get(nodeId) || new Map();
            for (const [neighbor] of neighbors) {
                if (memberSet.has(neighbor)) internalEdges++;
            }
        }

        internalEdges /= 2;
        const maxEdges = (memberIds.length * (memberIds.length - 1)) / 2;

        return maxEdges === 0 ? 1.0 : Math.min(1.0, internalEdges / maxEdges);
    }

    /**
     * Format community info for LLM context injection
     */
    formatForPrompt(targetName) {
        const targetNodes = this.graph.findNodeByName(targetName);
        if (targetNodes.length === 0) return null;

        const targetId = targetNodes[0].id;

        // Find community membership
        const memberOfRels = this.graph.getRelationshipsFrom(targetId)
            .filter(r => r.type === 'MEMBER_OF');

        if (memberOfRels.length === 0) return null;

        const communityId = memberOfRels[0].targetId;
        const community = this.graph.getNode(communityId);
        if (!community) return null;

        let prompt = `## Community Membership:\n`;
        prompt += `\`${targetName}\` belongs to the **${community.properties.name}** cluster `;
        prompt += `(${community.properties.symbolCount} symbols, cohesion: ${(community.properties.cohesion * 100).toFixed(0)}%)\n`;

        // List other members
        const otherMembers = [];
        for (const rel of this.graph.relationships.values()) {
            if (rel.type === 'MEMBER_OF' && rel.targetId === communityId && rel.sourceId !== targetId) {
                const member = this.graph.getNode(rel.sourceId);
                if (member) otherMembers.push(member);
            }
        }

        if (otherMembers.length > 0) {
            prompt += `\nOther symbols in this cluster:\n`;
            for (const member of otherMembers.slice(0, 10)) {
                prompt += `- \`${member.properties.name}\` [${member.label}] (${member.properties.filePath})\n`;
            }
            if (otherMembers.length > 10) {
                prompt += `- ... and ${otherMembers.length - 10} more\n`;
            }
        }

        return prompt;
    }

    /**
     * Get a summary of all communities for overview context
     */
    formatOverviewForPrompt() {
        const communityNodes = this.graph.getNodesByLabel('Community');
        if (communityNodes.length === 0) return null;

        let prompt = `## Codebase Architecture (${communityNodes.length} functional clusters):\n\n`;

        const sorted = [...communityNodes].sort(
            (a, b) => (b.properties?.symbolCount || 0) - (a.properties?.symbolCount || 0)
        );

        for (const comm of sorted.slice(0, 15)) {
            const cohesion = ((comm.properties?.cohesion || 0) * 100).toFixed(0);
            prompt += `- **${comm.properties.name}** — ${comm.properties.symbolCount} symbols, ${cohesion}% cohesion\n`;
        }

        if (sorted.length > 15) {
            prompt += `\n... and ${sorted.length - 15} more clusters\n`;
        }

        return prompt;
    }
}

export default CommunityDetector;
