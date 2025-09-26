// Popup script for RepoSpector Chrome Extension
// Modern ES6 module-based implementation

import { EncryptionService } from '../utils/encryption.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { Sanitizer } from '../utils/sanitizer.js';
import { MODELS, SUCCESS_MESSAGES, ERROR_MESSAGES as _ERROR_MESSAGES } from '../utils/constants.js';

// Initialize services
const encryptionService = new EncryptionService();
const errorHandler = new ErrorHandler();
const sanitizer = new Sanitizer();

// DOM Elements
const elements = {
    // Main buttons
    generateBtn: document.getElementById('generateBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    
    // Settings modal
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    apiKeyInput: document.getElementById('apiKey'),
    toggleApiKeyBtn: document.getElementById('toggleApiKeyBtn'),
    gitlabTokenInput: document.getElementById('gitlabToken'),
    toggleGitlabTokenBtn: document.getElementById('toggleGitlabTokenBtn'),
    testGitlabTokenBtn: document.getElementById('testGitlabTokenBtn'),
    modelSelect: document.getElementById('model'),
    customSelectorsTextarea: document.getElementById('customSelectors'),
    autoCacheCheckbox: document.getElementById('autoCache'),
    testModeSelect: document.getElementById('testMode'),
    e2eFrameworkSelect: document.getElementById('e2eFramework'),
    
    // Options
    testTypeSelect: document.getElementById('testType'),
    contextLevelSelect: document.getElementById('contextLevel'),
    
    // Results
    resultContainer: document.getElementById('resultContainer'),
    resultContent: document.getElementById('resultContent'),
    copyBtn: document.getElementById('copyBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    
    // Error display
    errorContainer: document.getElementById('errorContainer'),
    errorMessage: document.getElementById('errorMessage'),
    
    // Toast container
    toastContainer: document.getElementById('toastContainer'),
    
    // Footer links
    helpLink: document.getElementById('helpLink'),
    feedbackLink: document.getElementById('feedbackLink'),
    
    // Progress indicators
    progressContainer: document.getElementById('progressContainer'),
    progressBar: document.getElementById('progressBar'),
    progressText: document.getElementById('progressText'),
    progressPercentage: document.getElementById('progressPercentage')
};

// State
let state = {
    apiKey: '',
    apiKeyVisible: false,
    gitlabToken: '',
    gitlabTokenVisible: false,
    isGenerating: false,
    lastResult: null,
    currentTab: null
};

// Initialize popup
async function init() {
    try {
        // Load settings first (this loads the API key)
        await loadSettings();
        
        // Setup event listeners
        setupEventListeners();
        
        // Set initial UI state
        setInitialUIState();
        
        // Detect current page (this can happen in parallel)
        detectCurrentPage(); // Don't await this as it's not critical
        
        // Validate API key last (after it's been loaded)
        await validateApiKey();
        
        console.log('Popup initialized successfully');
    } catch (error) {
        console.error('Initialization failed:', error);
        showError('Failed to initialize extension. Please refresh and try again.');
    }
}

// Detect current page and adjust UI accordingly
async function detectCurrentPage() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        state.currentTab = tab;
        
        // Check if we can inject content scripts into this tab
        if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('moz-extension://')) {
            console.log('Cannot inject content script into this tab:', tab?.url);
            updateUIForUnsupportedPage();
            return;
        }
        
        // Try to communicate with existing content script first
        try {
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: 'detectCodeType'
            });
            
            if (response?.success) {
                updateUIForPageType(response.detection);
                return;
            }
        } catch (error) {
            console.log('Content script not responding, will try to inject...');
        }
        
        // If content script doesn't respond, try to inject it
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
            });
            
            // Wait a moment for the content script to initialize
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Try to communicate again
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: 'detectCodeType'
            });
            
            if (response?.success) {
                updateUIForPageType(response.detection);
            } else {
                console.log('Content script injected but not responding properly');
                updateUIForGenericPage();
            }
        } catch (injectionError) {
            console.warn('Failed to inject or communicate with content script:', injectionError);
            updateUIForGenericPage();
        }
    } catch (error) {
        console.error('Failed to detect page type:', error);
        updateUIForGenericPage();
    }
}

