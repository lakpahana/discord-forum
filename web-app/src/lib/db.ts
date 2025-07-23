import mysql from 'mysql2/promise';

interface DatabaseConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
}

let pool: mysql.Pool | null = null;

export function createPool(config: DatabaseConfig): mysql.Pool {
  if (pool) {
    return pool;
  }

  pool = mysql.createPool({
    host: config.host,
    port: config.port || 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    supportBigNumbers: true,
    bigNumberStrings: true
  } as mysql.PoolOptions);
  return pool;
}

export function getPool(): mysql.Pool {
  if (!pool) {
    throw new Error('Database pool not initialized. Call createPool first.');
  }
  return pool;
}

// Types for database records
export interface Channel {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  position: number;
  created_at: Date;
  thread_count?: number;
}

export interface Thread {
  id: string;
  channel_id: string;
  slug: string;
  title: string;
  author_alias: string;
  body_html: string | null;
  tags: string[] | null;
  reply_count: number;
  created_at: Date;
  updated_at: Date;
  channel_name?: string;
  channel_slug?: string;
}

export interface Post {
  id: string;
  thread_id: string;
  author_alias: string;
  body_html: string | null;
  reply_to_id: string | null;
  reply_to_author_alias: string | null;
  created_at: Date;
  updated_at: Date;
}

// Database query functions
export async function getAllChannels(): Promise<Channel[]> {
  const pool = getPool();
  const [rows] = await pool.execute(`
    SELECT 
      c.*,
      COUNT(t.id) as thread_count
    FROM channels c
    LEFT JOIN threads t ON c.id = t.channel_id
    GROUP BY c.id
    ORDER BY c.position ASC, c.name ASC
  `);

  return (rows as any[]).map(row => ({
    ...row,
    id: String(row.id),
    thread_count: parseInt(row.thread_count) || 0
  }));
}

export async function getChannelById(id: string): Promise<Channel | null> {
  const pool = getPool();
  const [rows] = await pool.execute(`
    SELECT 
      c.*,
      COUNT(t.id) as thread_count
    FROM channels c
    LEFT JOIN threads t ON c.id = t.channel_id
    WHERE c.id = ?
    GROUP BY c.id
  `, [id]);

  const result = rows as any[];
  if (result.length === 0) return null;

  const row = result[0];
  return {
    ...row,
    id: String(row.id),
    thread_count: parseInt(row.thread_count) || 0
  };
}

export async function getThreadsByChannelId(channelId: string): Promise<Thread[]> {
  const pool = getPool();

  const [rows] = await pool.execute(`
    SELECT 
      t.*,
      c.name as channel_name,
      c.slug as channel_slug
    FROM threads t
    JOIN channels c ON t.channel_id = c.id
    WHERE t.channel_id = ?
    ORDER BY t.updated_at DESC
  `, [channelId]);

  return (rows as any[]).map(row => ({
    ...row,
    id: String(row.id),
    channel_id: String(row.channel_id),
    tags: row.tags ? (() => {
      try {
        return JSON.parse(row.tags);
      } catch (e) {
        console.warn('Failed to parse tags JSON:', row.tags);
        return null;
      }
    })() : null
  }));
}

export async function getThreadById(threadId: string, channelId: string): Promise<Thread | null> {
  const pool = getPool();

  const [rows] = await pool.execute(`
    SELECT 
      t.*,
      c.name as channel_name,
      c.slug as channel_slug
    FROM threads t
    JOIN channels c ON t.channel_id = c.id
    WHERE t.id = ? AND t.channel_id = ?
  `, [threadId, channelId]);

  const result = rows as any[];
  if (result.length === 0) return null;

  const row = result[0];
  return {
    ...row,
    id: String(row.id),
    channel_id: String(row.channel_id),
    tags: row.tags ? (() => {
      try {
        return JSON.parse(row.tags);
      } catch (e) {
        console.warn('Failed to parse tags JSON:', row.tags);
        return null;
      }
    })() : null
  };
}

export async function getPostsByThreadId(threadId: string): Promise<Post[]> {
  const pool = getPool();

  const [rows] = await pool.execute(`
        SELECT *
        FROM posts
        WHERE thread_id = ?
        ORDER BY created_at ASC
    `, [threadId]);

  return (rows as any[]).map(row => ({
    ...row,
    id: String(row.id),
    thread_id: String(row.thread_id),
    reply_to_id: row.reply_to_id ? String(row.reply_to_id) : null
  }));
}

export async function getChannelBySlug(slug: string): Promise<Channel | null> {
  const pool = getPool();
  const [rows] = await pool.execute(`
        SELECT id FROM channels WHERE slug = ?
    `, [slug]);

  if ((rows as any[]).length === 0) return null;

  const channelId = (rows as any[])[0].id;
  return getChannelById(String(channelId));
}

export async function getThreadsByChannelSlug(channelSlug: string): Promise<Thread[]> {
  const pool = getPool();

  // First get channel ID by slug
  const [channelRows] = await pool.execute(`
        SELECT id FROM channels WHERE slug = ?
    `, [channelSlug]);

  if ((channelRows as any[]).length === 0) return [];

  const channelId = (channelRows as any[])[0].id;
  return getThreadsByChannelId(String(channelId));
}

export async function getThreadBySlug(channelSlug: string, threadSlug: string): Promise<Thread | null> {
  const pool = getPool();

  // First get channel ID by slug
  const [channelRows] = await pool.execute(`
        SELECT id FROM channels WHERE slug = ?
    `, [channelSlug]);

  if ((channelRows as any[]).length === 0) return null;

  const channelId = (channelRows as any[])[0].id;

  // Then get thread ID by slug within that channel
  const [threadRows] = await pool.execute(`
        SELECT id FROM threads WHERE slug = ? AND channel_id = ?
    `, [threadSlug, channelId]);

  if ((threadRows as any[]).length === 0) return null;

  const threadId = (threadRows as any[])[0].id;
  return getThreadById(String(threadId), String(channelId));
}