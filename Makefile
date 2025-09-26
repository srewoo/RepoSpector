# Makefile for AI RepoSpector Chrome Extension

.PHONY: help setup test test-watch test-coverage lint lint-fix build clean package dev install

# Default target
help:
	@echo "AI RepoSpector - Available commands:"
	@echo "  make setup       - Initial development setup"
	@echo "  make install     - Install dependencies"
	@echo "  make test        - Run all tests"
	@echo "  make test-watch  - Run tests in watch mode"
	@echo "  make test-coverage - Run tests with coverage"
	@echo "  make lint        - Check code style"
	@echo "  make lint-fix    - Fix code style issues"
	@echo "  make build       - Build the extension"
	@echo "  make package     - Create distributable package"
	@echo "  make clean       - Clean build artifacts"
	@echo "  make dev         - Start development mode"

# Development setup
setup:
	@./scripts/dev-setup.sh

# Install dependencies
install:
	npm install

# Testing
test:
	npm test

test-watch:
	npm run test:watch

test-coverage:
	npm run test:coverage

# Linting
lint:
	npm run lint

lint-fix:
	npm run lint:fix

# Building
build:
	npm run build

clean:
	npm run clean
	rm -rf build

package: clean
	npm run package

# Development
dev:
	@echo "Loading extension in development mode..."
	@echo "1. Open chrome://extensions/"
	@echo "2. Enable Developer mode"
	@echo "3. Click 'Load unpacked' and select: $(PWD)"
	@echo ""
	@echo "Watching for changes..."
	@echo "Refresh the extension in Chrome after making changes" 