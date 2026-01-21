import React, { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import {
    MessageSquare,
    Send,
    HelpCircle,
    Wrench,
    AlertCircle,
    CheckCircle,
    XCircle,
    Loader2,
    ChevronLeft,
    Copy,
    Check,
    User,
    Bot
} from 'lucide-react';
import { Card, CardHeader, CardContent } from './ui/Card';
import { Button } from './ui/Button';
import { MarkdownRenderer } from './ui/MarkdownRenderer';

const quickActions = [
    { id: 'explain', label: 'Explain', icon: HelpCircle, color: 'text-blue-500' },
    { id: 'fix', label: 'How to Fix', icon: Wrench, color: 'text-green-500' },
    { id: 'false-positive', label: 'False Positive?', icon: AlertCircle, color: 'text-yellow-500' }
];

export function FindingThread({
    thread,
    finding,
    onSendMessage,
    onQuickAction,
    onClose,
    onMarkResolved,
    onDismiss,
    sending = false,
    suggestedQuestions = []
}) {
    const [message, setMessage] = useState('');
    const [copiedId, setCopiedId] = useState(null);
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);

    const messages = thread?.messages || [];

    // Scroll to bottom when new messages arrive
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    // Focus input on mount
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleSend = () => {
        if (!message.trim() || sending) return;
        onSendMessage(message.trim());
        setMessage('');
    };

    const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleCopy = async (content, id) => {
        await navigator.clipboard.writeText(content);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const severityColors = {
        critical: 'text-red-500 bg-red-500/10',
        high: 'text-orange-500 bg-orange-500/10',
        medium: 'text-yellow-500 bg-yellow-500/10',
        low: 'text-blue-500 bg-blue-500/10'
    };

    const findingData = thread?.finding || finding;

    return (
        <Card className="flex flex-col h-full">
            {/* Header */}
            <CardHeader className="flex-shrink-0 border-b border-border p-4">
                <div className="flex items-start gap-3">
                    {onClose && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={onClose}
                            className="p-1"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </Button>
                    )}

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className={cn(
                                'px-2 py-0.5 text-xs font-medium rounded',
                                severityColors[findingData?.severity] || severityColors.medium
                            )}>
                                {findingData?.severity?.toUpperCase() || 'FINDING'}
                            </span>
                            <span className="text-xs text-textMuted">
                                {findingData?.file?.split('/').pop() || 'Unknown file'}
                                {findingData?.lineNumber ? `:${findingData.lineNumber}` : ''}
                            </span>
                            {thread?.status && thread.status !== 'active' && (
                                <span className={cn(
                                    'px-1.5 py-0.5 text-xs rounded',
                                    thread.status === 'resolved' ? 'bg-green-500/10 text-green-500' : 'bg-gray-500/10 text-gray-500'
                                )}>
                                    {thread.status}
                                </span>
                            )}
                        </div>
                        <p className="text-sm text-text mt-1 line-clamp-2">
                            {findingData?.originalText || findingData?.message || 'No description'}
                        </p>
                    </div>

                    <div className="flex items-center gap-1">
                        {onMarkResolved && thread?.status === 'active' && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={onMarkResolved}
                                className="text-green-500"
                                title="Mark as resolved"
                            >
                                <CheckCircle className="w-4 h-4" />
                            </Button>
                        )}
                        {onDismiss && thread?.status === 'active' && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={onDismiss}
                                className="text-textMuted"
                                title="Dismiss"
                            >
                                <XCircle className="w-4 h-4" />
                            </Button>
                        )}
                    </div>
                </div>
            </CardHeader>

            {/* Messages Area */}
            <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* Code snippet if available */}
                {findingData?.codeSnippet && messages.length === 0 && (
                    <div className="p-3 bg-background rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-textMuted">Code Context</span>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleCopy(findingData.codeSnippet, 'snippet')}
                                className="h-6 px-2"
                            >
                                {copiedId === 'snippet' ? (
                                    <Check className="w-3 h-3 text-green-500" />
                                ) : (
                                    <Copy className="w-3 h-3" />
                                )}
                            </Button>
                        </div>
                        <pre className="text-xs overflow-x-auto font-mono">
                            <code>{findingData.codeSnippet}</code>
                        </pre>
                    </div>
                )}

                {/* Quick Actions - show only if no messages yet */}
                {messages.length === 0 && (
                    <div className="space-y-3">
                        <span className="text-xs text-textMuted">Quick Actions</span>
                        <div className="flex flex-wrap gap-2">
                            {quickActions.map(action => (
                                <Button
                                    key={action.id}
                                    variant="outline"
                                    size="sm"
                                    onClick={() => onQuickAction(action.id)}
                                    disabled={sending}
                                    className="flex items-center gap-1.5"
                                >
                                    <action.icon className={cn('w-3.5 h-3.5', action.color)} />
                                    {action.label}
                                </Button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Messages */}
                <AnimatePresence mode="popLayout">
                    {messages.map((msg, index) => (
                        <motion.div
                            key={msg.id || index}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className={cn(
                                'flex gap-3',
                                msg.role === 'user' ? 'justify-end' : 'justify-start'
                            )}
                        >
                            {msg.role !== 'user' && (
                                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                                    <Bot className="w-4 h-4 text-primary" />
                                </div>
                            )}

                            <div className={cn(
                                'max-w-[85%] rounded-lg p-3',
                                msg.role === 'user'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'bg-surface border border-border'
                            )}>
                                {msg.role === 'user' ? (
                                    <div className="text-sm whitespace-pre-wrap">
                                        {msg.content}
                                    </div>
                                ) : (
                                    <MarkdownRenderer content={msg.content} />
                                )}

                                {msg.role !== 'user' && msg.content && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => handleCopy(msg.content, msg.id)}
                                        className="mt-2 h-6 px-2 text-xs"
                                    >
                                        {copiedId === msg.id ? (
                                            <>
                                                <Check className="w-3 h-3 mr-1 text-green-500" />
                                                Copied
                                            </>
                                        ) : (
                                            <>
                                                <Copy className="w-3 h-3 mr-1" />
                                                Copy
                                            </>
                                        )}
                                    </Button>
                                )}
                            </div>

                            {msg.role === 'user' && (
                                <div className="w-7 h-7 rounded-full bg-surface border border-border flex items-center justify-center flex-shrink-0">
                                    <User className="w-4 h-4 text-textMuted" />
                                </div>
                            )}
                        </motion.div>
                    ))}
                </AnimatePresence>

                {/* Loading indicator */}
                {sending && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="flex gap-3"
                    >
                        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
                            <Bot className="w-4 h-4 text-primary" />
                        </div>
                        <div className="bg-surface border border-border rounded-lg p-3">
                            <div className="flex items-center gap-2 text-sm text-textMuted">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Thinking...
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* Suggested questions - show after first response */}
                {messages.length > 0 && messages.length < 4 && suggestedQuestions.length > 0 && !sending && (
                    <div className="pt-2">
                        <span className="text-xs text-textMuted">Suggested Questions</span>
                        <div className="flex flex-wrap gap-2 mt-2">
                            {suggestedQuestions.slice(0, 3).map((q, i) => (
                                <button
                                    key={i}
                                    onClick={() => {
                                        setMessage(q);
                                        inputRef.current?.focus();
                                    }}
                                    className="text-xs px-2 py-1 rounded-full bg-surface border border-border hover:bg-surface/80 transition-colors text-left"
                                >
                                    {q}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </CardContent>

            {/* Input Area */}
            {thread?.status === 'active' && (
                <div className="flex-shrink-0 border-t border-border p-4">
                    <div className="flex gap-2">
                        <textarea
                            ref={inputRef}
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            onKeyPress={handleKeyPress}
                            placeholder="Ask a question about this finding..."
                            disabled={sending}
                            rows={1}
                            className="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                            style={{ minHeight: '40px', maxHeight: '120px' }}
                        />
                        <Button
                            onClick={handleSend}
                            disabled={!message.trim() || sending}
                            className="px-3"
                        >
                            {sending ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Send className="w-4 h-4" />
                            )}
                        </Button>
                    </div>

                    {/* Quick actions in input area */}
                    {messages.length > 0 && (
                        <div className="flex gap-2 mt-2">
                            {quickActions.map(action => (
                                <button
                                    key={action.id}
                                    onClick={() => onQuickAction(action.id)}
                                    disabled={sending}
                                    className="text-xs px-2 py-1 rounded bg-surface border border-border hover:bg-surface/80 transition-colors flex items-center gap-1 disabled:opacity-50"
                                >
                                    <action.icon className={cn('w-3 h-3', action.color)} />
                                    {action.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Resolved/Dismissed state */}
            {thread?.status && thread.status !== 'active' && (
                <div className={cn(
                    'flex-shrink-0 p-4 text-center text-sm',
                    thread.status === 'resolved' ? 'bg-green-500/10 text-green-500' : 'bg-gray-500/10 text-textMuted'
                )}>
                    {thread.status === 'resolved' ? (
                        <>
                            <CheckCircle className="w-4 h-4 inline mr-1" />
                            This finding has been resolved
                        </>
                    ) : (
                        <>
                            <XCircle className="w-4 h-4 inline mr-1" />
                            This finding has been dismissed
                        </>
                    )}
                </div>
            )}
        </Card>
    );
}

export default FindingThread;
