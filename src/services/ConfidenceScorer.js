/**
 * Confidence Scorer for RepoSpector
 *
 * Implements multi-signal aggregation to reduce false positives by combining
 * results from multiple analysis tools and applying correlation bonuses.
 *
 * Algorithm:
 * Finding Confidence = Σ(tool_weight × tool_confidence) + correlation_bonus
 *
 * Weights: ESLint=0.22, Semgrep=0.28, Dependency=0.18, EOL=0.12, LLM=0.20
 * Bonuses: 2-tool agreement=+0.15, 3-tool=+0.25, LLM corroboration=+0.10
 */

import { TOOL_WEIGHTS, CORRELATION_BONUSES, SEVERITY_WEIGHTS } from '../utils/staticAnalysisPatterns.js';

export class ConfidenceScorer {
    constructor(options = {}) {
        this.toolWeights = { ...TOOL_WEIGHTS, ...options.toolWeights };
        this.correlationBonuses = { ...CORRELATION_BONUSES, ...options.correlationBonuses };

        this.options = {
            minConfidenceThreshold: options.minConfidenceThreshold ?? 0.4,
            enableCorrelation: options.enableCorrelation ?? true,
            enableDeduplication: options.enableDeduplication ?? true,
            fuzzyLineMatching: options.fuzzyLineMatching ?? 5, // Lines to consider "same location"
            ...options
        };
    }

    /**
     * Aggregate findings from multiple tools and calculate combined confidence
     * @param {Object} analysisResults - Results from each tool { eslint, semgrep, dependency, llm }
     * @returns {Object} Aggregated findings with confidence scores
     */
    aggregateFindings(analysisResults) {
        const { eslint, semgrep, dependency, llm } = analysisResults;

        // Collect all findings with tool attribution
        const allFindings = [];

        if (eslint?.findings) {
            for (const finding of eslint.findings) {
                allFindings.push({ ...finding, tool: 'eslint' });
            }
        }

        if (semgrep?.findings) {
            for (const finding of semgrep.findings) {
                allFindings.push({ ...finding, tool: 'semgrep' });
            }
        }

        if (dependency?.findings) {
            for (const finding of dependency.findings) {
                allFindings.push({ ...finding, tool: 'dependency' });
            }
        }

        if (llm?.findings) {
            for (const finding of llm.findings) {
                allFindings.push({ ...finding, tool: 'llm' });
            }
        }

        // Group findings by location/issue type
        const groupedFindings = this.groupFindings(allFindings);

        // Calculate aggregated confidence for each group
        const aggregatedFindings = [];
        for (const group of groupedFindings) {
            const aggregated = this.calculateGroupConfidence(group);
            if (aggregated.confidence >= this.options.minConfidenceThreshold) {
                aggregatedFindings.push(aggregated);
            }
        }

        // Sort by confidence (highest first) then severity
        aggregatedFindings.sort((a, b) => {
            const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
            if (b.confidence !== a.confidence) {
                return b.confidence - a.confidence;
            }
            return severityOrder[a.severity] - severityOrder[b.severity];
        });

        return {
            findings: aggregatedFindings,
            summary: this.generateAggregatedSummary(aggregatedFindings, analysisResults),
            correlation: this.generateCorrelationReport(groupedFindings)
        };
    }

    /**
     * Group findings by location and issue type
     */
    groupFindings(findings) {
        const groups = [];
        const used = new Set();

        for (let i = 0; i < findings.length; i++) {
            if (used.has(i)) continue;

            const finding = findings[i];
            const group = [finding];
            used.add(i);

            // Find related findings
            for (let j = i + 1; j < findings.length; j++) {
                if (used.has(j)) continue;

                const other = findings[j];
                if (this.areRelated(finding, other)) {
                    group.push(other);
                    used.add(j);
                }
            }

            groups.push(group);
        }

        return groups;
    }

    /**
     * Check if two findings are related (same issue)
     */
    areRelated(a, b) {
        // Same file required
        if (a.filePath !== b.filePath) return false;

        // Check line proximity
        const lineDiff = Math.abs((a.line || 0) - (b.line || 0));
        if (lineDiff > this.options.fuzzyLineMatching) return false;

        // Check category/type similarity
        const categoryMatch = this.categoriesMatch(a, b);
        const severityMatch = a.severity === b.severity;

        // For dependency findings, match by package name
        if (a.tool === 'dependency' && b.tool === 'dependency') {
            return a.packageName === b.packageName;
        }

        return categoryMatch || (severityMatch && lineDiff <= 2);
    }

