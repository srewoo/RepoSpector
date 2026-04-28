import React from 'react';

export function TypingIndicator() {
    return (
        <div className="flex items-center gap-1 px-4 py-3 bg-surface/50 rounded-xl rounded-tl-none max-w-[80px]">
            {[0, 1, 2].map((index) => (
                <span
                    key={index}
                    className="w-2 h-2 bg-primary/60 rounded-full inline-block animate-bounce"
                    style={{ animationDelay: `${index * 0.15}s`, animationDuration: '0.6s' }}
                />
            ))}
        </div>
    );
}
