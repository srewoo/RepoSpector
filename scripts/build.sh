#!/bin/bash

# Build script for AI RepoSpector Chrome Extension

echo "🚀 Building AI RepoSpector Chrome Extension..."

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm is not installed. Please install Node.js and npm.${NC}"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Check for --skip-validation flag
SKIP_VALIDATION=false
if [[ "$1" == "--skip-validation" ]]; then
    SKIP_VALIDATION=true
fi

# Run validation unless skipped
if [ "$SKIP_VALIDATION" = false ]; then
    echo "✅ Running validation..."
    npm run validate
    if [ $? -ne 0 ]; then
        echo -e "${RED}❌ Validation failed. Please fix errors before building.${NC}"
        echo -e "${YELLOW}Tip: Use './scripts/build.sh --skip-validation' to skip validation${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}⚠️  Skipping validation...${NC}"
fi

# Clean previous build
echo "🧹 Cleaning previous build..."
rm -rf dist
rm -rf build
mkdir -p build

# Create dist directory
mkdir -p dist

# Copy manifest
echo "📄 Copying manifest..."
cp manifest.json dist/

# Copy source files
echo "📁 Copying source files..."
cp -r src dist/
cp background.js content.js popup.html styles.css dist/

# Copy assets
echo "🎨 Copying assets..."
cp -r assets dist/

# Create the zip file
echo "📦 Creating package..."
cd dist
zip -r ../build/ai-RepoSpector.zip . -x "*.DS_Store" "*/.DS_Store"
cd ..

# Calculate size
SIZE=$(du -h build/ai-RepoSpector.zip | cut -f1)

echo -e "${GREEN}✅ Build complete!${NC}"
echo -e "📦 Package created: ${GREEN}build/ai-RepoSpector.zip${NC} (${SIZE})"
echo ""
echo "To install in Chrome:"
echo "1. Open chrome://extensions/"
echo "2. Enable Developer mode"
echo "3. Click 'Load unpacked' and select the 'dist' folder"
echo ""
echo "To publish to Chrome Web Store:"
echo "1. Upload build/ai-RepoSpector.zip to the Chrome Web Store Developer Dashboard" 