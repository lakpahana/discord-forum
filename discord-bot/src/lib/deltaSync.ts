import { Client, ForumChannel, ThreadChannel, Collection, Message } from 'discord.js';
import { query, queryOne } from './db';
import { hashUserId } from './hash';
import { sanitizeContent, convertToHtml } from './sanitizer';
import { processImageUrls } from '../handlers/image';
import { createLogger } from './logger';

const logger = createLogger('delta-sync');

export interface DeltaSyncStats {
    threadsChecked: number;
    threadsUpdated: number;
    threadsCreated: number;
    postsCreated: number;
    postsUpdated: number;
    postsDeleted: number;
    errorsEncountered: number;
    startTime: Date;
    endTime?: Date;
    lastSyncTime?: Date;
}

export interface DeltaSyncOptions {
    guildId?: string;
    channelId?: string;
    lookbackHours?: number; // How far back to check for changes
    maxThreadsToCheck?: number;
}

// Track when the last sync occurred
let lastSyncTimestamp: Date | null = null;

export async function runDeltaSync(
    client: Client,
    options: DeltaSyncOptions = {}
): Promise<DeltaSyncStats> {
    const stats: DeltaSyncStats = {
        threadsChecked: 0,
        threadsUpdated: 0,
        threadsCreated: 0,
        postsCreated: 0,
        postsUpdated: 0,
        postsDeleted: 0,
        errorsEncountered: 0,
        startTime: new Date(),
    };

    logger.info({ options }, 'Starting delta sync');

    try {
        // Get last sync time from database or use default lookback
        const lookbackHours = options.lookbackHours || 25; // Default 25 hours for daily sync
        const checkSince = new Date(Date.now() - (lookbackHours * 60 * 60 * 1000));

        // Get stored last sync time
        const lastSync = await getLastSyncTime();
        const sinceDat = lastSync || checkSince;
        stats.lastSyncTime = sinceDat;

        logger.info({ sinceDat, lookbackHours }, 'Checking for changes since');

        if (options.channelId) {
            await processSingleChannel(client, options.channelId, sinceDat, stats, options);
        } else if (options.guildId) {
            await processGuild(client, options.guildId, sinceDat, stats, options);
        } else {
            // Process all guilds
            for (const [guildId, guild] of client.guilds.cache) {
                try {
                    await processGuild(client, guildId, sinceDat, stats, options);
                } catch (error) {
                    stats.errorsEncountered++;
                    logger.error({ error, guildId }, 'Error processing guild in delta sync');
                }
            }
        }

        // Update last sync time
        await updateLastSyncTime(stats.startTime);

        stats.endTime = new Date();
        const duration = stats.endTime.getTime() - stats.startTime.getTime();

        logger.info({
            ...stats,
            durationMs: duration,
            durationMinutes: Math.round(duration / 60000),
        }, 'Delta sync completed');

    } catch (error) {
        stats.errorsEncountered++;
        logger.error({ error, stats }, 'Delta sync failed');
        throw error;
    }

    return stats;
}

async function processGuild(
    client: Client,
    guildId: string,
    sinceDat: Date,
    stats: DeltaSyncStats,
    options: DeltaSyncOptions
): Promise<void> {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        logger.warn({ guildId }, 'Guild not found');
        return;
    }

    // Get all forum channels
    const forumChannels = guild.channels.cache.filter(
        channel => channel.type === 15 // GUILD_FORUM
    ) as Collection<string, ForumChannel>;

    logger.info({ guildId, channelCount: forumChannels.size }, 'Processing guild');

    for (const [channelId, channel] of forumChannels) {
        try {
            await processSingleChannel(client, channelId, sinceDat, stats, options);
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, channelId }, 'Error processing channel in delta sync');
        }
    }
}

