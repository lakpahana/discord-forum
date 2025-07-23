import { Client, ForumChannel, ThreadChannel, Collection, Message, Guild, ChannelType } from 'discord.js';
import { query } from './db';
import { hashUserId } from './hash';
import { sanitizeContent, convertToHtml } from './sanitizer';
import { processImageUrls } from '../handlers/image';
import { getStaffTag } from './staffLoader';
import { createLogger } from './logger';
import { smartSyncTotal } from './metrics';

const logger = createLogger('smartSync');

export interface SmartSyncOptions {
    forceFull?: boolean;
}

interface SyncState {
    last_sync: string;
    is_first_run: number;
}

interface SyncStats {
    mode: 'full' | 'delta';
    guildsProcessed: number;
    channelsProcessed: number;
    threadsProcessed: number;
    postsProcessed: number;
    errorsEncountered: number;
    startTime: Date;
    endTime?: Date;
    durationMs?: number;
}

export async function smartSync(
    client: Client,
    options: SmartSyncOptions = {}
): Promise<void> {
    const stats: SyncStats = {
        mode: 'full', // Will be determined below
        guildsProcessed: 0,
        channelsProcessed: 0,
        threadsProcessed: 0,
        postsProcessed: 0,
        errorsEncountered: 0,
        startTime: new Date(),
    };

    logger.info({ options }, 'Starting smart sync');

    try {
        // Get current sync state
        const syncState = await getSyncState();

        // Determine sync mode
        if (options.forceFull || syncState.is_first_run === 1) {
            stats.mode = 'full';
            logger.info({ syncState, forceFull: options.forceFull }, 'Running full historical sync');
            await runFullSync(client, stats);
        } else {
            stats.mode = 'delta';
            const lastSyncDate = new Date(syncState.last_sync);
            logger.info({ lastSync: lastSyncDate }, 'Running delta sync since last sync');
            await runDeltaSync(client, stats, lastSyncDate);
        }

        // Update sync state
        await updateSyncState();

        stats.endTime = new Date();
        stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();

        // Update metrics
        smartSyncTotal.inc({ type: stats.mode });

        logger.info({
            mode: stats.mode,
            guildsProcessed: stats.guildsProcessed,
            channelsProcessed: stats.channelsProcessed,
            threadsProcessed: stats.threadsProcessed,
            postsProcessed: stats.postsProcessed,
            errorsEncountered: stats.errorsEncountered,
            durationMs: stats.durationMs,
        }, 'Smart sync completed');

    } catch (error) {
        stats.errorsEncountered++;
        logger.error({ error, stats }, 'Smart sync failed');
        throw error;
    }
}

async function getSyncState(): Promise<SyncState> {
    try {
        const result = await query<{ value: string }>(`
            SELECT value FROM config WHERE key_name = 'sync_state'
        `);

        if (result.length === 0 || !result[0]) {
            throw new Error('Sync state not found in config table');
        }

        return JSON.parse(result[0].value);
    } catch (error) {
        logger.error({ error }, 'Failed to get sync state, assuming first run');
        return {
            last_sync: '1970-01-01T00:00:00.000Z',
            is_first_run: 1
        };
    }
}

async function updateSyncState(): Promise<void> {
    const newState: SyncState = {
        last_sync: new Date().toISOString(),
        is_first_run: 0
    };

    await query(`
        UPDATE config 
        SET value = ?, updated_at = NOW()
        WHERE key_name = 'sync_state'
    `, [JSON.stringify(newState)]);

    logger.debug({ newState }, 'Updated sync state');
}

async function runFullSync(client: Client, stats: SyncStats): Promise<void> {
    const guilds = client.guilds.cache;
    logger.info(`Found ${guilds.size} guilds for full sync`);

    for (const [guildId, guild] of guilds) {
        try {
            logger.info({ guildId, guildName: guild.name }, 'Processing guild for full sync');
            await syncGuildFull(guild, stats);
            stats.guildsProcessed++;
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, guildId, guildName: guild.name }, 'Error during full sync of guild');
        }
    }
}

async function runDeltaSync(client: Client, stats: SyncStats, lastSyncDate: Date): Promise<void> {
    const guilds = client.guilds.cache;
    logger.info(`Found ${guilds.size} guilds for delta sync since ${lastSyncDate.toISOString()}`);

    for (const [guildId, guild] of guilds) {
        try {
            logger.info({ guildId, guildName: guild.name }, 'Processing guild for delta sync');
            await syncGuildDelta(guild, stats, lastSyncDate);
            stats.guildsProcessed++;
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, guildId, guildName: guild.name }, 'Error during delta sync of guild');
        }
    }
}

async function syncGuildFull(guild: Guild, stats: SyncStats): Promise<void> {
    const channels = guild.channels.cache.filter(channel =>
        channel.type === ChannelType.GuildForum
    );

    logger.info({ guildId: guild.id, forumChannels: channels.size }, 'Found forum channels for full sync');

    for (const [channelId, channel] of channels) {
        try {
            await upsertChannel(channel as ForumChannel);
            await syncChannelThreadsFull(channel as ForumChannel, stats);
            stats.channelsProcessed++;
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, channelId, channelName: channel.name }, 'Error during full sync of channel');
        }
    }
}

