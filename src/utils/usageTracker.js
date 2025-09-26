// API Usage Tracking Utility
export class UsageTracker {
    constructor() {
        this.storageKey = 'api_usage_stats';
        this.currentPeriodKey = 'current_billing_period';
        this.initializeTracking();
    }

    async initializeTracking() {
        // Check if we need to reset for new billing period
        await this.checkBillingPeriod();
    }

    /**
     * Track API usage for a request
     */
    async trackUsage(tokensUsed, model = 'gpt-4-turbo-preview', cost = null) {
        try {
            const usage = await this.getUsage();
            const today = new Date().toISOString().split('T')[0];
            
            // Initialize today's data if not exists
            if (!usage.daily[today]) {
                usage.daily[today] = {
                    requests: 0,
                    tokens: 0,
                    cost: 0,
                    models: {}
                };
            }
            
            // Update daily stats
            usage.daily[today].requests += 1;
            usage.daily[today].tokens += tokensUsed;
            
            // Track by model
            if (!usage.daily[today].models[model]) {
                usage.daily[today].models[model] = {
                    requests: 0,
                    tokens: 0,
                    cost: 0
                };
            }
            
            usage.daily[today].models[model].requests += 1;
            usage.daily[today].models[model].tokens += tokensUsed;
            
            // Calculate cost if not provided
            if (cost === null) {
                cost = this.calculateCost(tokensUsed, model);
            }
            
            usage.daily[today].cost += cost;
            usage.daily[today].models[model].cost += cost;
            
            // Update totals
            usage.total.requests += 1;
            usage.total.tokens += tokensUsed;
            usage.total.cost += cost;
            
            // Update model totals
            if (!usage.total.models[model]) {
                usage.total.models[model] = {
                    requests: 0,
                    tokens: 0,
                    cost: 0
                };
            }
            
            usage.total.models[model].requests += 1;
            usage.total.models[model].tokens += tokensUsed;
            usage.total.models[model].cost += cost;
            
            // Save updated usage
            await this.saveUsage(usage);
            
            // Check for usage alerts
            await this.checkUsageAlerts(usage);
            
            return usage;
            
        } catch (error) {
            console.error('Failed to track usage:', error);
        }
    }

    /**
     * Calculate cost based on tokens and model
     */
    calculateCost(tokens, model) {
        // Pricing per 1K tokens (as of 2024)
        const pricing = {
            'gpt-4-turbo-preview': { input: 0.01, output: 0.03 },
            'gpt-4': { input: 0.03, output: 0.06 },
            'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
            'gpt-4o': { input: 0.005, output: 0.015 },
            'gpt-4o-mini': { input: 0.00015, output: 0.0006 }
        };
        
        const modelPricing = pricing[model] || pricing['gpt-4-turbo-preview'];
        
        // Estimate 70% input, 30% output for test generation
        const inputTokens = tokens * 0.7;
        const outputTokens = tokens * 0.3;
        
        const inputCost = (inputTokens / 1000) * modelPricing.input;
        const outputCost = (outputTokens / 1000) * modelPricing.output;
        
        return inputCost + outputCost;
    }

    /**
     * Get current usage statistics
     */
    async getUsage() {
        const result = await chrome.storage.local.get([this.storageKey]);
        
        return result[this.storageKey] || {
            total: {
                requests: 0,
                tokens: 0,
                cost: 0,
                models: {}
            },
            daily: {},
            alerts: {
                dailyLimit: 50000, // 50k tokens per day
                monthlyLimit: 1000000, // 1M tokens per month
                costLimit: 100 // $100 per month
            }
        };
    }

    /**
     * Save usage statistics
     */
    async saveUsage(usage) {
        await chrome.storage.local.set({ [this.storageKey]: usage });
    }

    /**
     * Get usage summary for display
     */
    async getUsageSummary() {
        const usage = await this.getUsage();
        const today = new Date().toISOString().split('T')[0];
        const todayUsage = usage.daily[today] || { requests: 0, tokens: 0, cost: 0 };
        
        // Calculate month-to-date
        const currentMonth = new Date().toISOString().slice(0, 7);
        let monthlyTokens = 0;
        let monthlyCost = 0;
        let monthlyRequests = 0;
        
        Object.entries(usage.daily).forEach(([date, data]) => {
            if (date.startsWith(currentMonth)) {
                monthlyTokens += data.tokens;
                monthlyCost += data.cost;
                monthlyRequests += data.requests;
            }
        });
        
        // Calculate percentages
        const dailyPercentage = (todayUsage.tokens / usage.alerts.dailyLimit) * 100;
        const monthlyPercentage = (monthlyTokens / usage.alerts.monthlyLimit) * 100;
        const costPercentage = (monthlyCost / usage.alerts.costLimit) * 100;
        
        return {
            today: {
                requests: todayUsage.requests,
                tokens: todayUsage.tokens,
                cost: todayUsage.cost.toFixed(2),
                percentage: Math.min(dailyPercentage, 100).toFixed(1)
            },
            month: {
                requests: monthlyRequests,
                tokens: monthlyTokens,
                cost: monthlyCost.toFixed(2),
                percentage: Math.min(monthlyPercentage, 100).toFixed(1)
            },
            total: {
                requests: usage.total.requests,
                tokens: usage.total.tokens,
                cost: usage.total.cost.toFixed(2)
            },
            limits: usage.alerts,
            costPercentage: Math.min(costPercentage, 100).toFixed(1),
            modelBreakdown: this.getModelBreakdown(usage)
        };
    }

