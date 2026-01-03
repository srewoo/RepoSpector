/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./src/**/*.{js,jsx,ts,tsx,html}",
    ],
    theme: {
        extend: {
            colors: {
                // CSS variable-based colors for theme switching
                background: 'var(--color-background)',
                surface: 'var(--color-surface)',
                surfaceHighlight: 'var(--color-surfaceHighlight)',
                primary: 'var(--color-primary)',
                primaryHover: 'var(--color-primaryHover)',
                secondary: 'var(--color-secondary)',
                accent: 'var(--color-accent)',
                text: 'var(--color-text)',
                textMuted: 'var(--color-textMuted)',
                border: 'var(--color-border)',
                success: 'var(--color-success)',
                error: 'var(--color-error)',
                warning: 'var(--color-warning)',
            },
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
            },
            animation: {
                'fade-in': 'fadeIn 0.3s ease-in-out',
                'slide-up': 'slideUp 0.3s ease-out',
                'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                'bounce-subtle': 'bounceSubtle 0.6s ease-in-out',
            },
            keyframes: {
                fadeIn: {
                    '0%': { opacity: '0' },
                    '100%': { opacity: '1' },
                },
                slideUp: {
                    '0%': { transform: 'translateY(10px)', opacity: '0' },
                    '100%': { transform: 'translateY(0)', opacity: '1' },
                },
                bounceSubtle: {
                    '0%, 100%': { transform: 'translateY(0)' },
                    '50%': { transform: 'translateY(-3px)' },
                },
            },
        },
    },
    plugins: [],
}
