import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext(undefined);

export function ThemeProvider({ children }) {
    const [theme, setTheme] = useState('dark');
    const [isLoading, setIsLoading] = useState(true);

    // Load theme preference from chrome.storage on mount
    useEffect(() => {
        const loadTheme = async () => {
            try {
                const result = await chrome.storage.local.get(['theme']);
                if (result.theme) {
                    setTheme(result.theme);
                }
            } catch (error) {
                console.error('Failed to load theme preference:', error);
            } finally {
                setIsLoading(false);
            }
        };

        loadTheme();
    }, []);

    // Apply theme to document and persist to storage
    useEffect(() => {
        if (!isLoading) {
            document.documentElement.setAttribute('data-theme', theme);
            chrome.storage.local.set({ theme }).catch(console.error);
        }
    }, [theme, isLoading]);

    const toggleTheme = () => {
        setTheme(prev => prev === 'dark' ? 'light' : 'dark');
    };

    const setThemeMode = (mode) => {
        if (mode === 'dark' || mode === 'light') {
            setTheme(mode);
        }
    };

    const value = {
        theme,
        isDark: theme === 'dark',
        isLight: theme === 'light',
        toggleTheme,
        setTheme: setThemeMode,
        isLoading
    };

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
}

export { ThemeContext };
