module.exports = {
    // Test environment
    testEnvironment: 'jsdom',
    
    // Setup files
    setupFilesAfterEnv: ['<rootDir>/setup.js'],
    
    // Module paths
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@utils/(.*)$': '<rootDir>/src/utils/$1',
        '^@background/(.*)$': '<rootDir>/src/background/$1',
        '^@content/(.*)$': '<rootDir>/src/content/$1',
        '^@popup/(.*)$': '<rootDir>/src/popup/$1'
    },
    
    // Transform files
    transform: {
        '^.+\\.js$': 'babel-jest'
    },
    
    // Test match patterns
    testMatch: [
        '<rootDir>/**/*.test.js'
    ],
    
    // Coverage configuration
    collectCoverage: true,
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/**/*.test.js',
        '!**/node_modules/**'
    ],
    coverageDirectory: '<rootDir>/test/coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    
    // Coverage thresholds
    coverageThreshold: {
        global: {
            branches: 80,
            functions: 80,
            lines: 85,
            statements: 85
        }
    },
    
    // Ignore patterns
    testPathIgnorePatterns: [
        '/node_modules/',
        '/dist/',
        '/build/'
    ],
    
    // Module file extensions
    moduleFileExtensions: ['js', 'json'],
    
    // Verbose output
    verbose: true,
    
    // Test timeout
    testTimeout: 10000,
    
    // Clear mocks between tests
    clearMocks: true,
    resetMocks: true,
    restoreMocks: true
}; 