async function processSingleChannel(
    client: Client,
    channelId: string,
    sinceDat: Date,
    stats: DeltaSyncStats,
    options: DeltaSyncOptions
): Promise<void> {
    const channel = client.channels.cache.get(channelId) as ForumChannel;
    if (!channel || channel.type !== 15) {
        logger.warn({ channelId }, 'Forum channel not found');
        return;
    }

    logger.info({ channelId, channelName: channel.name }, 'Processing forum channel');

    // Get threads that have been active since our check date
    const activeThreads = await channel.threads.fetchActive();
    const archivedThreads = await channel.threads.fetchArchived({
        type: 'public',
        fetchAll: false, // Don't fetch all, just recent ones
    });

    const allThreads = new Collection([
        ...activeThreads.threads.entries(),
        ...archivedThreads.threads.entries(),
    ]);

    // Filter threads that have activity since our check date
    const recentThreads = allThreads.filter(thread => {
        // Check if thread was created since our check date
        if (thread.createdAt && thread.createdAt > sinceDat) {
            return true;
        }

        // Check if thread was archived/updated since our check date
        if (thread.archiveTimestamp && new Date(thread.archiveTimestamp) > sinceDat) {
            return true;
        }

        return false;
    });

    logger.info({
        channelId,
        totalThreads: allThreads.size,
        recentThreads: recentThreads.size,
        sinceDat
    }, 'Found threads with recent activity');

    let processedCount = 0;
    for (const [threadId, thread] of recentThreads) {
        try {
            if (options.maxThreadsToCheck && processedCount >= options.maxThreadsToCheck) {
                logger.info({ limit: options.maxThreadsToCheck }, 'Reached thread processing limit');
                break;
            }

            await processThreadDelta(thread, sinceDat, stats);
            processedCount++;
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, threadId }, 'Error processing thread in delta sync');
        }
    }
}

async function processThreadDelta(
    thread: ThreadChannel,
    sinceDat: Date,
    stats: DeltaSyncStats
): Promise<void> {
    stats.threadsChecked++;

    const threadId = thread.id;
    const parentId = thread.parentId;

    if (!parentId) {
        logger.warn({ threadId }, 'Thread has no parent channel');
        return;
    }

    logger.debug({ threadId, threadName: thread.name }, 'Processing thread delta');

    // Check if thread exists in database
    const existingThread = await queryOne<{
        id: string;
        updated_at: Date;
        reply_count: number;
    }>(`
    SELECT id, updated_at, reply_count 
    FROM threads 
    WHERE id = ?
  `, [threadId]);

    const isNewThread = !existingThread;

    if (isNewThread) {
        // New thread - full sync
        await syncNewThread(thread, stats);
        stats.threadsCreated++;
    } else {
        // Existing thread - check for updates
        await syncThreadUpdates(thread, existingThread, sinceDat, stats);
    }

    logger.debug({
        threadId,
        isNewThread,
        threadsChecked: stats.threadsChecked
    }, 'Thread delta processed');
}

async function syncNewThread(
    thread: ThreadChannel,
    stats: DeltaSyncStats
): Promise<void> {
    logger.info({ threadId: thread.id }, 'Syncing new thread');

    // Get starter message
    const starterMessage = await thread.fetchStarterMessage();
    if (!starterMessage || starterMessage.author.bot) {
        logger.debug({ threadId: thread.id }, 'No starter message or bot message, skipping');
        return;
    }

    const authorAlias = hashUserId(starterMessage.author.id);
    const sanitizationResult = sanitizeContent(starterMessage.content || '');
    let htmlContent = convertToHtml(sanitizationResult.sanitizedContent);

    // Process images
    const imageUrls = starterMessage.attachments.map(att => att.url);
    if (imageUrls.length > 0) {
        try {
            const imageData = await processImageUrls(imageUrls);
            if (imageData.length > 0) {
                const imageHtml = imageData
                    .map(img => `<img src="${img.url}" width="${img.width}" height="${img.height}" alt="Image" />`)
                    .join('<br>');
                htmlContent += '<br>' + imageHtml;
            }
        } catch (error) {
            logger.warn({ error, threadId: thread.id }, 'Failed to process thread images');
        }
    }

    // Extract tags
    const tags = thread.appliedTags || [];
    const tagNames = tags.length > 0 ?
        tags.map((tagId: string) => {
            if ('availableTags' in thread.parent! && thread.parent.availableTags) {
                const tag = thread.parent.availableTags.find((t: any) => t.id === tagId);
                return tag?.name || tagId;
            }
            return tagId;
        }).filter(Boolean) : null;

    // Create slug
    const slug = thread.name.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 255);

    // Insert thread
    await query(`
    INSERT INTO threads (
      id, channel_id, slug, title, author_alias, body_html, 
      tags, reply_count, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      body_html = VALUES(body_html),
      tags = VALUES(tags),
      updated_at = VALUES(updated_at)
  `, [
        thread.id,
        thread.parentId,
        slug,
        thread.name,
        authorAlias,
        htmlContent,
        tagNames ? JSON.stringify(tagNames) : null,
        0,
        starterMessage.createdAt,
        new Date(),
    ]);

    // Sync all posts in the thread
    await syncAllThreadPosts(thread, starterMessage, stats);
}

