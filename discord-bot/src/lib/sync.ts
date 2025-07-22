import { Client, ForumChannel, ThreadChannel, Collection, Message } from 'discord.js';
import { query } from './db';
import { hashUserId } from './hash';
import { sanitizeContent, convertToHtml } from './sanitizer';
import { processImageUrls } from '../handlers/image';
import { getStaffTag } from './staffLoader';
import { createLogger } from './logger';

const logger = createLogger('sync');

export interface SyncStats {
    channelsProcessed: number;
    threadsProcessed: number;
    postsProcessed: number;
    errorsEncountered: number;
    startTime: Date;
    endTime?: Date;
}

export interface SyncOptions {
    guildId?: string;
    channelId?: string;
    threadId?: string;
    limit?: number;
    skipExisting?: boolean;
}

export async function syncHistoricalData(
    client: Client,
    options: SyncOptions = {}
): Promise<SyncStats> {
    const stats: SyncStats = {
        channelsProcessed: 0,
        threadsProcessed: 0,
        postsProcessed: 0,
        errorsEncountered: 0,
        startTime: new Date(),
    };

    logger.info({ options }, 'Starting historical sync');

    try {
        if (options.threadId) {
            // Sync specific thread
            await syncSpecificThread(client, options.threadId, stats, options);
        } else if (options.channelId) {
            // Sync specific channel
            await syncSpecificChannel(client, options.channelId, stats, options);
        } else if (options.guildId) {
            // Sync specific guild
            await syncSpecificGuild(client, options.guildId, stats, options);
        } else {
            // Sync all guilds
            await syncAllGuilds(client, stats, options);
        }

        stats.endTime = new Date();
        const duration = stats.endTime.getTime() - stats.startTime.getTime();

        logger.info({
            ...stats,
            durationMs: duration,
            durationMinutes: Math.round(duration / 60000),
        }, 'Historical sync completed');

    } catch (error) {
        stats.errorsEncountered++;
        logger.error({ error, stats }, 'Historical sync failed');
        throw error;
    }

    return stats;
}

async function syncAllGuilds(
    client: Client,
    stats: SyncStats,
    options: SyncOptions
): Promise<void> {
    const guilds = client.guilds.cache;
    logger.info(`Found ${guilds.size} guilds to process`);

    for (const [guildId, guild] of guilds) {
        try {
            logger.info({ guildId, guildName: guild.name }, 'Processing guild');
            await syncSpecificGuild(client, guildId, stats, options);
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, guildId, guildName: guild.name }, 'Error processing guild');
        }
    }
}

async function syncSpecificGuild(
    client: Client,
    guildId: string,
    stats: SyncStats,
    options: SyncOptions
): Promise<void> {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        throw new Error(`Guild ${guildId} not found`);
    }

    // Get all forum channels
    const forumChannels = guild.channels.cache.filter(
        channel => channel.type === 15 // GUILD_FORUM
    ) as Collection<string, ForumChannel>;

    logger.info(`Found ${forumChannels.size} forum channels in guild ${guild.name}`);

    for (const [channelId, channel] of forumChannels) {
        try {
            await syncSpecificChannel(client, channelId, stats, options);
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, channelId, channelName: channel.name }, 'Error processing channel');
        }
    }
}

async function syncSpecificChannel(
    client: Client,
    channelId: string,
    stats: SyncStats,
    options: SyncOptions
): Promise<void> {
    const channel = client.channels.cache.get(channelId) as ForumChannel;
    if (!channel || channel.type !== 15) {
        throw new Error(`Forum channel ${channelId} not found`);
    }

    logger.info({ channelId, channelName: channel.name }, 'Processing forum channel');

    // Upsert channel first
    await query(`
    INSERT INTO channels (id, slug, name, description, position, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      description = VALUES(description),
      position = VALUES(position)
  `, [
        channel.id,
        channel.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        channel.name,
        channel.topic || null,
        channel.position || 0,
        new Date(),
    ]);

    stats.channelsProcessed++;

    // Get all threads (archived and active)
    const threads = await channel.threads.fetchArchived({ type: 'public' });
    const activeThreads = await channel.threads.fetchActive();

    const allThreads = new Collection([
        ...threads.threads.entries(),
        ...activeThreads.threads.entries(),
    ]);

    logger.info(`Found ${allThreads.size} threads in channel ${channel.name}`);

    for (const [threadId, thread] of allThreads) {
        try {
            if (options.limit && stats.threadsProcessed >= options.limit) {
                logger.info('Reached thread limit, stopping');
                break;
            }
            await syncSpecificThread(client, threadId, stats, options);
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, threadId, threadName: thread.name }, 'Error processing thread');
        }
    }
}

