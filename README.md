# 🛡️ RepoSpector Chrome Extension
### Because Your Code Deserves a Safety Net

RepoSpector is a powerful Chrome extension that leverages multiple AI providers to automatically generate comprehensive test cases with guaranteed 100% function coverage. With advanced AST-based code analysis, multi-LLM support, and enterprise-grade security, it's the ultimate testing companion for developers who demand complete test coverage and quality assurance.

## ✨ Features

### Core Functionality
- **Multi-LLM Test Generation**: Supports 10+ AI providers (OpenAI, Anthropic, Google, Cohere, Mistral, Groq, local models) with automatic fallback
- **100% Function Coverage Guarantee**: Ensures every function in your codebase gets tested
- **Multi-Language Support**: Automatically detects and supports JavaScript, TypeScript, Python, Java, C#, Ruby, PHP, Go, and more
- **Multiple Test Types**: Generate Unit, Integration, E2E, or comprehensive tests
- **Smart Code Extraction**: Intelligently extracts code from GitHub, GitLab, Bitbucket, and other platforms

### Context-Aware Generation (NEW!)
- **Repository Context Analysis**: Understands your project structure and dependencies
- **Smart Import Resolution**: Analyzes imports and fetches relevant dependency code
- **Testing Framework Detection**: Automatically detects and uses your project's testing framework
- **Project Pattern Recognition**: Adapts to React, Angular, Vue, Node.js, and other project types
- **Token Optimization**: Intelligently manages context to stay within API limits

### Performance & Reliability
- **Smart Caching**: 1-hour cache for generated tests to reduce API calls
- **Rate Limiting**: Built-in protection against API rate limits
- **Retry Logic**: Exponential backoff for failed requests
- **Error Recovery**: User-friendly error messages with actionable suggestions

### Security
- **AES-256-GCM Encryption**: Military-grade encryption with PBKDF2 key derivation
- **Secure Storage**: Automatic migration from plaintext to encrypted storage
- **API Key Validation**: Real-time validation with proper formatting checks

### User Experience
- **Modern UI**: Clean, gradient-based design with smooth animations
- **Context Level Control**: Choose between Minimal (fast), Smart (recommended), or Full context
- **Real-time Feedback**: Loading states with context information display
- **Copy & Download**: Easy export of generated tests
- **Custom Selectors**: Add your own CSS selectors for code extraction

## 🚀 Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/repospector.git
   cd repospector
   ```

2. Load the extension in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the extension directory

3. Get your API keys (choose one or more providers):
   - Visit [OpenAI API Keys](https://platform.openai.com/api-keys)
   - Create a new API key
   - Copy the key (starts with `sk-`)

4. Configure the extension:
   - Click the RepoSpector icon in Chrome
   - Click the settings gear icon
   - Paste your API key
   - Click "Save Settings"

## 📖 Usage

### Basic Usage

1. **Navigate to code**: Go to any page containing code (GitHub, GitLab, StackOverflow, etc.)
2. **Select code** (optional): Highlight specific code you want to test
3. **Open extension**: Click the RepoSpector icon
4. **Choose options**:
   - Select test type (Unit, Integration, E2E, All)
   - Choose context level (Minimal, Smart, Full)
5. **Generate**: Click "Generate Test Cases"
6. **Export**: Copy to clipboard or download as file

### Context Levels Explained

The extension now fully implements three context levels for intelligent test generation:

- **Minimal (Fast)**: 
  - Extracts only the code visible on the current page
  - Performs basic language detection and syntax analysis
  - Analyzes imports and exports within the visible code
  - No external API calls to GitHub/GitLab
  - Fastest generation time (~2-5 seconds)
  - Best for: Simple, self-contained functions or small code snippets

- **Smart (Recommended)**: 
  - Includes all Minimal context features
  - Fetches and analyzes up to 5 imported files from relative imports
  - Detects testing framework from package.json (Jest, Mocha, Vitest, etc.)
  - Analyzes basic project structure and conventions
  - Makes limited GitHub API calls for essential context
  - Balanced performance (~5-15 seconds)
  - Best for: Most use cases, provides rich context without excessive delays

- **Full (Comprehensive)**: 
  - Includes all Smart context features
  - Fetches complete repository tree structure
  - Analyzes test directories to understand testing patterns
  - Fetches actual test examples from the repository
  - Detects project-wide patterns (TypeScript usage, framework conventions)
  - Multiple GitHub API calls for maximum context
  - Slower generation (~15-30 seconds)
  - Best for: Complex codebases where following existing patterns is crucial

**How Context Affects Test Generation:**
- **Language & Syntax**: Tests are generated in the detected language (JS/TS)
- **Testing Framework**: Uses the correct syntax (Jest, Mocha, etc.)
- **Project Patterns**: Follows conventions like test file locations
- **Dependencies**: Understands imported modules for better mocking
- **Examples**: Learns from existing tests in Full context mode

### Advanced Features

#### Custom Code Selectors
Add your own CSS selectors for better code extraction:
1. Open settings
2. Scroll to "Custom Code Selectors"
3. Add selectors (one per line)
4. Click "Save Settings"

Example selectors:
```
.custom-code-block
#my-code-container pre
[data-code-lang] code
```

#### Supported Platforms
- **GitHub**: Full context support with repository analysis
- **GitLab**: Context support via page analysis
- **Bitbucket**: Basic code extraction
- **StackOverflow**: Code block extraction
- **CodePen**: Editor content extraction
- **Any website**: Generic `<pre>`, `<code>` extraction

## 🏗️ Architecture

### Context Analysis Flow
```
1. Code Extraction
   ├── Selected text (priority)
   ├── Platform-specific selectors
   └── Generic code blocks

2. Context Analysis
   ├── Language detection
   ├── Import/Export parsing
   ├── Repository structure (if available)
   └── Testing framework detection

3. Dependency Resolution
   ├── Identify relative imports
   ├── Fetch relevant files (with rate limiting)
   └── Extract key functions/classes

4. Test Generation
   ├── Build context-aware prompt
   ├── Include dependency information
   ├── Apply project patterns
   └── Generate with appropriate framework
```

### Key Components

- **ContextAnalyzer**: Intelligent code analysis and dependency resolution
- **RateLimiter**: API call management (60 requests/hour for GitHub)
- **Token Optimizer**: Keeps context within GPT token limits
- **Cache System**: Reduces redundant API calls

## 🧪 Testing

Run the test suite:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

Generate coverage report:

```bash
npm run test:coverage
```

## 🔧 Development

### Project Structure
```
repospector/
├── src/
│   ├── background/
│   │   └── background.js      # Service worker
│   ├── content/
│   │   └── content.js         # Content script
│   ├── popup/
│   │   ├── popup.html         # Extension UI
│   │   ├── popup.js           # UI logic
│   │   └── popup.css          # Styles
│   └── utils/
│       ├── constants.js       # Configuration
│       ├── contextAnalyzer.js # Context analysis
│       ├── encryption.js      # Security
│       └── errorHandler.js    # Error management
├── test/                      # Test files
├── assets/                    # Icons and images
└── manifest.json             # Extension manifest
```

### Building for Production

1. Update version in `manifest.json`
2. Run tests: `npm test`
3. Create a zip file of the extension directory
4. Upload to Chrome Web Store

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- OpenAI for providing the GPT API
- Chrome Extensions documentation
- The open-source community

## 📞 Support

If you encounter any issues or have questions:
- Open an issue on GitHub
- Check the error logs (Settings → View Error Logs)
- Ensure your API key is valid and has sufficient credits

---

Made with ❤️ by developers, for developers

**RepoSpector** - Because Your Code Deserves a Safety Net 