async function syncThreadUpdates(
    thread: ThreadChannel,
    existingThread: { id: string; updated_at: Date; reply_count: number },
    sinceDat: Date,
    stats: DeltaSyncStats
): Promise<void> {
    logger.debug({ threadId: thread.id }, 'Checking thread for updates');

    // Check for new posts since last sync
    const messages = await fetchRecentMessages(thread, sinceDat);

    if (messages.size === 0) {
        logger.debug({ threadId: thread.id }, 'No new messages found');
        return;
    }

    logger.info({
        threadId: thread.id,
        newMessages: messages.size
    }, 'Found new messages in thread');

    stats.threadsUpdated++;

    // Process new/updated messages
    const sortedMessages = Array.from(messages.values())
        .filter(msg => !msg.author.bot)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    for (const message of sortedMessages) {
        try {
            await syncMessageDelta(message, sinceDat, stats);
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, messageId: message.id }, 'Error syncing message delta');
        }
    }

    // Update thread reply count
    const currentPostCount = await queryOne<{ count: number }>(`
    SELECT COUNT(*) as count FROM posts WHERE thread_id = ?
  `, [thread.id]);

    if (currentPostCount && currentPostCount.count !== existingThread.reply_count) {
        await query(`
      UPDATE threads 
      SET reply_count = ?, updated_at = ?
      WHERE id = ?
    `, [currentPostCount.count, new Date(), thread.id]);
    }
}

