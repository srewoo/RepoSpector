import React from 'react';
import { Header } from './Header';

export function Layout({ children }) {
    return (
        <div className="flex flex-col h-full w-full bg-background text-text overflow-hidden selection:bg-primary/30">
            <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/20 via-background to-background pointer-events-none" />
            <Header />
            <main className="flex-1 overflow-y-auto p-6 pb-20 relative z-10 scrollbar-hide min-h-0">
                {children}
            </main>
        </div>
    );
}