function updateUIForUnsupportedPage() {
    // Hide generate button for unsupported pages
    if (elements.generateBtn) {
        elements.generateBtn.disabled = true;
        elements.generateBtn.textContent = 'Page Not Supported';
    }
    
    // Note: pageTypeIndicator removed from UI
}

function updateUIForGenericPage() {
    // Re-enable generate button for generic pages
    if (elements.generateBtn) {
        elements.generateBtn.disabled = false;
        elements.generateBtn.textContent = 'Generate Test Cases';
    }
    
    // Note: pageTypeIndicator removed from UI
}

function updateUIForPageType(detection) {
    // Note: pageTypeIndicator removed from UI - no longer showing page type
    
    // Adjust context level recommendations
    if (detection.isDiffPage) {
        elements.contextLevelSelect.value = 'smart'; // Default to smart for diff pages
    }
}

// Set initial UI state
function setInitialUIState() {
    // Show/hide E2E framework select based on initial test type
    const isE2E = elements.testTypeSelect.value === 'e2e';
    const e2eGroup = document.getElementById('e2eFrameworkGroup');
    if (e2eGroup) {
        e2eGroup.style.display = isE2E ? 'block' : 'none';
    }
    
    // Populate model dropdown
    populateModelSelect();
}

function populateModelSelect() {
    if (!elements.modelSelect) return;
    
    // Clear existing options
    elements.modelSelect.innerHTML = '';
    
    // Add model options
    Object.entries(MODELS).forEach(([key, model]) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = `${model.name} (${model.maxTokens} tokens)`;
        elements.modelSelect.appendChild(option);
    });
}

// Load settings from storage
async function loadSettings() {
    try {
        console.log('Loading settings from storage...');
        const result = await chrome.storage.local.get('aiRepoSpectorSettings');
        const settings = result.aiRepoSpectorSettings || {};
        
        console.log('Settings loaded:', { 
            hasApiKey: !!settings.apiKey, 
            hasGitlabToken: !!settings.gitlabToken,
            model: settings.model,
            settingsKeys: Object.keys(settings)
        });
        
        // Load API key
        if (settings.apiKey) {
            try {
                console.log('Decrypting API key...');
                const decryptedKey = await encryptionService.decrypt(settings.apiKey);
                state.apiKey = decryptedKey || '';
                console.log('API key decrypted successfully:', { 
                    hasKey: !!state.apiKey, 
                    keyLength: state.apiKey?.length || 0,
                    keyPrefix: state.apiKey?.substring(0, 7) || 'none'
                });
                
                if (elements.apiKeyInput) {
                    elements.apiKeyInput.value = state.apiKey ? maskApiKey(state.apiKey) : '';
                }
            } catch (error) {
                console.warn('Failed to decrypt API key:', error);
                state.apiKey = '';
            }
        } else {
            console.log('No API key found in settings');
            state.apiKey = '';
        }

        // Load GitLab token
        if (settings.gitlabToken) {
            try {
                const decryptedToken = await encryptionService.decrypt(settings.gitlabToken);
                state.gitlabToken = decryptedToken || '';
                if (elements.gitlabTokenInput) {
                    elements.gitlabTokenInput.value = state.gitlabToken ? maskApiKey(state.gitlabToken) : '';
                }
            } catch (error) {
                console.warn('Failed to decrypt GitLab token:', error);
                state.gitlabToken = '';
            }
        }
        
        // Load other settings
        if (elements.modelSelect && settings.model) {
            elements.modelSelect.value = settings.model;
        }
        
        if (elements.customSelectorsTextarea && settings.customSelectors) {
            elements.customSelectorsTextarea.value = Array.isArray(settings.customSelectors) 
                ? settings.customSelectors.join('\n') 
                : settings.customSelectors;
        }
        
        if (elements.autoCacheCheckbox) {
            elements.autoCacheCheckbox.checked = settings.autoCache !== false;
        }
        
        if (elements.testModeSelect && settings.testMode) {
            elements.testModeSelect.value = settings.testMode;
        }
        
        if (elements.e2eFrameworkSelect && settings.e2eFramework) {
            elements.e2eFrameworkSelect.value = settings.e2eFramework;
        }
        
        if (elements.contextLevelSelect && settings.contextLevel) {
            elements.contextLevelSelect.value = settings.contextLevel;
        }
        
        console.log('Settings loaded successfully');
        
    } catch (error) {
        console.error('Failed to load settings:', error);
        // Initialize with defaults
        state.apiKey = '';
        state.gitlabToken = '';
    }
}