async function syncGuildDelta(guild: Guild, stats: SyncStats, lastSyncDate: Date): Promise<void> {
    const channels = guild.channels.cache.filter(channel =>
        channel.type === ChannelType.GuildForum
    );

    logger.info({ guildId: guild.id, forumChannels: channels.size }, 'Found forum channels for delta sync');

    for (const [channelId, channel] of channels) {
        try {
            await upsertChannel(channel as ForumChannel);
            await syncChannelThreadsDelta(channel as ForumChannel, stats, lastSyncDate);
            stats.channelsProcessed++;
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, channelId, channelName: channel.name }, 'Error during delta sync of channel');
        }
    }
}

async function syncChannelThreadsFull(channel: ForumChannel, stats: SyncStats): Promise<void> {
    try {
        // Fetch active threads
        const activeThreads = await channel.threads.fetchActive();

        // Fetch archived threads
        const archivedThreads = await channel.threads.fetchArchived();

        // Combine all threads
        const allThreads = new Collection<string, ThreadChannel>();
        activeThreads.threads.forEach((thread, id) => allThreads.set(id, thread));
        archivedThreads.threads.forEach((thread, id) => allThreads.set(id, thread));

        logger.info({
            channelId: channel.id,
            activeThreads: activeThreads.threads.size,
            archivedThreads: archivedThreads.threads.size,
            totalThreads: allThreads.size
        }, 'Processing all threads for full sync');

        for (const [threadId, thread] of allThreads) {
            try {
                await syncThreadFull(thread, stats);
                stats.threadsProcessed++;
            } catch (error) {
                stats.errorsEncountered++;
                logger.error({ error, threadId, threadName: thread.name }, 'Error during full sync of thread');
            }
        }
    } catch (error) {
        stats.errorsEncountered++;
        logger.error({ error, channelId: channel.id }, 'Failed to fetch threads for full sync');
    }
}

async function syncChannelThreadsDelta(channel: ForumChannel, stats: SyncStats, lastSyncDate: Date): Promise<void> {
    try {
        // Fetch active threads
        const activeThreads = await channel.threads.fetchActive();

        // Fetch archived threads
        const archivedThreads = await channel.threads.fetchArchived();

        // Combine all threads
        const allThreads = new Collection<string, ThreadChannel>();
        activeThreads.threads.forEach((thread, id) => allThreads.set(id, thread));
        archivedThreads.threads.forEach((thread, id) => allThreads.set(id, thread));

        logger.info({
            channelId: channel.id,
            totalThreads: allThreads.size,
            lastSyncDate: lastSyncDate.toISOString()
        }, 'Processing threads for delta sync');

        for (const [threadId, thread] of allThreads) {
            try {
                await syncThreadDelta(thread, stats, lastSyncDate);
                stats.threadsProcessed++;
            } catch (error) {
                stats.errorsEncountered++;
                logger.error({ error, threadId, threadName: thread.name }, 'Error during delta sync of thread');
            }
        }
    } catch (error) {
        stats.errorsEncountered++;
        logger.error({ error, channelId: channel.id }, 'Failed to fetch threads for delta sync');
    }
}

async function syncThreadFull(thread: ThreadChannel, stats: SyncStats): Promise<void> {
    // Ensure thread exists in database
    await upsertThread(thread);

    // Fetch all messages
    const messages = await fetchAllMessages(thread);

    logger.debug({ threadId: thread.id, messageCount: messages.size }, 'Processing all messages for full sync');

    // Process messages in chronological order
    const sortedMessages = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const [messageId, message] of sortedMessages) {
        if (message.author.bot) {
            continue; // Skip bot messages
        }

        try {
            await upsertPost(message, stats);
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, messageId, threadId: thread.id }, 'Error processing message in full sync');
        }
    }

    // Update reply count
    await updateThreadReplyCount(thread.id);
}

async function syncThreadDelta(thread: ThreadChannel, stats: SyncStats, lastSyncDate: Date): Promise<void> {
    // Ensure thread exists in database
    await upsertThread(thread);

    try {
        // Fetch messages after lastSyncDate
        const messages = await thread.messages.fetch({
            after: lastSyncDate.getTime().toString()
        });

        logger.debug({
            threadId: thread.id,
            messageCount: messages.size,
            lastSyncDate: lastSyncDate.toISOString()
        }, 'Processing new messages for delta sync');

        // Process messages in chronological order
        const sortedMessages = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        for (const [messageId, message] of sortedMessages) {
            if (message.author.bot) {
                continue; // Skip bot messages
            }

            try {
                await upsertPost(message, stats);
            } catch (error) {
                stats.errorsEncountered++;
                logger.error({ error, messageId, threadId: thread.id }, 'Error processing message in delta sync');
            }
        }

        // Update reply count
        await updateThreadReplyCount(thread.id);

    } catch (error) {
        logger.error({ error, threadId: thread.id }, 'Failed to fetch messages for delta sync');
        throw error;
    }
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

            // Handle both single message and collection returns
            let batch: Collection<string, Message>;
            if (fetchResult instanceof Collection) {
                batch = fetchResult;
            } else {
                // Single message returned, create a collection
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

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
            logger.warn({ error, threadId: thread.id }, 'Failed to fetch messages batch, stopping');
            break;
        }
    }

    return messages;
}

