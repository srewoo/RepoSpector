import { useEffect, useCallback } from 'react';

/**
 * Hook for handling keyboard shortcuts
 *
 * @param {Object} shortcuts - Object mapping shortcut keys to handlers
 * @param {boolean} enabled - Whether shortcuts are enabled
 *
 * Example usage:
 * useKeyboardShortcuts({
 *   'ctrl+enter': handleSubmit,
 *   'ctrl+k': focusInput,
 *   'escape': handleClose,
 *   'ctrl+1': () => switchTab('home'),
 * });
 */
export function useKeyboardShortcuts(shortcuts, enabled = true) {
    const handleKeyDown = useCallback((event) => {
        if (!enabled) return;

        // Build the key combination string
        const keys = [];
        if (event.ctrlKey || event.metaKey) keys.push('ctrl');
        if (event.altKey) keys.push('alt');
        if (event.shiftKey) keys.push('shift');

        // Normalize key
        let key = event.key.toLowerCase();
        if (key === 'escape') key = 'escape';
        else if (key === 'enter') key = 'enter';
        else if (key === 'arrowup') key = 'up';
        else if (key === 'arrowdown') key = 'down';
        else if (key === 'arrowleft') key = 'left';
        else if (key === 'arrowright') key = 'right';
        else if (key === ' ') key = 'space';

        keys.push(key);
        const combination = keys.join('+');

        // Check if we have a handler for this combination
        const handler = shortcuts[combination];
        if (handler && typeof handler === 'function') {
            event.preventDefault();
            handler(event);
        }
    }, [shortcuts, enabled]);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);
}

/**
 * Common keyboard shortcuts for the extension
 */
export const KEYBOARD_SHORTCUTS = {
    SEND_MESSAGE: 'ctrl+enter',
    FOCUS_INPUT: 'ctrl+k',
    CLOSE: 'escape',
    TAB_HOME: 'ctrl+1',
    TAB_REPOS: 'ctrl+2',
    TAB_CHAT: 'ctrl+3',
    TAB_SETTINGS: 'ctrl+4',
    COPY_LAST: 'ctrl+shift+c'
};

/**
 * Hook for tab navigation shortcuts
 */
export function useTabShortcuts(onTabChange) {
    const shortcuts = {
        [KEYBOARD_SHORTCUTS.TAB_HOME]: () => onTabChange('home'),
        [KEYBOARD_SHORTCUTS.TAB_REPOS]: () => onTabChange('repos'),
        [KEYBOARD_SHORTCUTS.TAB_CHAT]: () => onTabChange('chat'),
        [KEYBOARD_SHORTCUTS.TAB_SETTINGS]: () => onTabChange('settings'),
    };

    useKeyboardShortcuts(shortcuts);
}

/**
 * Render keyboard shortcut as display text
 */
export function formatShortcut(shortcut) {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    return shortcut
        .split('+')
        .map(key => {
            if (key === 'ctrl') return isMac ? '⌘' : 'Ctrl';
            if (key === 'alt') return isMac ? '⌥' : 'Alt';
            if (key === 'shift') return isMac ? '⇧' : 'Shift';
            if (key === 'enter') return '↵';
            if (key === 'escape') return 'Esc';
            return key.toUpperCase();
        })
        .join(isMac ? '' : '+');
}
