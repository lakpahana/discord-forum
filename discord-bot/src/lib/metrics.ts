import { register, Counter, Histogram, Gauge } from 'prom-client';
import { createLogger } from './logger';

const logger = createLogger('metrics');

// Discord event metrics
export const discordEventsTotal = new Counter({
    name: 'discord_events_total',
    help: 'Total number of Discord events processed',
    labelNames: ['event_type', 'status'],
});

// Smart sync metrics
export const smartSyncTotal = new Counter({
    name: 'smart_sync_total',
    help: 'Total number of smart sync operations',
    labelNames: ['type'], // 'full' or 'delta'
});

// Database metrics
export const dbLatencyMs = new Histogram({
    name: 'db_latency_ms',
    help: 'Database query latency in milliseconds',
    labelNames: ['query_type'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

export const dbConnectionsActive = new Gauge({
    name: 'db_connections_active',
    help: 'Number of active database connections',
});

// Image processing metrics
export const imageProcessedTotal = new Counter({
    name: 'image_processed_total',
    help: 'Total number of images processed',
    labelNames: ['status'],
});

export const imageProcessingDuration = new Histogram({
    name: 'image_processing_duration_ms',
    help: 'Image processing duration in milliseconds',
    buckets: [100, 500, 1000, 2000, 5000, 10000],
});

export const imageSizeBytes = new Histogram({
    name: 'image_size_bytes',
    help: 'Processed image size distribution in bytes',
    labelNames: ['type'],
    buckets: [1024, 10240, 51200, 102400, 512000, 1048576, 5242880],
});

// HTTP request metrics
export const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
});

export const httpRequestDuration = new Histogram({
    name: 'http_request_duration_ms',
    help: 'HTTP request duration in milliseconds',
    labelNames: ['method', 'route'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
});

// Application metrics
export const applicationInfo = new Gauge({
    name: 'application_info',
    help: 'Application information',
    labelNames: ['version', 'node_version', 'environment'],
});

export const processUptime = new Gauge({
    name: 'process_uptime_seconds',
    help: 'Process uptime in seconds',
});

// Content processing metrics
export const contentSanitized = new Counter({
    name: 'content_sanitized_total',
    help: 'Total content pieces sanitized',
    labelNames: ['type', 'had_pii', 'had_mentions'],
});

export function initializeMetrics(): void {
    // Set application info
    applicationInfo.set(
        {
            version: process.env.npm_package_version || '1.0.0',
            node_version: process.version,
            environment: process.env.NODE_ENV || 'development',
        },
        1
    );

    // Update process uptime every 30 seconds
    setInterval(() => {
        processUptime.set(process.uptime());
    }, 30000);

    logger.info('Metrics initialized');
}

// Utility functions for measuring operations
export function measureDbQuery<T>(
    queryType: string,
    operation: () => Promise<T>
): Promise<T> {
    const end = dbLatencyMs.startTimer({ query_type: queryType });
    return operation()
        .then(result => {
            end();
            return result;
        })
        .catch(error => {
            end();
            throw error;
        });
}

export function measureImageProcessing<T>(
    operation: () => Promise<T>
): Promise<T> {
    const end = imageProcessingDuration.startTimer();
    return operation()
        .then(result => {
            end();
            imageProcessedTotal.inc({ status: 'success' });
            return result;
        })
        .catch(error => {
            end();
            imageProcessedTotal.inc({ status: 'error' });
            throw error;
        });
}

export function recordDiscordEvent(eventType: string, status: 'success' | 'error'): void {
    discordEventsTotal.inc({ event_type: eventType, status });
}

export function recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    duration: number
): void {
    httpRequestsTotal.inc({ method, route, status_code: statusCode.toString() });
    httpRequestDuration.observe({ method, route }, duration);
}

export function recordImageSize(type: 'original' | 'processed', sizeBytes: number): void {
    imageSizeBytes.observe({ type }, sizeBytes);
}

export { register };
