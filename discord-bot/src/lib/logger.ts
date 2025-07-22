import pino from 'pino';

export function createLogger(name: string) {
    const isDevelopment = process.env.NODE_ENV === 'development';

    const logger = pino({
        name,
        level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
        formatters: {
            level: (label) => {
                return { level: label };
            },
            bindings: (bindings) => {
                return {
                    pid: bindings.pid,
                    hostname: bindings.hostname,
                    name: bindings.name,
                };
            },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        ...(isDevelopment && {
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    ignore: 'pid,hostname',
                    translateTime: 'SYS:standard',
                },
            },
        }),
    });

    return logger;
}

export type Logger = ReturnType<typeof createLogger>;