function setupEventListeners() {
    // Main buttons
    if (elements.generateBtn) {
        elements.generateBtn.addEventListener('click', handleGenerate);
    }
    
    if (elements.settingsBtn) {
        elements.settingsBtn.addEventListener('click', () => showModal(elements.settingsModal));
    }
    
    // Settings modal
    if (elements.closeSettingsBtn) {
        elements.closeSettingsBtn.addEventListener('click', () => hideModal(elements.settingsModal));
    }
    
    if (elements.saveSettingsBtn) {
        elements.saveSettingsBtn.addEventListener('click', saveSettings);
    }
    
    if (elements.toggleApiKeyBtn) {
        elements.toggleApiKeyBtn.addEventListener('click', toggleApiKeyVisibility);
    }

    if (elements.toggleGitlabTokenBtn) {
        elements.toggleGitlabTokenBtn.addEventListener('click', toggleGitlabTokenVisibility);
    }

    if (elements.testGitlabTokenBtn) {
        elements.testGitlabTokenBtn.addEventListener('click', testGitlabToken);
    }
    
    // Test type change
    if (elements.testTypeSelect) {
        elements.testTypeSelect.addEventListener('change', (e) => {
            const isE2E = e.target.value === 'e2e';
            const e2eGroup = document.getElementById('e2eFrameworkGroup');
            if (e2eGroup) {
                e2eGroup.style.display = isE2E ? 'block' : 'none';
            }
        });
    }
    
    // Result actions
    if (elements.copyBtn) {
        elements.copyBtn.addEventListener('click', () => {
            if (state.lastResult) {
                copyToClipboard(state.lastResult);
            }
        });
    }
    
    if (elements.downloadBtn) {
        elements.downloadBtn.addEventListener('click', () => {
            if (state.lastResult) {
                downloadResults(state.lastResult);
            }
        });
    }
    
    // Footer links
    if (elements.helpLink) {
        elements.helpLink.addEventListener('click', showHelp);
    }
    
    if (elements.feedbackLink) {
        elements.feedbackLink.addEventListener('click', showFeedback);
    }
    
    // Modal close on outside click
    window.addEventListener('click', (e) => {
        if (e.target === elements.settingsModal) {
            hideModal(elements.settingsModal);
        }
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideModal(elements.settingsModal);
            hideError();
        }
        
        if (e.key === 'Enter' && e.ctrlKey) {
            if (!state.isGenerating) {
                handleGenerate();
            }
        }
    });
}

