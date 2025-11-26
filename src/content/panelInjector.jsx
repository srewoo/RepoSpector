import React from 'react';
import { createRoot } from 'react-dom/client';
import { FloatingPanel } from './FloatingPanel';
import { Sparkles } from 'lucide-react';
import '../popup/index.css'; // Import Tailwind styles
import './floatingPanel.css'; // Import floating panel specific styles

class RepoSpectorPanelInjector {
    constructor() {
        this.panelRoot = null;
        this.toggleButton = null;
        this.isPanelVisible = false;
    }

    init() {
        console.log('🚀 RepoSpector: Initializing floating panel injector');
        this.createToggleButton();

        // Listen for messages from background script to show panel
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.action === 'SHOW_PANEL') {
                this.showPanel();
                sendResponse({ success: true });
            } else if (message.action === 'HIDE_PANEL') {
                this.hidePanel();
                sendResponse({ success: true });
            } else if (message.action === 'TOGGLE_PANEL') {
                this.togglePanel();
                sendResponse({ success: true });
            }
            return true;
        });
    }

    createToggleButton() {
        // Create toggle button
        this.toggleButton = document.createElement('button');
        this.toggleButton.className = 'repospector-toggle-btn';
        this.toggleButton.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
            </svg>
            <span>RepoSpector</span>
        `;
        this.toggleButton.onclick = () => this.togglePanel();
        document.body.appendChild(this.toggleButton);
    }

    togglePanel() {
        if (this.isPanelVisible) {
            this.hidePanel();
        } else {
            this.showPanel();
        }
    }

    showPanel() {
        if (this.isPanelVisible) return;

        console.log('🎨 RepoSpector: Showing floating panel');

        // Hide toggle button
        if (this.toggleButton) {
            this.toggleButton.style.display = 'none';
        }

        // Create container for React root
        const container = document.createElement('div');
        container.id = 'repospector-panel-container';
        document.body.appendChild(container);

        // Create shadow DOM for style isolation
        const shadowRoot = container.attachShadow({ mode: 'open' });

        // Create root element inside shadow DOM
        const rootElement = document.createElement('div');
        shadowRoot.appendChild(rootElement);

        // Import styles into shadow DOM
        const styleLink = document.createElement('link');
        styleLink.rel = 'stylesheet';
        styleLink.href = chrome.runtime.getURL('assets/popup.css');
        shadowRoot.appendChild(styleLink);

        const floatingPanelStyles = document.createElement('link');
        floatingPanelStyles.rel = 'stylesheet';
        floatingPanelStyles.href = chrome.runtime.getURL('content/floatingPanel.css');
        shadowRoot.appendChild(floatingPanelStyles);

        // Render React component
        this.panelRoot = createRoot(rootElement);
        this.panelRoot.render(
            <FloatingPanel onClose={() => this.hidePanel()} />
        );

        this.isPanelVisible = true;
    }

    hidePanel() {
        if (!this.isPanelVisible) return;

        console.log('🎨 RepoSpector: Hiding floating panel');

        // Unmount React component
        if (this.panelRoot) {
            this.panelRoot.unmount();
            this.panelRoot = null;
        }

        // Remove container
        const container = document.getElementById('repospector-panel-container');
        if (container) {
            container.remove();
        }

        // Show toggle button
        if (this.toggleButton) {
            this.toggleButton.style.display = 'flex';
        }

        this.isPanelVisible = false;
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        const injector = new RepoSpectorPanelInjector();
        injector.init();
    });
} else {
    const injector = new RepoSpectorPanelInjector();
    injector.init();
}
