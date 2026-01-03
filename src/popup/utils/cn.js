/**
 * Utility function to merge class names
 * Simple implementation without external dependencies
 */
export function cn(...classes) {
    return classes
        .flat()
        .filter(Boolean)
        .join(' ');
}
