/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./src/**/*.{js,jsx,ts,tsx,html}",
    ],
    theme: {
        extend: {
            colors: {
                background: '#0f172a', // Slate 900
                surface: '#1e293b',    // Slate 800
                surfaceHighlight: '#334155', // Slate 700
                primary: '#6366f1',    // Indigo 500
                primaryHover: '#4f46e5', // Indigo 600
                secondary: '#a855f7',  // Purple 500
                accent: '#ec4899',     // Pink 500
                text: '#f8fafc',       // Slate 50
                textMuted: '#94a3b8',  // Slate 400
                border: '#334155',     // Slate 700
                success: '#22c55e',    // Green 500
                error: '#ef4444',      // Red 500
                warning: '#f59e0b',    // Amber 500
            },
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
            },
            animation: {
                'fade-in': 'fadeIn 0.3s ease-in-out',
                'slide-up': 'slideUp 0.3s ease-out',
                'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
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
            },
        },
    },
    plugins: [],
}
