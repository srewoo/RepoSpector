import pino from 'pino';
import { config } from '../config.js';

const isDev = config.NODE_ENV === 'development';

export const logger = pino({
    level: isDev ? 'debug' : 'info',
    transport: isDev ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
    base: { service: 'aegis' },
    redact: {
        paths: ['req.headers.authorization', 'apiKey', '*.apiKey', '*.token', '*.password'],
        censor: '[REDACTED]',
    },
});