    /**
     * Get model usage breakdown
     */
    getModelBreakdown(usage) {
        const breakdown = [];
        
        Object.entries(usage.total.models || {}).forEach(([model, data]) => {
            breakdown.push({
                model,
                requests: data.requests,
                tokens: data.tokens,
                cost: data.cost.toFixed(2),
                percentage: ((data.tokens / usage.total.tokens) * 100).toFixed(1)
            });
        });
        
        return breakdown.sort((a, b) => b.tokens - a.tokens);
    }

    /**
     * Check and trigger usage alerts
     */
    async checkUsageAlerts(usage) {
        const today = new Date().toISOString().split('T')[0];
        const todayUsage = usage.daily[today] || { tokens: 0, cost: 0 };
        
        // Check daily limit
        if (todayUsage.tokens > usage.alerts.dailyLimit * 0.8) {
            await this.triggerAlert('daily_limit', {
                used: todayUsage.tokens,
                limit: usage.alerts.dailyLimit,
                percentage: ((todayUsage.tokens / usage.alerts.dailyLimit) * 100).toFixed(1)
            });
        }
        
        // Check monthly cost limit
        const currentMonth = new Date().toISOString().slice(0, 7);
        let monthlyCost = 0;
        
        Object.entries(usage.daily).forEach(([date, data]) => {
            if (date.startsWith(currentMonth)) {
                monthlyCost += data.cost;
            }
        });
        
        if (monthlyCost > usage.alerts.costLimit * 0.8) {
            await this.triggerAlert('cost_limit', {
                used: monthlyCost.toFixed(2),
                limit: usage.alerts.costLimit,
                percentage: ((monthlyCost / usage.alerts.costLimit) * 100).toFixed(1)
            });
        }
    }

    /**
     * Trigger usage alert
     */
    async triggerAlert(type, data) {
        const lastAlerts = await chrome.storage.local.get(['usage_alerts']);
        const alerts = lastAlerts.usage_alerts || {};
        const today = new Date().toISOString().split('T')[0];
        
        // Only alert once per day per type
        if (alerts[type] === today) {
            return;
        }
        
        // Create notification
        const messages = {
            daily_limit: `Daily token limit ${data.percentage}% used (${data.used.toLocaleString()} / ${data.limit.toLocaleString()})`,
            cost_limit: `Monthly cost limit ${data.percentage}% used ($${data.used} / $${data.limit})`
        };
        
        // Show notification in extension
        if (chrome.notifications) {
            chrome.notifications.create({
                type: 'basic',
                iconUrl: '/assets/icons/icon-128.png',
                title: 'RepoSpector Usage Alert',
                message: messages[type],
                priority: 2
            });
        }
        
        // Update last alert date
        alerts[type] = today;
        await chrome.storage.local.set({ usage_alerts: alerts });
    }

    /**
     * Update usage limits
     */
    async updateLimits(limits) {
        const usage = await this.getUsage();
        
        usage.alerts = {
            ...usage.alerts,
            ...limits
        };
        
        await this.saveUsage(usage);
    }

    /**
     * Reset daily usage (for testing)
     */
    async resetDaily() {
        const usage = await this.getUsage();
        const today = new Date().toISOString().split('T')[0];
        
        if (usage.daily[today]) {
            delete usage.daily[today];
            await this.saveUsage(usage);
        }
    }

    /**
     * Check and reset for new billing period
     */
    async checkBillingPeriod() {
        const result = await chrome.storage.local.get([this.currentPeriodKey]);
        const currentMonth = new Date().toISOString().slice(0, 7);
        
        if (result[this.currentPeriodKey] !== currentMonth) {
            // New billing period - archive old data
            const usage = await this.getUsage();
            
            // Archive previous month's data
            const archives = await chrome.storage.local.get(['usage_archives']) || {};
            const previousMonth = result[this.currentPeriodKey];
            
            if (previousMonth) {
                archives.usage_archives = archives.usage_archives || {};
                archives.usage_archives[previousMonth] = {
                    total: { ...usage.total },
                    daily: { ...usage.daily }
                };
                
                await chrome.storage.local.set(archives);
            }
            
            // Reset current usage but keep limits
            const newUsage = {
                total: {
                    requests: 0,
                    tokens: 0,
                    cost: 0,
                    models: {}
                },
                daily: {},
                alerts: usage.alerts
            };
            
            await this.saveUsage(newUsage);
            await chrome.storage.local.set({ [this.currentPeriodKey]: currentMonth });
        }
    }

    /**
     * Export usage data
     */
    async exportUsageData() {
        const usage = await this.getUsage();
        const archives = await chrome.storage.local.get(['usage_archives']);
        
        return {
            current: usage,
            archives: archives.usage_archives || {},
            exported: new Date().toISOString()
        };
    }
}

// Export singleton instance
export const usageTracker = new UsageTracker(); 