    /**
     * Check if categories/types of two findings match
     */
    categoriesMatch(a, b) {
        // Direct category match
        if (a.category === b.category) return true;

        // Security-related categories
        const securityCategories = new Set([
            'security', 'injection', 'A03:2021-Injection',
            'A01:2021-Broken Access Control', 'A02:2021-Cryptographic Failures',
            'A07:2021-Identification and Authentication Failures'
        ]);

        if (securityCategories.has(a.category) && securityCategories.has(b.category)) {
            return true;
        }

        // OWASP category correlation
        if (a.owasp && b.owaspCategory && a.owasp === b.owaspCategory) {
            return true;
        }

        // Rule ID similarity
        if (a.ruleId && b.ruleId) {
            const aKeywords = a.ruleId.toLowerCase().split(/[-_]/);
            const bKeywords = b.ruleId.toLowerCase().split(/[-_]/);
            const overlap = aKeywords.filter(k => bKeywords.includes(k)).length;
            if (overlap >= 2) return true;
        }

        return false;
    }

    /**
     * Calculate aggregated confidence for a group of related findings
     */
    calculateGroupConfidence(group) {
        if (group.length === 0) {
            return null;
        }

        // Track which tools detected this issue
        const toolsDetected = new Set(group.map(f => f.tool));
        const numTools = toolsDetected.size;

        // Base confidence: weighted average of tool confidences
        let baseConfidence = 0;
        let totalWeight = 0;

        for (const finding of group) {
            const weight = this.toolWeights[finding.tool] || 0.25;
            baseConfidence += weight * (finding.confidence || 0.5);
            totalWeight += weight;
        }

        baseConfidence = totalWeight > 0 ? baseConfidence / totalWeight : 0.5;

        // Apply correlation bonuses
        let correlationBonus = 0;
        if (this.options.enableCorrelation) {
            if (numTools >= 3) {
                correlationBonus = this.correlationBonuses.threeTools;
            } else if (numTools === 2) {
                correlationBonus = this.correlationBonuses.twoTools;
            }

            // LLM corroboration bonus
            if (toolsDetected.has('llm') && numTools > 1) {
                correlationBonus += this.correlationBonuses.llmCorroboration;
            }
        }

        const finalConfidence = Math.min(1.0, baseConfidence + correlationBonus);

        // Merge finding details
        const primary = this.selectPrimaryFinding(group);

        return {
            ...primary,
            confidence: Math.round(finalConfidence * 100) / 100,
            baseConfidence: Math.round(baseConfidence * 100) / 100,
            correlationBonus: Math.round(correlationBonus * 100) / 100,
            toolsDetected: [...toolsDetected],
            numToolsAgreeing: numTools,
            relatedFindings: group.length > 1 ? group.slice(1).map(f => ({
                tool: f.tool,
                ruleId: f.ruleId,
                message: f.message,
                confidence: f.confidence
            })) : [],
            isCorroborated: numTools > 1
        };
    }

    /**
     * Select the primary finding from a group (most informative)
     */
    selectPrimaryFinding(group) {
        // Prefer Semgrep for security (more detailed)
        // Then ESLint (good bug detection)
        // Then dependency (specific CVEs)
        // Finally LLM (most context but less precise)
        const priority = { semgrep: 0, eslint: 1, dependency: 2, eol: 3, llm: 4 };

        const sorted = [...group].sort((a, b) => {
            const priorityDiff = priority[a.tool] - priority[b.tool];
            if (priorityDiff !== 0) return priorityDiff;
            return (b.confidence || 0) - (a.confidence || 0);
        });

        return sorted[0];
    }

    /**
     * Generate summary of aggregated findings
     */
    generateAggregatedSummary(findings, analysisResults) {
        const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        const byCategory = {};
        const byTool = { eslint: 0, semgrep: 0, dependency: 0, eol: 0, llm: 0 };
        let corroboratedCount = 0;

        for (const finding of findings) {
            bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
            byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;

            for (const tool of finding.toolsDetected) {
                byTool[tool]++;
            }

            if (finding.isCorroborated) {
                corroboratedCount++;
            }
        }

        const avgConfidence = findings.length > 0
            ? findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length
            : 1.0;

        return {
            total: findings.length,
            bySeverity,
            byCategory,
            byTool,
            corroborated: corroboratedCount,
            uncorroborated: findings.length - corroboratedCount,
            averageConfidence: Math.round(avgConfidence * 100) / 100,
            highConfidenceCount: findings.filter(f => f.confidence >= 0.7).length,
            toolCounts: {
                eslint: analysisResults.eslint?.findings?.length || 0,
                semgrep: analysisResults.semgrep?.findings?.length || 0,
                dependency: analysisResults.dependency?.findings?.length || 0,
                llm: analysisResults.llm?.findings?.length || 0
            },
            filteredOut: this.countFilteredFindings(analysisResults, findings.length)
        };
    }

    /**
     * Count how many findings were filtered out (below threshold)
     */
    countFilteredFindings(analysisResults, aggregatedCount) {
        let total = 0;
        if (analysisResults.eslint?.findings) total += analysisResults.eslint.findings.length;
        if (analysisResults.semgrep?.findings) total += analysisResults.semgrep.findings.length;
        if (analysisResults.dependency?.findings) total += analysisResults.dependency.findings.length;
        if (analysisResults.llm?.findings) total += analysisResults.llm.findings.length;

        // Rough estimate - actual filtering happens after grouping
        return Math.max(0, total - aggregatedCount);
    }