async function syncSpecificThread(
    client: Client,
    threadId: string,
    stats: SyncStats,
    options: SyncOptions
): Promise<void> {
    const thread = client.channels.cache.get(threadId) as ThreadChannel;
    if (!thread || !thread.isThread()) {
        throw new Error(`Thread ${threadId} not found`);
    }

    logger.debug({ threadId, threadName: thread.name }, 'Processing thread');

    // Check if thread already exists and skip if requested
    if (options.skipExisting) {
        const existingThread = await query(`SELECT id FROM threads WHERE id = ?`, [threadId]);
        if (existingThread.length > 0) {
            logger.debug({ threadId }, 'Thread already exists, skipping');
            return;
        }
    }

    // Get starter message
    const starterMessage = await thread.fetchStarterMessage();
    if (!starterMessage || starterMessage.author.bot) {
        logger.debug({ threadId }, 'No starter message or bot message, skipping');
        return;
    }

    const authorAlias = hashUserId(starterMessage.author.id);

    // Process starter message content
    const sanitizationResult = sanitizeContent(starterMessage.content || '');
    let htmlContent = convertToHtml(sanitizationResult.sanitizedContent);

    // Process images from attachments
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
            logger.warn({ error, threadId, imageUrls }, 'Failed to process thread images');
        }
    }

    // Extract tags from thread
    const tags = thread.appliedTags || [];
    const tagNames = tags.length > 0 ?
        tags.map((tagId: string) => {
            if ('availableTags' in thread.parent! && thread.parent.availableTags) {
                const tag = thread.parent.availableTags.find((t: any) => t.id === tagId);
                return tag?.name || tagId;
            }
            return tagId;
        }).filter(Boolean) : null;

    // Create thread slug
    const slug = thread.name.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 255);

    // Upsert thread
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
        thread.parentId!,
        slug,
        thread.name,
        authorAlias,
        htmlContent,
        tagNames ? JSON.stringify(tagNames) : null,
        0, // Will be updated when we process posts
        starterMessage.createdAt,
        new Date(),
    ]);

    stats.threadsProcessed++;

    // Fetch all messages in the thread
    logger.debug({ threadId }, 'Fetching thread messages');

    const messages = await fetchAllMessages(thread);
    logger.debug({ threadId, messageCount: messages.size }, 'Fetched thread messages');

    // Sort messages by creation time to process in chronological order
    // This ensures that replies are processed after the messages they reply to
    const sortedMessages = Array.from(messages.values())
        .filter(msg => msg.id !== starterMessage.id && !msg.author.bot)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let postCount = 0;
    for (const message of sortedMessages) {
        try {
            await syncMessage(message, stats);
            postCount++;
        } catch (error) {
            stats.errorsEncountered++;
            logger.error({ error, messageId: message.id, threadId }, 'Error processing message');
        }
    }

    // Second pass: Update reply relationships for messages that had missing references
    logger.debug({ threadId }, 'Updating reply relationships');
    for (const message of sortedMessages) {
        try {
            if (message.reference && message.reference.messageId) {
                await updateReplyReferences(message, stats);
            }
        } catch (error) {
            logger.debug({ error, messageId: message.id, threadId }, 'Error updating reply references');
        }
    }    // Update thread reply count
    await query(`
    UPDATE threads 
    SET reply_count = ?
    WHERE id = ?
  `, [postCount, threadId]);

    logger.info({
        threadId,
        threadName: thread.name,
        postCount,
        authorAlias
    }, 'Thread processed');
}

async function syncMessage(message: Message, stats: SyncStats): Promise<void> {
    const authorAlias = hashUserId(message.author.id);

    // Check for reply context
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
            logger.debug({ error, messageId: message.id, replyToId }, 'Could not fetch referenced message');
        }

        // Check if the referenced message exists in the database
        if (replyToId) {
            try {
                const existingPost = await query<{ id: string }>(`
          SELECT id FROM posts WHERE id = ?
        `, [replyToId]);

                if (existingPost.length === 0) {
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

    // Insert post
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

async function updateReplyReferences(message: Message, stats: SyncStats): Promise<void> {
    if (!message.reference || !message.reference.messageId) {
        return;
    }

    const replyToId = message.reference.messageId;

    // Check if the current post has no reply reference set
    const currentPost = await query<{ reply_to_id: string | null }>(`
    SELECT reply_to_id FROM posts WHERE id = ?
  `, [message.id]);

    if (currentPost.length === 0 || (currentPost[0] && currentPost[0].reply_to_id !== null)) {
        return; // Post doesn't exist or already has reply reference
    }

    // Check if the referenced message now exists in the database
    const referencedPost = await query<{ id: string, author_alias: string }>(`
    SELECT id, author_alias FROM posts WHERE id = ?
  `, [replyToId]);

    if (referencedPost.length > 0 && referencedPost[0]) {
        // Update the reply reference
        await query(`
      UPDATE posts 
      SET reply_to_id = ?, reply_to_author_alias = ?, updated_at = ?
      WHERE id = ?
    `, [
            replyToId,
            referencedPost[0].author_alias,
            new Date(),
            message.id
        ]);

        logger.debug({
            messageId: message.id,
            replyToId,
            replyToAuthorAlias: referencedPost[0].author_alias
        }, 'Updated reply reference');
    }
} async function fetchAllMessages(thread: ThreadChannel): Promise<Collection<string, Message>> {
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