// Input sanitization and validation utilities
// Provides secure input handling for API keys, user inputs, and file operations

/* eslint-disable no-control-regex */
export class Sanitizer {
    constructor() {
        this.maxLengths = {
            apiKey: 1000,
            filename: 255,
            selector: 500,
            customInput: 500000  // Increased to 500KB for large code files
        };
    }

    sanitizeApiKey(apiKey) {
        if (!apiKey || typeof apiKey !== 'string') return '';
        
        // Remove any whitespace and control characters
        const cleaned = apiKey.trim().replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
        
        // Validate format (basic OpenAI key format)
        if (cleaned.startsWith('sk-') && cleaned.length >= 20) {
            return cleaned.slice(0, this.maxLengths.apiKey);
        }
        
        // For other providers, just clean and limit
        return cleaned.slice(0, this.maxLengths.apiKey);
    }

    sanitizeCustomSelectors(selectors) {
        if (!Array.isArray(selectors)) return [];
        
        return selectors
            .filter(s => typeof s === 'string' && s.trim())
            .map(s => this.sanitizeSelector(s))
            .filter(s => s) // Remove empty strings
            .slice(0, 50); // Limit to 50 selectors
    }

    sanitizeSelector(selector) {
        if (!selector || typeof selector !== 'string') return '';
        
        const cleaned = selector.trim();
        
        // Basic CSS selector validation - must start with valid characters
        if (!/^[.#a-zA-Z[*:]/.test(cleaned)) {
            return '';
        }
        
        // Remove potentially dangerous characters
        const safe = cleaned.replace(/[<>'"\\]/g, '');
        
        return safe.slice(0, this.maxLengths.selector);
    }

    sanitizeFilename(filename) {
        if (!filename || typeof filename !== 'string') return 'download.txt';
        
        // Remove any path separators and dangerous characters
        const cleaned = filename
            .replace(/[/\\:*?"<>|]/g, '-')
            .replace(/\.\./g, '') // Remove path traversal
            .replace(/^\./, '') // Remove leading dot
            .trim();
        
        // Ensure it has an extension
        if (!cleaned.includes('.')) {
            return cleaned + '.txt';
        }
        
        return cleaned.slice(0, this.maxLengths.filename);
    }

    sanitizeUrl(url) {
        if (!url || typeof url !== 'string') return '';
        
        try {
            const parsed = new URL(url);
            
            // Only allow http/https protocols
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return '';
            }
            
            return parsed.toString();
        } catch (error) {
            return '';
        }
    }

    sanitizeCode(code) {
        if (!code || typeof code !== 'string') return '';
        
        // Remove null bytes and other control characters (except common ones)
        const cleaned = code.replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
        
        // Limit length to prevent memory issues
        return cleaned.slice(0, this.maxLengths.customInput);
    }

    sanitizeTestType(testType) {
        const validTypes = ['unit', 'integration', 'api', 'e2e'];
        return validTypes.includes(testType) ? testType : 'unit';
    }

    sanitizeContextLevel(contextLevel) {
        const validLevels = ['minimal', 'smart', 'full'];
        return validLevels.includes(contextLevel) ? contextLevel : 'smart';
    }

    sanitizeModel(model) {
        // This would be populated from the constants
        const validModels = [
            'gpt-4o-mini',
            'gpt-4o',
            'gpt-4-turbo',
            'gpt-4',
            'gpt-3.5-turbo'
        ];
        return validModels.includes(model) ? model : 'gpt-4o-mini';
    }

    sanitizeNumber(value, min = 0, max = 100, defaultValue = 0) {
        const num = parseInt(value, 10);
        if (isNaN(num)) return defaultValue;
        return Math.min(Math.max(num, min), max);
    }

    sanitizeBoolean(value, defaultValue = false) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            return value.toLowerCase() === 'true';
        }
        return defaultValue;
    }

    // Repository and project path sanitization
    sanitizeRepoPath(path) {
        if (!path || typeof path !== 'string') return '';
        
        // Remove dangerous characters and patterns
        const cleaned = path
            .replace(/\.\./g, '') // Path traversal
            .replace(/[<>:"|?*]/g, '') // Windows forbidden chars
            .replace(/\/+/g, '/') // Multiple slashes
            .trim();
        
        return cleaned.slice(0, 500); // Reasonable path length limit
    }

    sanitizeBranch(branch) {
        if (!branch || typeof branch !== 'string') return 'main';
        
        // Git branch name rules
        const cleaned = branch
            .replace(/[~^: \\]/g, '') // Git forbidden chars
            .replace(/\.\./g, '')
            .trim();
        
        // Must not start or end with slash or dot
        return cleaned.replace(/^[/.]+|[/.]+$/g, '') || 'main';
    }

    // Batch sanitization for arrays
    sanitizeArray(arr, sanitizeFunc, maxItems = 100) {
        if (!Array.isArray(arr)) return [];
        
        return arr
            .slice(0, maxItems)
            .map(item => sanitizeFunc.call(this, item))
            .filter(item => item !== null && item !== undefined && item !== '');
    }

    // Validate JSON input
    sanitizeJsonInput(jsonString) {
        if (!jsonString || typeof jsonString !== 'string') return null;
        
        try {
            const parsed = JSON.parse(jsonString);
            
            // Basic size check
            if (JSON.stringify(parsed).length > 100000) {
                throw new Error('JSON too large');
            }
            
            return parsed;
        } catch (error) {
            return null;
        }
    }

    // HTML content sanitization (basic)
    sanitizeHtmlContent(html) {
        if (!html || typeof html !== 'string') return '';
        
        // Remove script tags and dangerous attributes
        return html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '')
            .slice(0, this.maxLengths.customInput);
    }

    // Validate email format (basic)
    sanitizeEmail(email) {
        if (!email || typeof email !== 'string') return '';
        
        const cleaned = email.trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        
        return emailRegex.test(cleaned) ? cleaned : '';
    }

    // Generic sanitization with multiple rules
    sanitizeWithRules(input, rules = {}) {
        if (!input || typeof input !== 'string') return '';
        
        let result = input;
        
        // Apply trim
        if (rules.trim !== false) {
            result = result.trim();
        }
        
        // Apply length limit
        if (rules.maxLength) {
            result = result.slice(0, rules.maxLength);
        }
        
        // Remove control characters
        if (rules.removeControlChars !== false) {
            result = result.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
        }
        
        // Custom regex replacement
        if (rules.replace) {
            rules.replace.forEach(({ pattern, replacement = '' }) => {
                result = result.replace(pattern, replacement);
            });
        }
        
        // Validate against allowed characters
        if (rules.allowedChars) {
            const regex = new RegExp(`[^${rules.allowedChars}]`, 'g');
            result = result.replace(regex, '');
        }
        
        return result;
    }
} 