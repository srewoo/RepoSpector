#!/bin/bash

# Developer setup script for AI RepoSpector

echo "🚀 Setting up AI RepoSpector development environment..."

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Check Node.js
echo "Checking Node.js..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓ Node.js ${NODE_VERSION} installed${NC}"
else
    echo -e "${RED}✗ Node.js not found${NC}"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Check npm
echo "Checking npm..."
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    echo -e "${GREEN}✓ npm ${NPM_VERSION} installed${NC}"
else
    echo -e "${RED}✗ npm not found${NC}"
    exit 1
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Create necessary directories
echo ""
echo "Creating directories..."
mkdir -p test
mkdir -p scripts
mkdir -p docs

# Make scripts executable
echo "Making scripts executable..."
chmod +x scripts/*.sh 2>/dev/null || true

# Run initial tests
echo ""
echo "Running initial tests..."
npm test -- --passWithNoTests

# Success message
echo ""
echo -e "${GREEN}✅ Development environment setup complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Get your OpenAI API key from https://platform.openai.com/api-keys"
echo "2. Load the extension in Chrome:"
echo "   - Open chrome://extensions/"
echo "   - Enable Developer mode"
echo "   - Click 'Load unpacked' and select this directory"
echo "3. Click the extension icon and add your API key in settings"
echo ""
echo "Available commands:"
echo -e "${YELLOW}npm test${NC}          - Run tests"
echo -e "${YELLOW}npm run test:watch${NC} - Run tests in watch mode"
echo -e "${YELLOW}npm run lint${NC}       - Check code style"
echo -e "${YELLOW}npm run build${NC}      - Build for production"
echo -e "${YELLOW}npm run package${NC}    - Create distributable package"
echo ""
echo "Happy coding! 🎉" 