async function handleGenerate() {
    if (state.isGenerating) return;
    
    // Check if we have a valid current tab
    if (!state.currentTab || !state.currentTab.id) {
        try {
            // Try to get current tab again
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.id) {
                throw new Error('No active tab found');
            }
            state.currentTab = tab;
        } catch (error) {
            showError('Unable to access current tab. Please refresh the page and try again.');
            return;
        }
    }
    
    // Check if API key is configured
    if (!state.apiKey) {
        // Open settings modal instead of showing error
        showModal(elements.settingsModal);
        return;
    }
    
    try {
        state.isGenerating = true;
        hideError();
        hideResults();
        
        // Get generation options
        const options = {
            testType: elements.testTypeSelect?.value || 'unit',
            testMode: elements.testModeSelect?.value || 'implementation',
            contextLevel: elements.contextLevelSelect?.value || 'smart',
            model: elements.modelSelect?.value || 'gpt-4o-mini',
            e2eFramework: elements.e2eFrameworkSelect?.value || 'playwright'
        };
        
        // Start progress tracking with step-by-step indicators
        showLoading(true);
        
        // Enhanced progress messages for All Types
        const isAllTypes = options.testType === 'all' || options.testType === 'All Types';
        
        // Step 1: Extracting code from page
        updateProgress(10, 'Extracting code from the current page...', 1);
        await new Promise(resolve => setTimeout(resolve, 800)); // Small delay for UX
        
        // Step 2: Fetching repository context
        updateProgress(25, 'Analyzing repository structure and dependencies...', 2);
        await new Promise(resolve => setTimeout(resolve, 600));
        
        // Step 3: Analyzing code
        updateProgress(40, 'Understanding code patterns and architecture...', 3);
        await new Promise(resolve => setTimeout(resolve, 400));
        
        // Step 4: Generate tests (this is the main API call)
        if (isAllTypes) {
            updateProgress(60, 'Generating comprehensive test suite (Unit, Integration, API, E2E)...', 4);
        } else {
            updateProgress(60, `Generating ${options.testType} test cases...`, 4);
        }
        
        // Send message to background script to generate tests
        const response = await chrome.runtime.sendMessage({
            type: 'GENERATE_TESTS',
            data: {
                tabId: state.currentTab.id,
                options: options
            }
        });
        
        if (!response.success) {
            showLoading(false);
            
            // Provide more specific error messages
            let errorMessage = response.error || 'Unknown error occurred';
            
            if (errorMessage.includes('Code extraction failed')) {
                errorMessage = `Code extraction failed. This can happen if:\n• The page doesn't contain readable code\n• The page is not fully loaded\n• The content is dynamically generated\n\nTry refreshing the page and ensuring code is visible before generating tests.\n\nOriginal error: ${response.error}`;
            } else if (errorMessage.includes('API key')) {
                errorMessage = 'OpenAI API key is not configured. Please set your API key in the settings.';
            } else if (errorMessage.includes('No code provided')) {
                errorMessage = 'No code could be found on this page. Please navigate to a page with code content (e.g., GitHub file view, code editor, or documentation with code examples).';
            }
            
            showError(errorMessage);
            return;
        }
        
        // Step 5: Formatting results
        if (isAllTypes) {
            updateProgress(85, 'Organizing comprehensive test suites by type...', 5);
        } else {
            updateProgress(85, 'Formatting and organizing test cases...', 5);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Complete all steps
        for (let i = 1; i <= 5; i++) {
            updateProgressStep(i, 'completed');
        }
        
        if (isAllTypes) {
            updateProgress(100, 'Comprehensive test suite generation complete!');
        } else {
            updateProgress(100, 'Test generation complete!');
        }
        
        state.lastResult = response.testCases;
        
        // Small delay before showing results for better UX
        await new Promise(resolve => setTimeout(resolve, 800));
        showResults(response.testCases, response.fromCache);
        
        if (response.fromCache) {
            showToast('Results loaded from cache', 'info');
        } else {
            if (isAllTypes) {
                showToast('✅ Comprehensive test suite generated successfully!', 'success');
            } else {
                showToast(SUCCESS_MESSAGES.TEST_CASES_GENERATED, 'success');
            }
        }

        // Show context verification if full context was used
        if (options.contextLevel === 'full' && response.data?.context?.fullContextVerification) {
            showContextVerification(response.data.context.fullContextVerification);
        }

    } catch (error) {
        const errorMessage = errorHandler.handleExtensionError(error, 'Test generation failed');
        showError(errorMessage);
        console.error('Generation failed:', error);
    } finally {
        state.isGenerating = false;
        showLoading(false);
    }
}