async function syncMessageDelta(
    message: Message,
    sinceDat: Date,
    stats: DeltaSyncStats
): Promise<void> {
    // Check if message exists in database
    const existingPost = await queryOne<{
        id: string;
        updated_at: Date;
        body_html: string;
    }>(`
    SELECT id, updated_at, body_html 
    FROM posts 
    WHERE id = ?
  `, [message.id]);

    const authorAlias = hashUserId(message.author.id);
    const sanitizationResult = sanitizeContent(message.content || '');
    let htmlContent = convertToHtml(sanitizationResult.sanitizedContent);

    // Process images
    const imageUrls = message.attachments.map(att => att.url);
    if (imageUrls.length > 0) {
        try {
            const imageData = await processImageUrls(imageUrls);
            if (imageData.length > 0) {
                const imageHtml = imageData
                    .map(img => `<img src="${img.url}" width="${img.width}" height="${img.height}" alt="Image" />`)
                    .join('<br>');
                htmlContent += '<br>' + imageHtml;
            }
        } catch (error) {
            logger.warn({ error, messageId: message.id }, 'Failed to process message images');
        }
    }

    // Get reply context
    let replyToId: string | null = null;
    let replyToAuthorAlias: string | null = null;

    if (message.reference && message.reference.messageId) {
        replyToId = message.reference.messageId;
        try {
            const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
            if (referencedMessage && referencedMessage.author) {
                replyToAuthorAlias = hashUserId(referencedMessage.author.id);
            }
        } catch (error) {
            logger.debug({ error, messageId: message.id }, 'Could not fetch referenced message');
        }
    }

    if (!existingPost) {
        // New post
        await query(`
      INSERT INTO posts (id, thread_id, author_alias, body_html, reply_to_id, reply_to_author_alias, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            message.id,
            message.channel.id,
            authorAlias,
            htmlContent,
            replyToId,
            replyToAuthorAlias,
            message.createdAt,
            message.editedAt || message.createdAt,
        ]);

        stats.postsCreated++;
        logger.debug({ messageId: message.id }, 'Created new post');

    } else if (message.editedAt && message.editedAt > sinceDat) {
        // Updated post
        if (existingPost.body_html !== htmlContent) {
            await query(`
        UPDATE posts
        SET body_html = ?, updated_at = ?
        WHERE id = ?
      `, [htmlContent, message.editedAt, message.id]);

            stats.postsUpdated++;
            logger.debug({ messageId: message.id }, 'Updated existing post');
        }
    }
}

async function syncAllThreadPosts(
    thread: ThreadChannel,
    starterMessage: Message,
    stats: DeltaSyncStats
): Promise<void> {
    const messages = await fetchAllMessages(thread);
    const sortedMessages = Array.from(messages.values())
        .filter(msg => msg.id !== starterMessage.id && !msg.author.bot)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    for (const message of sortedMessages) {
        try {
            await syncMessageDelta(message, new Date(0), stats); // Use epoch time to force sync
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, messageId: message.id }, 'Error syncing thread post');
        }
    }
}

async function fetchRecentMessages(
    thread: ThreadChannel,
    since: Date
): Promise<Collection<string, Message>> {
    const messages = new Collection<string, Message>();
    let lastId: string | undefined;

    // Fetch messages in batches, checking timestamps
    while (true) {
        const fetchOptions: any = { limit: 100 };
        if (lastId) {
            fetchOptions.before = lastId;
        }

        try {
            const fetchResult = await thread.messages.fetch(fetchOptions);

            let batch: Collection<string, Message>;
            if (fetchResult instanceof Collection) {
                batch = fetchResult;
            } else {
                batch = new Collection();
                batch.set(fetchResult.id, fetchResult);
            }

            if (batch.size === 0) {
                break;
            }

            let foundOldMessage = false;
            for (const [id, message] of batch) {
                // Check if message is newer than our since date or was edited since
                const isRecent = message.createdAt > since ||
                    (message.editedAt && message.editedAt > since);

                if (isRecent) {
                    messages.set(id, message);
                } else {
                    // If we hit a message older than our since date, we can stop
                    foundOldMessage = true;
                }
            }

            // If all messages in this batch are older than since date, stop fetching
            if (foundOldMessage && batch.every(msg => msg.createdAt <= since)) {
                break;
            }

            lastId = batch.last()?.id;

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
            logger.warn({ error, threadId: thread.id }, 'Failed to fetch recent messages batch');
            break;
        }
    }

    return messages;
}

async function fetchAllMessages(thread: ThreadChannel): Promise<Collection<string, Message>> {
    const messages = new Collection<string, Message>();
    let lastId: string | undefined;

    while (true) {
        const fetchOptions: any = { limit: 100 };
        if (lastId) {
            fetchOptions.before = lastId;
        }

        try {
            const fetchResult = await thread.messages.fetch(fetchOptions);

            let batch: Collection<string, Message>;
            if (fetchResult instanceof Collection) {
                batch = fetchResult;
            } else {
                batch = new Collection();
                batch.set(fetchResult.id, fetchResult);
            }

            if (batch.size === 0) {
                break;
            }

            for (const [id, message] of batch) {
                messages.set(id, message);
            }

            lastId = batch.last()?.id;

            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
            logger.warn({ error, threadId: thread.id }, 'Failed to fetch messages batch');
            break;
        }
    }

    return messages;
}

// Database functions for tracking sync state
async function getLastSyncTime(): Promise<Date | null> {
    try {
        const result = await queryOne<{ last_sync: Date }>(`
      SELECT last_sync FROM sync_metadata WHERE id = 'delta_sync' LIMIT 1
    `);
        return result?.last_sync || null;
    } catch (error) {
        // Table might not exist yet, create it
        await createSyncMetadataTable();
        return null;
    }
}

async function updateLastSyncTime(timestamp: Date): Promise<void> {
    try {
        await query(`
      INSERT INTO sync_metadata (id, last_sync, updated_at)
      VALUES ('delta_sync', ?, ?)
      ON DUPLICATE KEY UPDATE
        last_sync = VALUES(last_sync),
        updated_at = VALUES(updated_at)
    `, [timestamp, new Date()]);
    } catch (error) {
        logger.error({ error }, 'Failed to update last sync time');
    }
}

async function createSyncMetadataTable(): Promise<void> {
    try {
        await query(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        id VARCHAR(50) PRIMARY KEY,
        last_sync DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        INDEX idx_last_sync (last_sync)
      )
    `);
        logger.info('Created sync_metadata table');
    } catch (error) {
        logger.error({ error }, 'Failed to create sync_metadata table');
    }
}
