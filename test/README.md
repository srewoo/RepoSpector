# AI RepoSpector Test Suite

Comprehensive test suite for the AI RepoSpector Chrome Extension, covering unit tests, integration tests, and end-to-end user flows.

## Test Structure

```
test/
├── unit/                    # Unit tests for individual components
│   ├── encryption.test.js   # Encryption service tests
│   ├── errorHandler.test.js # Error handling tests
│   └── codeExtractor.test.js # Code extraction logic tests
├── integration/             # Integration tests
│   └── testCaseGeneration.test.js # API integration tests
├── e2e/                     # End-to-end tests
│   └── userFlow.test.js     # Complete user journey tests
├── jest.config.js           # Jest configuration
├── setup.js                 # Test setup and global mocks
└── package.json            # Test dependencies
```

## Running Tests

### Install Dependencies
```bash
cd test
npm install
```

### Run All Tests
```bash
npm test
```

### Run Specific Test Suites
```bash
# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# E2E tests only
npm run test:e2e

# Watch mode for development
npm run test:watch

# Generate coverage report
npm run test:coverage
```

## Test Coverage

The test suite aims for high coverage:
- **Branches**: 80%
- **Functions**: 80%
- **Lines**: 85%
- **Statements**: 85%

Coverage reports are generated in `test/coverage/` directory.

## Test Categories

### Unit Tests

#### Encryption Service (`encryption.test.js`)
- ✅ Key generation and initialization
- ✅ Encryption/decryption functionality
- ✅ API key validation
- ✅ API key masking
- ✅ Edge cases and error handling

#### Error Handler (`errorHandler.test.js`)
- ✅ Error type detection (401, 429, timeout, network)
- ✅ User-friendly error message generation
- ✅ Error logging and retrieval
- ✅ Log rotation (50 entry limit)

#### Code Extractor (`codeExtractor.test.js`)
- ✅ Text selection extraction
- ✅ Platform-specific extraction (GitHub, GitLab, Bitbucket)
- ✅ Generic code block detection
- ✅ Editor support (CodeMirror, Monaco, Ace)
- ✅ Code cleaning (line numbers, artifacts)
- ✅ Custom selector support
- ✅ Content analysis fallback

### Integration Tests

#### Test Case Generation (`testCaseGeneration.test.js`)
- ✅ Successful API calls to OpenAI
- ✅ Cache functionality
- ✅ Rate limit handling with retry
- ✅ Timeout handling
- ✅ Different test type generation
- ✅ Batch processing
- ✅ API key migration

### End-to-End Tests

#### User Flows (`userFlow.test.js`)
- ✅ First-time user setup flow
- ✅ Returning user with cached results
- ✅ Error recovery scenarios
- ✅ Advanced features (test types, export)
- ✅ Settings management

## Custom Matchers

The test suite includes custom Jest matchers:

### `toBeValidApiKey()`
Validates OpenAI API key format
```javascript
expect(apiKey).toBeValidApiKey();
```

### `toBeEncrypted()`
Checks if a string appears to be encrypted
```javascript
expect(encryptedKey).toBeEncrypted();
```

### `toContainTestCase(pattern)`
Verifies test case content
```javascript
expect(testCases).toContainTestCase('edge case');
```

## Mocking Strategy

### Chrome APIs
All Chrome extension APIs are mocked in `setup.js`:
- `chrome.storage.sync/local`
- `chrome.runtime.sendMessage`
- `chrome.tabs.query/sendMessage`

### External APIs
- `fetch` - Mocked for OpenAI API calls
- `crypto.getRandomValues` - Mocked for encryption
- `navigator.clipboard` - Mocked for copy functionality

### DOM APIs
- `document` methods for code extraction
- `window.getSelection` for text selection

## Best Practices

1. **Isolation**: Each test is isolated with fresh mocks
2. **Clarity**: Descriptive test names explain the scenario
3. **Coverage**: Both happy paths and edge cases are tested
4. **Performance**: Tests run quickly with mocked external calls
5. **Maintainability**: Shared setup reduces duplication

## Debugging Tests

### View Console Output
```bash
# Remove console mocking in setup.js temporarily
// global.console = { ...console, log: jest.fn() };
```

### Run Single Test File
```bash
jest test/unit/encryption.test.js
```

### Debug in VS Code
Add to `.vscode/launch.json`:
```json
{
  "type": "node",
  "request": "launch",
  "name": "Jest Debug",
  "program": "${workspaceFolder}/test/node_modules/.bin/jest",
  "args": ["--runInBand"],
  "console": "integratedTerminal"
}
```

## Contributing

When adding new features:
1. Write tests first (TDD approach)
2. Ensure all tests pass
3. Maintain coverage thresholds
4. Update this README if needed

## CI/CD Integration

These tests are designed to run in CI pipelines:
```yaml
# Example GitHub Actions
- name: Run Tests
  run: |
    cd test
    npm ci
    npm run test:coverage
``` 