async function saveSettings() {
    try {
        // Get existing settings first
        const result = await chrome.storage.local.get('aiRepoSpectorSettings');
        const settings = result.aiRepoSpectorSettings || {};
        
        // Save API key (encrypted)
        if (elements.apiKeyInput?.value && !elements.apiKeyInput.value.includes('•')) {
            const sanitizedKey = sanitizer.sanitizeApiKey(elements.apiKeyInput.value);
            const encryptedKey = await encryptionService.encrypt(sanitizedKey);
            settings.apiKey = encryptedKey;
            state.apiKey = sanitizedKey;
        }

        // Save GitLab token (encrypted)
        if (elements.gitlabTokenInput?.value && !elements.gitlabTokenInput.value.includes('•')) {
            const sanitizedToken = sanitizer.sanitizeApiKey(elements.gitlabTokenInput.value);
            const encryptedToken = await encryptionService.encrypt(sanitizedToken);
            settings.gitlabToken = encryptedToken;
            state.gitlabToken = sanitizedToken;
        }
        
        // Save other settings
        if (elements.modelSelect?.value) {
            settings.model = elements.modelSelect.value;
        }
        
        if (elements.customSelectorsTextarea?.value) {
            const selectors = elements.customSelectorsTextarea.value
                .split('\n')
                .map(s => s.trim())
                .filter(s => s);
            settings.customSelectors = sanitizer.sanitizeCustomSelectors(selectors);
        }
        
        settings.autoCache = elements.autoCacheCheckbox?.checked !== false;
        
        if (elements.testModeSelect?.value) {
            settings.testMode = elements.testModeSelect.value;
        }
        
        if (elements.contextLevelSelect?.value) {
            settings.contextLevel = elements.contextLevelSelect.value;
        }
        
        if (elements.e2eFrameworkSelect?.value) {
            settings.e2eFramework = elements.e2eFrameworkSelect.value;
        }
        
        await chrome.storage.local.set({ aiRepoSpectorSettings: settings });
        
        hideModal(elements.settingsModal);
        showToast(SUCCESS_MESSAGES.SETTINGS_SAVED, 'success');
        
        // Update API key display
        if (elements.apiKeyInput && state.apiKey) {
            elements.apiKeyInput.value = maskApiKey(state.apiKey);
        }

        // Update GitLab token display
        if (elements.gitlabTokenInput && state.gitlabToken) {
            elements.gitlabTokenInput.value = maskApiKey(state.gitlabToken);
        }
        
        await validateApiKey();
        
    } catch (error) {
        const errorMessage = errorHandler.handleExtensionError(error, 'Failed to save settings');
        showError(errorMessage);
        console.error('Settings save failed:', error);
    }
}

async function validateApiKey() {
    try {
        // If no API key is loaded, try to get it from storage
        if (!state.apiKey) {
            const response = await chrome.runtime.sendMessage({
                type: 'GET_SETTINGS'
            });
            
            if (response?.success && response.data?.apiKey) {
                state.apiKey = response.data.apiKey;
            }
        }
        
        // Skip validation if still no API key
        if (!state.apiKey) {
            updateButtonForNoApiKey();
            return false;
        }
        
        const response = await chrome.runtime.sendMessage({
            type: 'VALIDATE_API_KEY',
            data: { apiKey: state.apiKey }
        });
        
        const isValid = response?.valid === true;
        
        // Update generate button state
        if (elements.generateBtn) {
            elements.generateBtn.disabled = !isValid;
            elements.generateBtn.textContent = isValid ? 'Generate Test Cases' : 'Configure API Key';
        }
        
        // Update API key input styling
        if (elements.apiKeyInput) {
            elements.apiKeyInput.classList.toggle('valid', isValid);
            elements.apiKeyInput.classList.toggle('invalid', !isValid);
        }
        
        return isValid;
        
    } catch (error) {
        console.error('API key validation failed:', error);
        updateButtonForNoApiKey();
        return false;
    }
}

function updateButtonForNoApiKey() {
    if (elements.generateBtn) {
        elements.generateBtn.disabled = false; // Enable so user can click to open settings
        elements.generateBtn.textContent = 'Configure API Key';
    }
}

function toggleApiKeyVisibility() {
    state.apiKeyVisible = !state.apiKeyVisible;
    
    if (elements.apiKeyInput && elements.toggleApiKeyBtn) {
        if (state.apiKeyVisible && state.apiKey) {
            elements.apiKeyInput.value = state.apiKey;
            elements.toggleApiKeyBtn.textContent = '👁️';
        } else if (state.apiKey) {
            elements.apiKeyInput.value = maskApiKey(state.apiKey);
            elements.toggleApiKeyBtn.textContent = '👁️‍🗨️';
        }
    }
}

function toggleGitlabTokenVisibility() {
    state.gitlabTokenVisible = !state.gitlabTokenVisible;
    
    if (elements.gitlabTokenInput && elements.toggleGitlabTokenBtn) {
        if (state.gitlabTokenVisible && state.gitlabToken) {
            elements.gitlabTokenInput.value = state.gitlabToken;
            elements.toggleGitlabTokenBtn.textContent = '👁️';
        } else if (state.gitlabToken) {
            elements.gitlabTokenInput.value = maskApiKey(state.gitlabToken);
            elements.toggleGitlabTokenBtn.textContent = '👁️‍🗨️';
        }
    }
}

