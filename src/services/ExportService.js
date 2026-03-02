/**
 * Export Service for RepoSpector
 *
 * Handles exporting chat conversations and diagrams
 * in various formats (Markdown, PNG).
 */

export class ExportService {
    /**
     * Export chat messages as Markdown
     * @param {Array} messages - Chat messages array
     * @param {Object} options - { repoId, includeTimestamps }
     * @returns {string} Markdown content
     */
    static exportChatAsMarkdown(messages, options = {}) {
        const { repoId = 'unknown', includeTimestamps = true } = options;
        const now = new Date().toISOString().split('T')[0];

        let md = `# RepoSpector Chat Export\n`;
        md += `**Repository**: ${repoId}\n`;
        md += `**Date**: ${now}\n\n---\n\n`;

        for (const msg of messages) {
            if (msg.type === 'welcome') continue;

            const role = msg.role === 'user' ? 'You' : 'RepoSpector';
            const icon = msg.role === 'user' ? '👤' : '🤖';

            if (includeTimestamps && msg.id > 1) {
                const time = new Date(msg.id).toLocaleTimeString();
                md += `*${time}*\n\n`;
            }

            md += `### ${icon} ${role}\n\n`;

            if (msg.content) {
                md += `${msg.content}\n\n`;
            }

            if (msg.code) {
                md += '```\n' + msg.code + '\n```\n\n';
            }

            if (msg.mermaidCode) {
                md += '```mermaid\n' + msg.mermaidCode + '\n```\n\n';
            }

            if (msg.repoInfoMarkdown) {
                md += msg.repoInfoMarkdown + '\n\n';
            }

            md += '---\n\n';
        }

        md += `\n*Exported by RepoSpector*\n`;
        return md;
    }

    /**
     * Export a Mermaid diagram as PNG via SVG screenshot
     * @param {string} svgSelector - CSS selector for the SVG element
     * @returns {Promise<Blob>} PNG blob
     */
    static async exportDiagramAsPNG(svgElement) {
        if (!svgElement) throw new Error('No SVG element provided');

        const svgData = new XMLSerializer().serializeToString(svgElement);
        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const scale = 2; // 2x for retina
                canvas.width = img.width * scale;
                canvas.height = img.height * scale;
                const ctx = canvas.getContext('2d');
                ctx.scale(scale, scale);
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, img.width, img.height);
                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(url);

                canvas.toBlob(blob => {
                    if (blob) resolve(blob);
                    else reject(new Error('Failed to create PNG blob'));
                }, 'image/png');
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to load SVG for PNG conversion'));
            };
            img.src = url;
        });
    }

    /**
     * Trigger a file download in the browser
     * @param {string|Blob} content - File content or blob
     * @param {string} filename - Download filename
     * @param {string} mimeType - MIME type (if content is string)
     */
    static download(content, filename, mimeType = 'text/markdown') {
        let blob;
        if (content instanceof Blob) {
            blob = content;
        } else {
            blob = new Blob([content], { type: mimeType });
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }
}
