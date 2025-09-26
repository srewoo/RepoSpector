document.addEventListener("DOMContentLoaded", () => {
    const generateButton = document.getElementById("generateButton");
    const outputDiv = document.getElementById("output");
    const loadingIndicator = document.getElementById("loadingIndicator");
    const apiKeyInput = document.getElementById("apiKey");
    const saveApiKeyButton = document.getElementById("saveApiKey");

    // Load saved API key
    chrome.storage.sync.get(["openaiApiKey"], (result) => {
        if (result.openaiApiKey) {
            apiKeyInput.value = result.openaiApiKey;
        }
    });

    // Save API key
    saveApiKeyButton.addEventListener("click", () => {
        const apiKey = apiKeyInput.value.trim();
        if (apiKey) {
            chrome.storage.sync.set({ openaiApiKey: apiKey }, () => {
                alert("API Key saved successfully!");
            });
        }
    });

    generateButton.addEventListener("click", () => {
        loadingIndicator.classList.remove("hidden");
        outputDiv.innerHTML = ""; // Clear previous results

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, { action: "extractCode" }, (response) => {
                if (response && response.code) {
                    chrome.runtime.sendMessage(
                        { action: "generateTestCases", code: response.code },
                        (testCaseResponse) => {
                            loadingIndicator.classList.add("hidden");

                            if (testCaseResponse.success) {
                                const testCases = testCaseResponse.testCases;

                                // Convert the test cases into a table format
                                outputDiv.innerHTML = generateTestCasesTable(testCases);
                            } else {
                                outputDiv.textContent = `Error: ${testCaseResponse.error}`;
                            }
                        }
                    );
                } else {
                    loadingIndicator.classList.add("hidden");
                    outputDiv.textContent = "Error: No code found on the page.";
                }
            });
        });
    });

});

// Function to generate the test cases in a tabular format
function generateTestCasesTable(testCases) {
    // Split the test cases by line breaks or some other pattern
    const rows = testCases.split("\n").filter(Boolean).map(testCase => {
        // Assuming the test case format contains title, ID, type, etc.
        // You can adapt this based on how the test cases are structured.
        const columns = testCase.split(":"); // Example split; modify as needed
        return `
            <tr>
                <td>${columns[0] || ''}</td>
                <td>${columns[1] || ''}</td>
            </tr>
        `;
    }).join("");

    return `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>Title</th>
                        <th>ID</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        </div>
    `;
}