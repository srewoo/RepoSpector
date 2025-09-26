// Advanced caching system for RepoSpector
// Provides intelligent caching, invalidation, and performance optimization

import { ErrorHandler } from './errorHandler.js';
import { Sanitizer } from './sanitizer.js';

export class CacheManager {
    constructor(options = {}) {
        this.errorHandler = new ErrorHandler();
        this.sanitizer = new Sanitizer();
        
        // Cache configuration
        this.maxSize = options.maxSize || 100;
        this.defaultTTL = options.defaultTTL || 3600000; // 1 hour
        this.cleanupInterval = options.cleanupInterval || 300000; // 5 minutes
        
        // Cache storage
        this.cache = new Map();
        this.accessTimes = new Map();
        this.hitCounts = new Map();
        
        // Performance metrics
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            cleanups: 0
        };
        
        // Start cleanup timer
        this.startCleanupTimer();
    }

    /**
     * Initialize the cache manager
     * Loads persisted cache entries from Chrome storage
     */
    async initialize() {
        try {
            console.log('Initializing CacheManager...');
            
            // Load any persisted cache items from storage
            await this.loadPersistedCache();
            
            // Run initial cleanup
            this.cleanup();
            
            console.log('CacheManager initialized successfully');
            return true;
        } catch (error) {
            this.errorHandler.logError('Cache initialization', error);
            return false;
        }
    }

    /**
     * Load persisted cache items from Chrome storage
     */
    async loadPersistedCache() {
        try {
            const allStorage = await chrome.storage.local.get(null);
            const cacheKeys = Object.keys(allStorage).filter(key => key.startsWith('cache_'));
            
            let loadedCount = 0;
            for (const storageKey of cacheKeys) {
                const cacheKey = storageKey.replace('cache_', '');
                const item = allStorage[storageKey];
                
                if (item && item.version === 1 && Date.now() < item.expiresAt) {
                    this.cache.set(cacheKey, item);
                    this.accessTimes.set(cacheKey, item.createdAt || Date.now());
                    this.hitCounts.set(cacheKey, 0);
                    loadedCount++;
                } else if (item && Date.now() >= item.expiresAt) {
                    // Remove expired items
                    await chrome.storage.local.remove(storageKey);
                }
            }
            
            console.log(`Loaded ${loadedCount} cache items from storage`);
        } catch (error) {
            console.warn('Failed to load persisted cache:', error);
        }
    }

    /**
     * Generate cache key from input parameters
     */
    generateKey(code, options = {}) {
        try {
            // Normalize the code to handle whitespace differences
            const normalizedCode = this.normalizeCode(code);
            
            // Create a hash of the code and options
            const keyData = {
                code: normalizedCode,
                testType: options.testType || 'unit',
                contextLevel: options.contextLevel || 'smart',
                framework: options.framework || 'auto',
                language: options.language || 'javascript'
            };
            
            return this.hashObject(keyData);
        } catch (error) {
            this.errorHandler.logError('Cache key generation', error);
            return null;
        }
    }

    /**
     * Store test results in cache
     */
    async set(key, value, ttl = null) {
        try {
            if (!key || !value) return false;

            const expiresAt = Date.now() + (ttl || this.defaultTTL);
            
            // Check if we need to evict items
            if (this.cache.size >= this.maxSize) {
                this.evictLeastRecentlyUsed();
            }

            // Store the cached item
            const cacheItem = {
                value,
                expiresAt,
                createdAt: Date.now(),
                size: this.estimateSize(value)
            };

            this.cache.set(key, cacheItem);
            this.accessTimes.set(key, Date.now());
            this.hitCounts.set(key, 0);

            // Save to chrome storage for persistence
            await this.persistToStorage(key, cacheItem);

            return true;
        } catch (error) {
            this.errorHandler.logError('Cache set operation', error);
            return false;
        }
    }

    /**
     * Retrieve test results from cache
     */
    async get(key) {
        try {
            if (!key) return null;

            // Check memory cache first
            let cacheItem = this.cache.get(key);
            
            // If not in memory, try to load from storage
            if (!cacheItem) {
                cacheItem = await this.loadFromStorage(key);
                if (cacheItem) {
                    this.cache.set(key, cacheItem);
                }
            }

            if (!cacheItem) {
                this.stats.misses++;
                return null;
            }

            // Check if expired
            if (Date.now() > cacheItem.expiresAt) {
                this.delete(key);
                this.stats.misses++;
                return null;
            }

            // Update access statistics
            this.accessTimes.set(key, Date.now());
            this.hitCounts.set(key, (this.hitCounts.get(key) || 0) + 1);
            this.stats.hits++;

            return cacheItem.value;
        } catch (error) {
            this.errorHandler.logError('Cache get operation', error);
            this.stats.misses++;
            return null;
        }
    }

    /**
     * Check if a key exists in cache
     */
    async has(key) {
        try {
            const item = await this.get(key);
            return item !== null;
        } catch (error) {
            this.errorHandler.logError('Cache has operation', error);
            return false;
        }
    }

    /**
     * Delete a specific cache entry
     */
    async delete(key) {
        try {
            if (!key) return false;

            const deleted = this.cache.delete(key);
            this.accessTimes.delete(key);
            this.hitCounts.delete(key);

            // Remove from storage
            await this.removeFromStorage(key);

            return deleted;
        } catch (error) {
            this.errorHandler.logError('Cache delete operation', error);
            return false;
        }
    }

    /**
     * Clear all cache entries
     */
    async clear() {
        try {
            this.cache.clear();
            this.accessTimes.clear();
            this.hitCounts.clear();
            
            // Clear storage
            await this.clearStorage();
            
            this.stats.cleanups++;
            return true;
        } catch (error) {
            this.errorHandler.logError('Cache clear operation', error);
            return false;
        }
    }

    /**
     * Get cache statistics
     */
    getStats() {
        const totalRequests = this.stats.hits + this.stats.misses;
        const hitRate = totalRequests > 0 ? (this.stats.hits / totalRequests) * 100 : 0;
        
        return {
            ...this.stats,
            totalRequests,
            hitRate: Math.round(hitRate * 100) / 100,
            cacheSize: this.cache.size,
            memoryUsage: this.getMemoryUsage()
        };
    }

    /**
     * Invalidate cache based on patterns
     */
    async invalidatePattern(pattern) {
        try {
            const keysToDelete = [];
            
            for (const key of this.cache.keys()) {
                if (key.includes(pattern)) {
                    keysToDelete.push(key);
                }
            }

            for (const key of keysToDelete) {
                await this.delete(key);
            }

            return keysToDelete.length;
        } catch (error) {
            this.errorHandler.logError('Cache pattern invalidation', error);
            return 0;
        }
    }

    /**
     * Normalize code for consistent caching
     */
    normalizeCode(code) {
        return code
            .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
            .replace(/\/\/.*$/gm, '') // Remove line comments
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim();
    }

    /**
     * Generate hash for cache key
     */
    hashObject(obj) {
        const str = JSON.stringify(obj, Object.keys(obj).sort());
        let hash = 0;
        
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        
        return Math.abs(hash).toString(36);
    }

    /**
     * Estimate the size of cached value
     */
    estimateSize(value) {
        try {
            return JSON.stringify(value).length;
        } catch (error) {
            return 1000; // Default estimate
        }
    }

    /**
     * Get total memory usage of cache
     */
    getMemoryUsage() {
        let totalSize = 0;
        
        for (const item of this.cache.values()) {
            totalSize += item.size || 0;
        }
        
        return totalSize;
    }

    /**
     * Evict least recently used items
     */
    evictLeastRecentlyUsed() {
        try {
            // Find the least recently used key
            let oldestKey = null;
            let oldestTime = Date.now();

            for (const [key, time] of this.accessTimes.entries()) {
                if (time < oldestTime) {
                    oldestTime = time;
                    oldestKey = key;
                }
            }

            if (oldestKey) {
                this.delete(oldestKey);
                this.stats.evictions++;
            }
        } catch (error) {
            this.errorHandler.logError('Cache eviction', error);
        }
    }

    /**
     * Clean up expired cache entries
     */
    cleanup() {
        try {
            const now = Date.now();
            const keysToDelete = [];

            for (const [key, item] of this.cache.entries()) {
                if (now > item.expiresAt) {
                    keysToDelete.push(key);
                }
            }

            for (const key of keysToDelete) {
                this.delete(key);
            }

            this.stats.cleanups++;
            return keysToDelete.length;
        } catch (error) {
            this.errorHandler.logError('Cache cleanup', error);
            return 0;
        }
    }

    /**
     * Start automatic cleanup timer
     */
    startCleanupTimer() {
        setInterval(() => {
            this.cleanup();
        }, this.cleanupInterval);
    }

    /**
     * Persist cache item to chrome storage
     */
    async persistToStorage(key, item) {
        try {
            const storageKey = `cache_${key}`;
            await chrome.storage.local.set({
                [storageKey]: {
                    ...item,
                    version: 1 // For future migration compatibility
                }
            });
        } catch (error) {
            // Storage errors are non-critical for cache operation
            console.warn('Failed to persist cache to storage:', error);
        }
    }

    /**
     * Load cache item from chrome storage
     */
    async loadFromStorage(key) {
        try {
            const storageKey = `cache_${key}`;
            const result = await chrome.storage.local.get(storageKey);
            const item = result[storageKey];
            
            if (item && item.version === 1) {
                return item;
            }
            
            return null;
        } catch (error) {
            console.warn('Failed to load cache from storage:', error);
            return null;
        }
    }

    /**
     * Remove cache item from chrome storage
     */
    async removeFromStorage(key) {
        try {
            const storageKey = `cache_${key}`;
            await chrome.storage.local.remove(storageKey);
        } catch (error) {
            console.warn('Failed to remove cache from storage:', error);
        }
    }

    /**
     * Clear all cache from chrome storage
     */
    async clearStorage() {
        try {
            const allKeys = await chrome.storage.local.get(null);
            const cacheKeys = Object.keys(allKeys).filter(key => key.startsWith('cache_'));
            
            if (cacheKeys.length > 0) {
                await chrome.storage.local.remove(cacheKeys);
            }
        } catch (error) {
            console.warn('Failed to clear cache storage:', error);
        }
    }
} 