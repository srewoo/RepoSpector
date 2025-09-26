# 🔍 Context Verification Guide

This guide helps you verify that the AI RepoSpector extension is properly collecting and using complete repository context when the Context Level is set to "Full".

## 🎯 How to Verify Full Context Usage

### 1. **Visual Verification Panel**

When you set Context Level to "Full" and generate test cases, you'll see a **Context Verification Panel** above the generated tests that shows:

- **Method**: Whether GitHub API, GitLab API, or web scraping was used
- **Files Analyzed**: Number of repository files analyzed
- **Testing Framework**: Detected testing framework (Jest, Vitest, etc.)
- **Dependencies**: Count of production and development dependencies
- **Test Patterns**: Whether existing test patterns were extracted

### 2. **Browser Console Verification**

1. Open Chrome DevTools (F12)
2. Go to the **Console** tab
3. Set Context Level to "Full"
4. Generate test cases
5. Look for detailed logging messages:

#### For GitLab with Token:
```
🔍 FULL CONTEXT VERIFICATION - GitLab API Enhancement:
📁 Repository Info: {name: "project-name", description: "..."}
📋 Repository Files Analyzed: 25
🧪 Testing Framework Detected: jest
📦 Dependencies Found: 15 production, 8 dev
🔬 Test Files Analyzed: 3
📄 Config Files: ["package.json", "jest.config.js", "tsconfig.json"]
🧩 Test Patterns: Extracted
```

#### For GitHub:
```
🔍 FULL CONTEXT VERIFICATION - GitHub API Enhancement:
📁 Repository Structure Analyzed
🧪 Testing Framework Detected: jest
🔧 Project Patterns: {...}
🧩 Test Examples: Extracted
```

### 3. **Generated Test Quality Indicators**

When full context is properly used, you should see:

✅ **Better Test Structure**: Tests follow the detected testing framework patterns
✅ **Accurate Imports**: Generated tests import the correct dependencies
✅ **Framework-Specific Syntax**: Uses the right assertion methods (expect, assert, etc.)
✅ **Project-Aware Mocking**: Mocks align with project's mocking patterns
✅ **Configuration Awareness**: Tests respect project's test configuration

### 4. **Context Information in Prompt**

The generated test prompt will include a **FULL CONTEXT VERIFICATION** section showing:

```
**FULL CONTEXT VERIFICATION:**
- Method: GitLab API
- Timestamp: 2024-01-15T10:30:00.000Z
- Repository Files Analyzed: 25
- Config Files: package.json, jest.config.js
- Test Files: src/components/__tests__/Button.test.js
- Dependencies: 15 production, 8 dev
- Testing Framework: jest
- Repository Info Available: Yes
- Test Patterns Extracted: Yes
```

## 🔧 What Full Context Includes

### **GitLab with Token (Recommended)**
- ✅ Complete repository file tree (up to 100 files)
- ✅ package.json analysis for dependencies
- ✅ Testing configuration files (jest.config.js, cypress.config.js, etc.)
- ✅ Existing test files for pattern analysis
- ✅ Project metadata (description, topics, visibility)
- ✅ Repository structure understanding

### **GitHub (Automatic)**
- ✅ Repository structure analysis
- ✅ Testing framework detection
- ✅ Imported file content (up to 5 relevant files)
- ✅ Test examples from existing test directories
- ✅ Project pattern recognition

### **Web Scraping Fallback**
- ⚠️ Limited to visible page content
- ⚠️ Basic language and import detection
- ⚠️ No deep repository analysis

## 🚨 Troubleshooting

### **Context Verification Panel Not Showing**
- Ensure Context Level is set to "Full"
- Check that you're on a supported Git hosting platform
- Verify GitLab token is configured (for GitLab)

### **Low File Count in Verification**
- Check GitLab token permissions
- Ensure repository is accessible
- Large repositories may be limited to 100 files

### **No Testing Framework Detected**
- Repository may not have testing dependencies
- package.json might not be accessible
- Consider adding testing framework to your project

### **No Test Patterns Extracted**
- Repository may not have existing test files
- Test files might not follow standard naming conventions
- This is normal for new projects without tests

## 📊 Context Level Comparison

| Feature | Minimal | Smart | Full |
|---------|---------|-------|------|
| Language Detection | ✅ | ✅ | ✅ |
| Import Analysis | ✅ | ✅ | ✅ |
| Repository Info | ❌ | ⚠️ Basic | ✅ Complete |
| Testing Framework | ❌ | ⚠️ Limited | ✅ Comprehensive |
| Dependency Analysis | ❌ | ❌ | ✅ Full |
| Test Pattern Analysis | ❌ | ❌ | ✅ Yes |
| Config File Analysis | ❌ | ❌ | ✅ Yes |
| File Count Analyzed | 1 | 1-5 | 10-100 |
| API Usage | ❌ | ⚠️ Limited | ✅ Full |

## 💡 Tips for Best Results

1. **Configure GitLab Token**: For GitLab repositories, configure your token in settings for best context
2. **Use on Repository Pages**: Navigate to actual code files, not just repository home pages
3. **Check Console**: Always verify the console logs to confirm context collection
4. **Compare Results**: Try generating tests with different context levels to see the difference
5. **File Organization**: Well-organized repositories with clear test patterns yield better results

## 🔗 Related Documentation

- [Getting Started Guide](./GETTING_STARTED.md)
- [Context Levels Example](./CONTEXT_LEVELS_EXAMPLE.md)
- [API Documentation](./API.md) 