    /**
     * Generate correlation report
     */
    generateCorrelationReport(groups) {
        const report = {
            totalGroups: groups.length,
            singleToolGroups: 0,
            twoToolGroups: 0,
            threeOrMoreToolGroups: 0,
            toolAgreementMatrix: {}
        };

        // Initialize agreement matrix
        const tools = ['eslint', 'semgrep', 'dependency', 'eol', 'llm'];
        for (const t1 of tools) {
            report.toolAgreementMatrix[t1] = {};
            for (const t2 of tools) {
                report.toolAgreementMatrix[t1][t2] = 0;
            }
        }

        for (const group of groups) {
            const toolsInGroup = new Set(group.map(f => f.tool));
            const numTools = toolsInGroup.size;

            if (numTools === 1) {
                report.singleToolGroups++;
            } else if (numTools === 2) {
                report.twoToolGroups++;
            } else {
                report.threeOrMoreToolGroups++;
            }

            // Update agreement matrix
            const toolList = [...toolsInGroup];
            for (let i = 0; i < toolList.length; i++) {
                for (let j = i + 1; j < toolList.length; j++) {
                    report.toolAgreementMatrix[toolList[i]][toolList[j]]++;
                    report.toolAgreementMatrix[toolList[j]][toolList[i]]++;
                }
            }
        }

        return report;
    }

    /**
     * Apply LLM corroboration to existing findings
     * Call this when LLM analysis becomes available after initial static analysis
     */
    applyLLMCorroboration(existingFindings, llmFindings) {
        const updatedFindings = [];

        for (const finding of existingFindings) {
            // Check if LLM found something related
            const llmMatch = this.findLLMCorroboration(finding, llmFindings);

            if (llmMatch) {
                // Boost confidence
                const newConfidence = Math.min(1.0,
                    finding.confidence + this.correlationBonuses.llmCorroboration
                );

                updatedFindings.push({
                    ...finding,
                    confidence: Math.round(newConfidence * 100) / 100,
                    llmCorroborated: true,
                    llmContext: llmMatch.message || llmMatch.description,
                    toolsDetected: [...new Set([...finding.toolsDetected, 'llm'])]
                });
            } else {
                updatedFindings.push(finding);
            }
        }

        return updatedFindings;
    }

    /**
     * Find LLM finding that corroborates a static analysis finding
     */
    findLLMCorroboration(finding, llmFindings) {
        if (!llmFindings || llmFindings.length === 0) return null;

        for (const llmFinding of llmFindings) {
            // File match
            if (llmFinding.filePath && llmFinding.filePath !== finding.filePath) continue;

            // Line proximity
            if (llmFinding.line && finding.line) {
                const lineDiff = Math.abs(llmFinding.line - finding.line);
                if (lineDiff > this.options.fuzzyLineMatching) continue;
            }

            // Category/severity similarity
            if (this.categoriesMatch(finding, llmFinding)) {
                return llmFinding;
            }

            // Check for keyword overlap in messages
            const findingKeywords = this.extractKeywords(finding.message || '');
            const llmKeywords = this.extractKeywords(llmFinding.message || llmFinding.description || '');

            const overlap = findingKeywords.filter(k => llmKeywords.includes(k));
            if (overlap.length >= 2) {
                return llmFinding;
            }
        }

        return null;
    }

    /**
     * Extract keywords from a message
     */
    extractKeywords(text) {
        const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'be', 'to', 'of', 'and', 'in', 'for', 'on', 'with']);
        return text
            .toLowerCase()
            .split(/\W+/)
            .filter(w => w.length > 3 && !stopWords.has(w));
    }

    /**
     * Calculate risk score for a codebase based on findings
     */
    calculateRiskScore(findings) {
        if (findings.length === 0) {
            return { score: 100, level: 'low', description: 'No issues detected' };
        }

        // Weight findings by severity and confidence
        let riskPoints = 0;
        const maxPoints = 100;

        for (const finding of findings) {
            const severityWeight = SEVERITY_WEIGHTS[finding.severity] || 0.5;
            const confidenceWeight = finding.confidence || 0.5;
            const corroborationBonus = finding.isCorroborated ? 1.2 : 1.0;

            // Each finding contributes based on severity × confidence
            riskPoints += severityWeight * confidenceWeight * corroborationBonus * 10;
        }

        // Cap risk points at maxPoints
        riskPoints = Math.min(riskPoints, maxPoints);

        // Convert to score (lower is worse)
        const score = Math.max(0, Math.round(maxPoints - riskPoints));

        // Determine risk level
        let level, description;
        if (score >= 80) {
            level = 'low';
            description = 'Code quality is good with minor issues';
        } else if (score >= 60) {
            level = 'medium';
            description = 'Some issues require attention';
        } else if (score >= 40) {
            level = 'high';
            description = 'Significant issues detected - review recommended';
        } else {
            level = 'critical';
            description = 'Critical security or quality issues - immediate attention required';
        }

        return { score, level, description, riskPoints: Math.round(riskPoints) };
    }
}

export default ConfidenceScorer;
