# AI RepoSpector - Quick Start Guide

## 🚀 Getting Started in 5 Minutes

### 1. Setup (One-time)

```bash
# Clone and setup
git clone <repository-url>
cd ai-RepoSpector
make setup  # or ./scripts/dev-setup.sh
```

### 2. Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the project directory

### 3. Configure

1. Click the AI RepoSpector extension icon
2. Click the settings gear ⚙️
3. Add your OpenAI API key (get one at [platform.openai.com](https://platform.openai.com/api-keys))
4. Save settings

### 4. Use It!

1. Navigate to any code on GitHub, GitLab, etc.
2. Click the extension icon
3. Select test type and context level
4. Click "Generate Test Cases"

## 📝 Common Commands

```bash
# Development
make test          # Run tests
make lint          # Check code
make build         # Build extension
make package       # Create .zip for Chrome Web Store

# Or using npm directly
npm test
npm run lint
npm run build
npm run package
```

## 🔧 Development Workflow

1. **Make changes** to source files
2. **Test locally**: `npm test`
3. **Reload extension**: Click refresh in `chrome://extensions/`
4. **Test in browser**: Try the extension on different websites

## 📁 Project Structure

```
ai-RepoSpector/
├── src/               # Source code
│   ├── background/    # Service worker
│   ├── content/       # Content scripts
│   ├── popup/         # Extension UI
│   └── utils/         # Shared utilities
├── test/              # Test files
├── assets/            # Icons and images
├── scripts/           # Build scripts
└── manifest.json      # Extension config
```

## 🐛 Debugging

- **Background script**: Click "service worker" in extension card
- **Popup**: Right-click icon → "Inspect popup"
- **Content script**: Check webpage console

## 📦 Building for Release

```bash
# Full build and package
make package

# This creates:
# - dist/              (unpacked extension)
# - ai-RepoSpector.zip  (for Chrome Web Store)
```

## ❓ Need Help?

- Check `docs/BUILD_GUIDE.md` for detailed instructions
- Review `README.md` for feature documentation
- Look at existing tests in `test/` for examples

Happy coding! 🎉 