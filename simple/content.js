chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "extractCode") {
        try {
            const selectors = [
                '[data-testid="blob-viewer-file-content"]', // GitHub's code view
                '.diffs.tab-pane.active',                  // Git diff view
                '#diffs',
                '#fileHolder',
                'pre code',                                 // Common code block in web pages
                '[id^="diff-content-"]'                    // IDs starting with 'diff-content-'
            ];

            let codeElement = null;
            for (let selector of selectors) {
                codeElement = document.querySelector(selector);
                if (codeElement) break;
            }

            if (codeElement) {
                const code = codeElement.textContent || codeElement.innerText;
                sendResponse({ success: true, code });
            } else {
                console.error("No code element found.");
                sendResponse({ success: false, error: "No code element found" });
            }
        } catch (error) {
            console.error("Error extracting code:", error);
            sendResponse({ success: false, error: error.message });
        }
        return true; // Keep the message channel open for async response
    }
});