async function testGitlabToken() {
    if (!elements.testGitlabTokenBtn || !elements.gitlabTokenInput) return;
    
    const token = elements.gitlabTokenInput.value;
    if (!token || token.includes('•')) {
        showToast('Please enter a GitLab token first', 'error');
        return;
    }
    
    const testBtn = elements.testGitlabTokenBtn;
    testBtn.disabled = true;
    testBtn.classList.add('testing');
    testBtn.textContent = '⏳';
    
    try {
        // Test the token by making a simple API call
        const response = await fetch('https://gitlab.com/api/v4/user', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (response.ok) {
            testBtn.classList.remove('testing');
            testBtn.classList.add('success');
            testBtn.textContent = '✅';
            showToast('GitLab token is valid!', 'success');
            
            setTimeout(() => {
                testBtn.classList.remove('success');
                testBtn.textContent = '🔍';
                testBtn.disabled = false;
            }, 3000);
        } else {
            throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }
    } catch (error) {
        testBtn.classList.remove('testing');
        testBtn.classList.add('error');
        testBtn.textContent = '❌';
        showToast(`GitLab token test failed: ${error.message}`, 'error');
        
        setTimeout(() => {
            testBtn.classList.remove('error');
            testBtn.textContent = '🔍';
            testBtn.disabled = false;
        }, 3000);
    }
}

function maskApiKey(apiKey) {
    if (!apiKey) return '';
    const prefix = apiKey.substring(0, 7);
    const suffix = apiKey.substring(apiKey.length - 4);
    return `${prefix}${'•'.repeat(20)}${suffix}`;
}

function showLoading(show) {
    if (elements.generateBtn) {
        elements.generateBtn.disabled = show;
        elements.generateBtn.textContent = show ? 'Generating...' : 'Generate Test Cases';
    }
    
    if (elements.progressContainer) {
        elements.progressContainer.style.display = show ? 'block' : 'none';
    }
    
    if (show) {
        resetProgressSteps();
        updateProgressStep(1, 'active');
        updateProgress(0, 'Starting test generation...');
    }
}

function updateProgress(percentage, message, step = null) {
    // Update progress bar
    if (elements.progressBar) {
        elements.progressBar.style.width = `${percentage}%`;
    }
    
    // Update progress text
    if (elements.progressText) {
        elements.progressText.textContent = message;
    }
    
    // Update percentage display
    const progressPercentage = document.getElementById('progressPercentage');
    if (progressPercentage) {
        progressPercentage.textContent = `${Math.round(percentage)}%`;
    }
    
    // Update step if provided
    if (step) {
        updateProgressStep(step, 'active');
        
        // Mark previous steps as completed
        for (let i = 1; i < step; i++) {
            updateProgressStep(i, 'completed');
        }
    }
}

function updateProgressStep(stepNumber, state) {
    const stepElement = document.getElementById(`step${stepNumber}`);
    if (!stepElement) return;
    
    // Remove all state classes
    stepElement.classList.remove('active', 'completed');
    
    // Add new state class
    if (state !== 'inactive') {
        stepElement.classList.add(state);
    }
    
    // Update step icon content
    const stepIcon = stepElement.querySelector('.step-icon');
    const stepNumber_el = stepElement.querySelector('.step-number');
    const stepSpinner = stepElement.querySelector('.step-spinner');
    const stepCheck = stepElement.querySelector('.step-check');
    
    if (stepIcon && stepNumber_el && stepSpinner && stepCheck) {
        // Hide all icon elements first
        stepNumber_el.style.display = 'none';
        stepSpinner.style.display = 'none';
        stepCheck.style.display = 'none';
        
        // Show appropriate icon based on state
        switch (state) {
            case 'active':
                stepSpinner.style.display = 'block';
                break;
            case 'completed':
                stepCheck.style.display = 'block';
                break;
            default:
                stepNumber_el.style.display = 'block';
                break;
        }
    }
}

function resetProgressSteps() {
    for (let i = 1; i <= 5; i++) {
        updateProgressStep(i, 'inactive');
    }
}

function showResults(testCases, fromCache = false) {
    if (!elements.resultContainer || !elements.resultContent) return;
    
    elements.resultContent.textContent = testCases;
    elements.resultContainer.style.display = 'block';
    
    // Add cache indicator if from cache
    const cacheIndicator = document.getElementById('cacheIndicator');
    if (cacheIndicator) {
        cacheIndicator.style.display = fromCache ? 'inline' : 'none';
    }
    
    // Enable action buttons
    if (elements.copyBtn) elements.copyBtn.disabled = false;
    if (elements.downloadBtn) elements.downloadBtn.disabled = false;
}

function hideResults() {
    if (elements.resultContainer) {
        elements.resultContainer.style.display = 'none';
    }
    
    // Disable action buttons
    if (elements.copyBtn) elements.copyBtn.disabled = true;
    if (elements.downloadBtn) elements.downloadBtn.disabled = true;
}

function showError(message) {
    if (elements.errorContainer && elements.errorMessage) {
        elements.errorMessage.textContent = message;
        elements.errorContainer.style.display = 'block';
    }
}

function hideError() {
    if (elements.errorContainer) {
        elements.errorContainer.style.display = 'none';
    }
}

function showModal(modal) {
    if (modal) {
        modal.style.display = 'block';
    }
}

function hideModal(modal) {
    if (modal) {
        modal.style.display = 'none';
    }
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast(SUCCESS_MESSAGES.COPIED_TO_CLIPBOARD, 'success');
    } catch (error) {
        console.error('Copy failed:', error);
        showToast('Failed to copy to clipboard', 'error');
    }
}

