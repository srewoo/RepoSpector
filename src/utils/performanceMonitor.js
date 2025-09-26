// @ts-nocheck
// Performance monitoring utility for tracking extension performance

export class PerformanceMonitor {
    constructor() {
        this.metrics = new Map();
        this.thresholds = {
            codeExtraction: 1000,      // 1 second
            contextAnalysis: 2000,      // 2 seconds
            apiCall: 30000,             // 30 seconds
            testGeneration: 45000,      // 45 seconds
            totalOperation: 60000       // 60 seconds
        };
    }

    /**
     * Start timing an operation
     */
    startOperation(operationName, metadata = {}) {
        const operation = {
            name: operationName,
            startTime: performance.now(),
            metadata,
            marks: []
        };
        
        this.metrics.set(operationName, operation);
        
        // Log to console in development
        console.log(`[Performance] Started: ${operationName}`, metadata);
    }

    /**
     * Mark a milestone within an operation
     */
    mark(operationName, milestone) {
        const operation = this.metrics.get(operationName);
        if (!operation) {
            console.warn(`[Performance] No operation found: ${operationName}`);
            return;
        }

        const markTime = performance.now();
        const elapsed = markTime - operation.startTime;
        
        operation.marks.push({
            milestone,
            time: markTime,
            elapsed
        });

        console.log(`[Performance] Mark: ${operationName} - ${milestone} (${elapsed.toFixed(2)}ms)`);
    }

    /**
     * End timing an operation
     */
    endOperation(operationName, result = {}) {
        const operation = this.metrics.get(operationName);
        if (!operation) {
            console.warn(`[Performance] No operation found: ${operationName}`);
            return null;
        }

        const endTime = performance.now();
        const duration = endTime - operation.startTime;
        
        const metric = {
            ...operation,
            endTime,
            duration,
            result,
            isSlowOperation: duration > (this.thresholds[operationName] || 5000)
        };

        // Store completed metric
        this.storeMetric(metric);
        
        // Clean up
        this.metrics.delete(operationName);

        // Log summary
        console.log(`[Performance] Completed: ${operationName} in ${duration.toFixed(2)}ms`, {
            marks: operation.marks,
            result
        });

        // Warn if operation was slow
        if (metric.isSlowOperation) {
            console.warn(`[Performance] Slow operation detected: ${operationName} took ${duration.toFixed(2)}ms`);
        }

        return metric;
    }

    /**
     * Get performance statistics
     */
    async getStatistics(timeRange = 'day') {
        const stored = await chrome.storage.local.get(['performanceMetrics']);
        const metrics = stored.performanceMetrics || [];
        
        const now = Date.now();
        const ranges = {
            hour: 60 * 60 * 1000,
            day: 24 * 60 * 60 * 1000,
            week: 7 * 24 * 60 * 60 * 1000,
            month: 30 * 24 * 60 * 60 * 1000
        };
        
        const cutoff = now - (ranges[timeRange] || ranges.day);
        const relevantMetrics = metrics.filter(m => m.timestamp > cutoff);
        
        // Group by operation name
        const grouped = relevantMetrics.reduce((acc, metric) => {
            if (!acc[metric.name]) {
                acc[metric.name] = [];
            }
            acc[metric.name].push(metric);
            return acc;
        }, {});
        
        // Calculate statistics
        const stats = {};
        for (const [operation, operationMetrics] of Object.entries(grouped)) {
            const durations = operationMetrics.map(m => m.duration);
            stats[operation] = {
                count: operationMetrics.length,
                average: this.average(durations),
                median: this.median(durations),
                min: Math.min(...durations),
                max: Math.max(...durations),
                p95: this.percentile(durations, 95),
                slowOperations: operationMetrics.filter(m => m.isSlowOperation).length
            };
        }
        
        return {
            timeRange,
            totalOperations: relevantMetrics.length,
            operationStats: stats,
            slowestOperations: this.getSlowestOperations(relevantMetrics, 5)
        };
    }

    /**
     * Store a completed metric
     */
    async storeMetric(metric) {
        const stored = await chrome.storage.local.get(['performanceMetrics']);
        let metrics = stored.performanceMetrics || [];
        
        // Add timestamp
        metric.timestamp = Date.now();
        
        // Add to metrics
        metrics.push(metric);
        
        // Keep only last 1000 metrics
        if (metrics.length > 1000) {
            metrics = metrics.slice(-1000);
        }
        
        await chrome.storage.local.set({ performanceMetrics: metrics });
    }

    /**
     * Clear performance metrics
     */
    async clearMetrics() {
        await chrome.storage.local.remove(['performanceMetrics']);
    }

    /**
     * Get slowest operations
     */
    getSlowestOperations(metrics, count = 10) {
        return metrics
            .sort((a, b) => b.duration - a.duration)
            .slice(0, count)
            .map(m => ({
                name: m.name,
                duration: m.duration,
                timestamp: m.timestamp,
                metadata: m.metadata
            }));
    }

    /**
     * Calculate average
     */
    average(numbers) {
        if (numbers.length === 0) return 0;
        return numbers.reduce((a, b) => a + b, 0) / numbers.length;
    }

    /**
     * Calculate median
     */
    median(numbers) {
        if (numbers.length === 0) return 0;
        const sorted = [...numbers].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * Calculate percentile
     */
    percentile(numbers, p) {
        if (numbers.length === 0) return 0;
        const sorted = [...numbers].sort((a, b) => a - b);
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, index)];
    }

    /**
     * Create a performance report
     */
    async generateReport() {
        const stats = await this.getStatistics('day');
        
        let report = '# Performance Report\n\n';
        report += `Generated: ${new Date().toLocaleString()}\n\n`;
        report += `## Summary\n`;
        report += `- Total operations: ${stats.totalOperations}\n`;
        report += `- Time range: Last 24 hours\n\n`;
        
        report += `## Operation Statistics\n\n`;
        for (const [operation, operationStats] of Object.entries(stats.operationStats)) {
            report += `### ${operation}\n`;
            report += `- Count: ${operationStats.count}\n`;
            report += `- Average: ${operationStats.average.toFixed(2)}ms\n`;
            report += `- Median: ${operationStats.median.toFixed(2)}ms\n`;
            report += `- Min: ${operationStats.min.toFixed(2)}ms\n`;
            report += `- Max: ${operationStats.max.toFixed(2)}ms\n`;
            report += `- 95th percentile: ${operationStats.p95.toFixed(2)}ms\n`;
            report += `- Slow operations: ${operationStats.slowOperations}\n\n`;
        }
        
        report += `## Slowest Operations\n\n`;
        for (const slow of stats.slowestOperations) {
            report += `- ${slow.name}: ${slow.duration.toFixed(2)}ms (${new Date(slow.timestamp).toLocaleString()})\n`;
        }
        
        return report;
    }

    /**
     * Monitor memory usage
     */
    async getMemoryUsage() {
        if (!performance.memory) {
            return null; // Not supported in all browsers
        }

        return {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
            percentUsed: (performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100
        };
    }

    /**
     * Create a performance wrapper for async functions
     */
    wrap(operationName, asyncFunction) {
        return async (...args) => {
            this.startOperation(operationName, { args: args.length });
            
            try {
                const result = await asyncFunction(...args);
                this.endOperation(operationName, { success: true });
                return result;
            } catch (error) {
                this.endOperation(operationName, { 
                    success: false, 
                    error: error.message 
                });
                throw error;
            }
        };
    }
}

// Export singleton instance
export const performanceMonitor = new PerformanceMonitor(); 