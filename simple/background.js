const CONFIG = {
    OPENAI_MODEL: "gpt-4o-mini",          // OpenAI model (e.g., GPT-4 or GPT-3.5)
    MAX_TOKENS: 3000,               // Max tokens for the response
    TEMPERATURE: 0.1                // Temperature (controls randomness)
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "generateTestCases") {
        chrome.storage.sync.get(['openaiApiKey'], async (storage) => {
            const apiKey = storage.openaiApiKey || CONFIG.OPENAI_API_KEY;

            if (!apiKey) {
                sendResponse({ success: false, error: "OpenAI API key not found" });
                return;
            }

            try {
                const response = await fetch("https://api.openai.com/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: CONFIG.OPENAI_MODEL,
                        messages: [
                            {
                                role: "system",
                                content: "You are an expert in generating comprehensive and detailed test cases for web applications by looking at the code. Focus on code coverage and generate atleat 2-3 test cases for each function"
                            },
                            {
                                role: "user",
                                content: `Analyze the following code and generate extensive test cases, including edge cases and negative cases :\n${message.code}`
                            }
                        ],
                        max_tokens: CONFIG.MAX_TOKENS,
                        temperature: CONFIG.TEMPERATURE
                    })
                });

                const data = await response.json();
                console.log("OpenAI Response:", data);

                if (data.choices && data.choices[0] && data.choices[0].message) {
                    const testCases = data.choices[0].message.content;
                    sendResponse({ success: true, testCases });
                } else {
                    sendResponse({ success: false, error: "Invalid response format from OpenAI" });
                }
            } catch (error) {
                console.error("Error during OpenAI API call:", error);
                sendResponse({ success: false, error: error.message });
            }
        });
        return true; // Indicate that the response will be sent asynchronously
    }
});