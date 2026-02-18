import { scoreFileByRisk } from '../utils/prompts.js';

/**
 * Groups PR files into ReviewUnits for batched LLM calls.
 * High-risk or large files get solo reviews; small related files are grouped.
 */
export class FileGroupingStrategy {
    constructor(options = {}) {
        this.soloRiskThreshold = options.soloRiskThreshold || 300;
        this.soloChangeThreshold = options.soloChangeThreshold || 200;
        this.maxFilesPerGroup = options.maxFilesPerGroup || 5;
        this.maxLinesPerGroup = options.maxLinesPerGroup || 300;
    }

    /**
     * Group PR files into ReviewUnits
     * @param {Array} files - prData.files array
     * @param {Object} options - { findingsByFile }
     * @returns {Array<ReviewUnit>}
     */
    group(files, options = {}) {
        const { findingsByFile = {} } = options;

        // Score each file
        const scored = files.map(f => {
            let riskScore = scoreFileByRisk(f);

            // Boost files with static analysis findings
            const findings = findingsByFile[f.filename] || [];
            riskScore += findings.filter(fi => fi.severity === 'critical').length * 300;
            riskScore += findings.filter(fi => fi.severity === 'high').length * 150;

            return {
                ...f,
                _riskScore: riskScore,
                _changeSize: (f.additions || 0) + (f.deletions || 0)
            };
        }).sort((a, b) => b._riskScore - a._riskScore);

        const units = [];
        const assigned = new Set();

        // Pass 1: High-risk or large files get solo review units
        for (const file of scored) {
            if (assigned.has(file.filename)) continue;
            if (file._riskScore >= this.soloRiskThreshold || file._changeSize > this.soloChangeThreshold) {
                units.push({
                    type: 'solo',
                    primaryFile: file.filename,
                    files: [file],
                    totalChanges: file._changeSize,
                    riskScore: file._riskScore
                });
                assigned.add(file.filename);
            }
        }

        // Pass 2: Group remaining files by directory + language
        const remaining = scored.filter(f => !assigned.has(f.filename));
        const groups = {};

        for (const file of remaining) {
            const dir = file.filename.split('/').slice(0, -1).join('/') || '/';
            const lang = (file.language || 'unknown').toLowerCase();
            const key = `${dir}::${lang}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(file);
        }

        // Create grouped review units respecting size limits
        for (const groupFiles of Object.values(groups)) {
            let currentBatch = [];
            let currentChanges = 0;

            for (const file of groupFiles) {
                if (currentBatch.length >= this.maxFilesPerGroup ||
                    currentChanges + file._changeSize > this.maxLinesPerGroup) {
                    if (currentBatch.length > 0) {
                        units.push(this._createGroupUnit(currentBatch, currentChanges));
                    }
                    currentBatch = [];
                    currentChanges = 0;
                }
                currentBatch.push(file);
                currentChanges += file._changeSize;
                assigned.add(file.filename);
            }

            if (currentBatch.length > 0) {
                units.push(this._createGroupUnit(currentBatch, currentChanges));
            }
        }

        return units;
    }

    _createGroupUnit(files, totalChanges) {
        const maxRisk = Math.max(...files.map(f => f._riskScore || 0));
        return {
            type: 'group',
            primaryFile: files[0].filename,
            files,
            totalChanges,
            riskScore: maxRisk
        };
    }
}