function downloadResults(text) {
    try {
        const testType = elements.testTypeSelect?.value || 'test';
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        const filename = sanitizer.sanitizeFilename(`${testType}-cases-${timestamp}.txt`);
        
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showToast('Test cases downloaded', 'success');
        
    } catch (error) {
        console.error('Download failed:', error);
        showToast('Failed to download results', 'error');
    }
}

function showToast(message, type = 'info') {
    if (!elements.toastContainer) return;
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    elements.toastContainer.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.classList.add('show'), 100);
    
    // Remove after delay
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, 3000);
}

function showHelp(e) {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://github.com/your-username/repospector#usage' });
}

function showFeedback(e) {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://github.com/your-username/repospector/issues' });
}

function showContextVerification(verification) {
    const contextVerificationPanel = document.getElementById('contextVerification');
    if (!contextVerificationPanel) return;
    
    // Update verification details
    const methodEl = document.getElementById('verificationMethod');
    const filesEl = document.getElementById('verificationFiles');
    const frameworkEl = document.getElementById('verificationFramework');
    const depsEl = document.getElementById('verificationDeps');
    const patternsEl = document.getElementById('verificationPatterns');
    
    if (methodEl) {
        methodEl.textContent = verification.method || 'Unknown';
        methodEl.className = verification.method ? 'verification-value' : 'verification-value empty';
    }
    
    if (filesEl) {
        const fileCount = verification.repositoryFilesCount || 0;
        filesEl.textContent = fileCount > 0 ? `${fileCount} files` : 'None';
        filesEl.className = fileCount > 0 ? 'verification-value' : 'verification-value empty';
    }
    
    if (frameworkEl) {
        frameworkEl.textContent = verification.testingFramework || 'Not detected';
        frameworkEl.className = verification.testingFramework ? 'verification-value' : 'verification-value empty';
    }
    
    if (depsEl) {
        const deps = verification.dependenciesCount;
        if (deps && (deps.production > 0 || deps.development > 0)) {
            depsEl.textContent = `${deps.production} prod, ${deps.development} dev`;
            depsEl.className = 'verification-value';
        } else {
            depsEl.textContent = 'None found';
            depsEl.className = 'verification-value empty';
        }
    }
    
    if (patternsEl) {
        patternsEl.textContent = verification.hasTestPatterns ? 'Extracted' : 'None found';
        patternsEl.className = verification.hasTestPatterns ? 'verification-value' : 'verification-value empty';
    }
    
    // Show the verification panel
    contextVerificationPanel.style.display = 'block';
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { init, handleGenerate, saveSettings };
} 