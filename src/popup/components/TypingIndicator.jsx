import React from 'react';
import { motion } from 'framer-motion';

export function TypingIndicator() {
    const dotVariants = {
        initial: { y: 0 },
        animate: { y: [-3, 0, -3] }
    };

    return (
        <div className="flex items-center gap-1 px-4 py-3 bg-surface/50 rounded-xl rounded-tl-none max-w-[80px]">
            {[0, 1, 2].map((index) => (
                <motion.div
                    key={index}
                    className="w-2 h-2 bg-primary/60 rounded-full"
                    variants={dotVariants}
                    initial="initial"
                    animate="animate"
                    transition={{
                        duration: 0.6,
                        repeat: Infinity,
                        delay: index * 0.15,
                        ease: 'easeInOut'
                    }}
                />
            ))}
        </div>
    );
}
