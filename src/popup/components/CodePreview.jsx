import React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card';
import { Button } from './ui/Button';
import { Copy, Check } from 'lucide-react';

export function CodePreview({ code, language = 'javascript' }) {
    const [copied, setCopied] = React.useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Format language label
    const formatLanguageLabel = (lang) => {
        // If it contains "tests", format it specially
        if (lang.includes('tests')) {
            return lang.toUpperCase();
        }
        return lang.toUpperCase();
    };

    return (
        <Card className="w-full overflow-hidden border-white/10 bg-[#1e1e1e]">
            <CardHeader className="flex flex-row items-center justify-between py-2 px-4 bg-white/5 border-b border-white/5">
                <CardTitle className="text-xs font-mono text-textMuted uppercase">{formatLanguageLabel(language)}</CardTitle>
                <Button variant="ghost" size="icon" onClick={handleCopy} className="h-6 w-6">
                    {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                </Button>
            </CardHeader>
            <CardContent className="p-0">
                <pre className="p-4 overflow-x-auto text-sm font-mono leading-relaxed text-gray-300 max-w-full">
                    <code className="block">{code}</code>
                </pre>
            </CardContent>
        </Card>
    );
}
