import React from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import { createPortal } from 'react-dom';

export function Modal({ isOpen, onClose, title, children, footer }) {
    if (!isOpen) return null;

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
            <div className="w-full max-w-md bg-surface border border-white/10 rounded-xl shadow-2xl m-4 animate-scale-in">
                <div className="flex items-center justify-between p-4 border-b border-white/5">
                    <h3 className="text-lg font-semibold text-text">{title}</h3>
                    <button
                        onClick={onClose}
                        className="p-1 rounded-lg hover:bg-white/5 text-textMuted hover:text-text transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>
                
                <div className="p-4">
                    {children}
                </div>

                {footer && (
                    <div className="flex justify-end gap-2 p-4 border-t border-white/5 bg-surfaceHighlight/30 rounded-b-xl">
                        {footer}
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
}