async function upsertChannel(channel: ForumChannel): Promise<void> {
    const slug = channel.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');

    await query(`
        INSERT INTO channels (id, slug, name, description, position, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            slug = VALUES(slug),
            name = VALUES(name),
            description = VALUES(description),
            position = VALUES(position)
    `, [
        channel.id,
        slug,
        channel.name,
        channel.topic || '',
        channel.position,
        new Date(channel.createdTimestamp!)
    ]);
}

async function upsertThread(thread: ThreadChannel): Promise<void> {
    // Generate thread slug
    const slug = thread.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');

    // Get author information
    const authorId = hashUserId(thread.ownerId || '');
    const staffTag = await getStaffTag(thread.ownerId || '');
    const authorAlias = staffTag ? `${authorId.slice(0, 8)}:${staffTag}` : authorId;

    // Get starter message for body content
    let bodyHtml = '';
    try {
        const starterMessage = await thread.fetchStarterMessage();
        if (starterMessage && !starterMessage.author.bot) {
            const sanitizationResult = sanitizeContent(starterMessage.content || '');
            bodyHtml = convertToHtml(sanitizationResult.sanitizedContent);

            // Process images in starter message
            const imageUrls = starterMessage.attachments.map(att => att.url);
            if (imageUrls.length > 0) {
                try {
                    const imageData = await processImageUrls(imageUrls);
                    if (imageData.length > 0) {
                        const imageHtml = imageData
                            .map(img => `<img src="${img.url}" width="${img.width}" height="${img.height}" alt="Image" />`)
                            .join('<br>');
                        bodyHtml += '<br>' + imageHtml;
                    }
                } catch (error) {
                    logger.warn({ error, threadId: thread.id }, 'Failed to process thread starter images');
                }
            }
        }
    } catch (error) {
        logger.warn({ error, threadId: thread.id }, 'Failed to fetch starter message');
    }

    // Process tags
    const tags = thread.appliedTags || [];

    await query(`
        INSERT INTO threads (
            id, channel_id, slug, title, author_alias, body_html, tags, reply_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            slug = VALUES(slug),
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
        bodyHtml,
        JSON.stringify(tags),
        0, // Will be updated when we process posts
        new Date(thread.createdTimestamp!),
        new Date()
    ]);
}

async function upsertPost(message: Message, stats: SyncStats): Promise<void> {
    // Generate author alias
    const authorId = hashUserId(message.author.id);
    const staffTag = await getStaffTag(message.author.id);
    const authorAlias = staffTag ? `${authorId.slice(0, 8)}:${staffTag}` : authorId;

    // Handle reply references
    let replyToId: string | null = null;
    let replyToAuthorAlias: string | null = null;

    if (message.reference && message.reference.messageId) {
        replyToId = message.reference.messageId;

        try {
            // Check if referenced message exists in database
            const referencedPost = await query<{ author_alias: string }>(`
                SELECT author_alias FROM posts WHERE id = ?
            `, [replyToId]);

            if (referencedPost.length > 0 && referencedPost[0]) {
                replyToAuthorAlias = referencedPost[0].author_alias;
            } else {
                // Referenced message doesn't exist in database yet, don't set foreign key
                logger.debug({
                    messageId: message.id,
                    replyToId
                }, 'Referenced message not found in database, clearing reply reference');
                replyToId = null;
                replyToAuthorAlias = null;
            }
        } catch (error) {
            logger.warn({ error, messageId: message.id, replyToId }, 'Error checking for referenced message in database');
            replyToId = null;
            replyToAuthorAlias = null;
        }
    }

    // Process content
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
            logger.warn({ error, messageId: message.id, imageUrls }, 'Failed to process message images');
        }
    }

    // Insert/update post
    await query(`
        INSERT INTO posts (id, thread_id, author_alias, body_html, reply_to_id, reply_to_author_alias, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            body_html = VALUES(body_html),
            reply_to_id = VALUES(reply_to_id),
            reply_to_author_alias = VALUES(reply_to_author_alias),
            updated_at = VALUES(updated_at)
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

    stats.postsProcessed++;
}

async function updateThreadReplyCount(threadId: string): Promise<void> {
    await query(`
        UPDATE threads 
        SET reply_count = (
            SELECT COUNT(*) - 1 
            FROM posts 
            WHERE thread_id = ?
        )
        WHERE id = ?
    `, [threadId, threadId]);
}
