import React from 'react';
import { Settings, ShieldCheck } from 'lucide-react';
import { Button } from './ui/Button';

export function Header({ onSettingsClick }) {
    return (
        <header className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-surface/30 backdrop-blur-md sticky top-0 z-50">
            <div className="flex items-center space-x-2">
                <div className="p-2 rounded-lg bg-primary/10">
                    <ShieldCheck className="w-6 h-6 text-primary" />
                </div>
                <div>
                    <h1 className="text-lg font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
                        RepoSpector
                    </h1>
                    <p className="text-[10px] text-textMuted uppercase tracking-wider font-semibold">
                        Because your code deserves a safety net.
                    </p>
                </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onSettingsClick}>
                <Settings className="w-5 h-5 text-textMuted hover:text-text transition-colors" />
            </Button>
        </header>
    );
}
