import React from 'react';
import { Home, Database, MessageSquare, Settings } from 'lucide-react';
import { motion } from 'framer-motion';

const tabs = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'repos', label: 'Repos', icon: Database },
    { id: 'chat', label: 'Chat', icon: MessageSquare },
    { id: 'settings', label: 'Settings', icon: Settings }
];

export function TabNavigation({ activeTab, onTabChange, repoCount = 0 }) {
    return (
        <nav className="fixed bottom-0 left-0 right-0 bg-surface/95 backdrop-blur-md border-t border-border z-50">
            <div className="flex items-center justify-around h-14 px-2">
                {tabs.map((tab) => {
                    const Icon = tab.icon;
                    const isActive = activeTab === tab.id;
                    const showBadge = tab.id === 'repos' && repoCount > 0;

                    return (
                        <button
                            key={tab.id}
                            onClick={() => onTabChange(tab.id)}
                            className={`relative flex flex-col items-center justify-center flex-1 h-full transition-colors ${
                                isActive
                                    ? 'text-primary'
                                    : 'text-textMuted hover:text-text'
                            }`}
                        >
                            <div className="relative">
                                <Icon className="w-5 h-5" />
                                {showBadge && (
                                    <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-primary text-white text-[10px] font-medium rounded-full flex items-center justify-center">
                                        {repoCount > 9 ? '9+' : repoCount}
                                    </span>
                                )}
                            </div>
                            <span className="text-[10px] mt-1 font-medium">
                                {tab.label}
                            </span>
                            {isActive && (
                                <motion.div
                                    layoutId="activeTab"
                                    className="absolute top-0 inset-x-0 mx-auto w-8 h-0.5 bg-gradient-to-r from-primary to-secondary rounded-full"
                                    initial={false}
                                    transition={{
                                        type: 'spring',
                                        stiffness: 500,
                                        damping: 30
                                    }}
                                />
                            )}
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}
