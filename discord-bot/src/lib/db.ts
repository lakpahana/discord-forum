import mysql from 'mysql2/promise';
import { createLogger } from './logger';

const logger = createLogger('database');

let pool: mysql.Pool;

export async function initializeDatabase(): Promise<void> {
    const config: mysql.PoolOptions = {
        host: process.env.MYSQL_HOST || 'localhost',
        port: parseInt(process.env.MYSQL_PORT || '3306'),
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE || 'forum',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        charset: 'utf8mb4',
        timezone: 'Z',
    }; pool = mysql.createPool(config);

    // Test connection
    try {
        const connection = await pool.getConnection();
        await connection.ping();
        connection.release();
        logger.info('Database connection established');
    } catch (error) {
        logger.error({ error }, 'Failed to connect to database');
        throw error;
    }
}

export function getPool(): mysql.Pool {
    if (!pool) {
        throw new Error('Database not initialized. Call initializeDatabase() first.');
    }
    return pool;
}

export async function healthCheck(): Promise<boolean> {
    try {
        const connection = await pool.getConnection();
        await connection.ping();
        connection.release();
        return true;
    } catch (error) {
        logger.error({ error }, 'Database health check failed');
        return false;
    }
}

// Database query helpers
export async function query<T>(sql: string, values?: unknown[]): Promise<T[]> {
    const start = Date.now();
    try {
        const [rows] = await pool.execute(sql, values);
        const duration = Date.now() - start;
        // logger.debug({ sql, duration }, 'Database query executed');
        return rows as T[];
    } catch (error) {
        // logger.error({ error, sql }, 'Database query failed');
        throw error;
    }
}

export async function queryOne<T>(sql: string, values?: unknown[]): Promise<T | null> {
    const results = await query<T>(sql, values);
    return results[0] || null;
}

export async function transaction<T>(
    callback: (connection: mysql.PoolConnection) => Promise<T>
): Promise<T> {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

// Database models
export interface Channel {
    id: bigint;
    slug: string;
    name: string;
    description: string | null;
    position: number;
    created_at: Date;
}

export interface Thread {
    id: bigint;
    channel_id: bigint;
    slug: string;
    title: string;
    author_alias: string;
    body_html: string | null;
    tags: string[] | null;
    reply_count: number;
    created_at: Date;
    updated_at: Date;
}

export interface Post {
    id: bigint;
    thread_id: bigint;
    author_alias: string;
    body_html: string | null;
    reply_to_id: bigint | null;
    reply_to_author_alias: string | null;
    created_at: Date;
    updated_at: Date;
}export interface StaffRole {
    discord_user_id_hash: string;
    public_tag: string;
    added_by: string;
    added_at: Date;
}

export interface AuditLog {
    id: bigint;
    actor: string;
    action: 'INSERT' | 'UPDATE' | 'DELETE';
    table_name: string;
    old_val: Record<string, unknown> | null;
    new_val: Record<string, unknown> | null;
    ts: Date;
}

export interface ModerationQueue {
    id: bigint;
    content_type: 'thread' | 'post';
    content_id: bigint;
    status: 'pending' | 'approved' | 'rejected';
    reason: string | null;
    flagged_at: Date;
    reviewed_at: Date | null;
    reviewed_by: string | null;
}
