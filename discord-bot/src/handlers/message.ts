import { Message, PartialMessage } from 'discord.js';
import { query, queryOne } from '../lib/db';
import { hashUserId } from '../lib/hash';
import { sanitizeContent, convertToHtml } from '../lib/sanitizer';
import { processImages } from './image';
import { getStaffTag } from '../lib/staffLoader';
import { recordDiscordEvent, measureDbQuery } from '../lib/metrics';
import { createLogger } from '../lib/logger';

const logger = createLogger('messageHandler');

interface ReplyContext {
    replyToId: string | null;
    replyToAuthorAlias: string | null;
    isReply: boolean;
}

async function getReplyContext(message: Message): Promise<ReplyContext> {
    const isReply = message.reference && message.reference.messageId;
    let replyToId: string | null = null;
    let replyToAuthorAlias: string | null = null;

    if (isReply && message.reference?.messageId) {
        replyToId = message.reference.messageId;

        // Try to get the original message to find the author
        try {
            const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
            if (referencedMessage && referencedMessage.author) {
                replyToAuthorAlias = hashUserId(referencedMessage.author.id);
                logger.debug({
                    messageId: message.id,
                    replyToId,
                    replyToAuthorAlias
                }, 'Detected reply message');
            }
        } catch (error) {
            logger.warn({
                error,
                messageId: message.id,
                replyToId
            }, 'Could not fetch referenced message for reply detection');
        }
    }

    return {
        replyToId,
        replyToAuthorAlias,
        isReply: !!replyToId
    };
}

export async function messageHandler(
    message: Message | PartialMessage,
    oldMessage?: Message | PartialMessage
): Promise<void> {
    try {
        // Skip if not in a forum channel or thread
        if (!message.channel?.isThread() && !('parent' in message.channel && message.channel.parent?.type)) {
            return;
        }

        const eventType = oldMessage ? 'messageUpdate' : message.partial ? 'messageDelete' : 'messageCreate';

        // Handle message deletion
        if (message.partial && !message.content) {
            await handleMessageDelete(message);
            recordDiscordEvent(eventType, 'success');
            return;
        }

        // Fetch partial message
        if (message.partial) {
            message = await message.fetch();
        }

        // Skip bot messages and empty messages
        if (message.author?.bot || !message.content) {
            return;
        }

        // Process based on event type
        if (oldMessage) {
            await handleMessageUpdate(message, oldMessage);
        } else {
            await handleMessageCreate(message);
        }

        recordDiscordEvent(eventType, 'success');

    } catch (error) {
        logger.error({ error, messageId: message.id }, 'Error handling message event');
        const eventType = oldMessage ? 'messageUpdate' : message.partial ? 'messageDelete' : 'messageCreate';
        recordDiscordEvent(eventType, 'error');
    }
}

async function handleMessageCreate(message: Message): Promise<void> {
    logger.debug({ messageId: message.id, channelId: message.channel.id }, 'Handling message create');

    const authorAlias = hashUserId(message.author.id);
    const staffTag = await getStaffTag(message.author.id);

    // Get reply context
    const replyContext = await getReplyContext(message);

    // Sanitize content
    const sanitizationResult = sanitizeContent(message.content);
    let htmlContent = convertToHtml(sanitizationResult.sanitizedContent);

    // Process images if any
    const imageData = await processImages(message.attachments);
    if (imageData.length > 0) {
        const imageHtml = imageData
            .map(img => `<img src="${img.url}" width="${img.width}" height="${img.height}" alt="Image" />`)
            .join('<br>');
        htmlContent += '<br>' + imageHtml;
    }

    // Determine if this is a thread starter or a reply
    if (message.channel.isThread()) {
        // This is a reply in an existing thread
        await measureDbQuery('insert_post', async () => {
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
                replyContext.replyToId,
                replyContext.replyToAuthorAlias,
                message.createdAt,
                message.editedAt || message.createdAt,
            ]);

            // Update thread reply count
            await query(`
        UPDATE threads
        SET reply_count = (
          SELECT COUNT(*) FROM posts WHERE thread_id = ?
        ),
        updated_at = ?
        WHERE id = ?
      `, [message.channel.id, new Date(), message.channel.id]);
        });

        logger.info({
            messageId: message.id,
            threadId: message.channel.id,
            authorAlias,
            staffTag,
            isReply: replyContext.isReply,
            replyToId: replyContext.replyToId,
            replyToAuthorAlias: replyContext.replyToAuthorAlias,
        }, 'Post created');

    } else {
        // This might be the initial message creating a new thread
        // We'll handle this in the thread handler
        logger.debug({ messageId: message.id }, 'Message in non-thread channel, skipping');
    }
}

async function handleMessageUpdate(
    message: Message,
    oldMessage: Message | PartialMessage
): Promise<void> {
    logger.debug({ messageId: message.id }, 'Handling message update');

    // Only process if content actually changed
    if (message.content === oldMessage.content) {
        return;
    }

    const authorAlias = hashUserId(message.author.id);

    // Sanitize updated content
    const sanitizationResult = sanitizeContent(message.content);
    let htmlContent = convertToHtml(sanitizationResult.sanitizedContent);

    // Process images if any
    const imageData = await processImages(message.attachments);
    if (imageData.length > 0) {
        const imageHtml = imageData
            .map(img => `<img src="${img.url}" width="${img.width}" height="${img.height}" alt="Image" />`)
            .join('<br>');
        htmlContent += '<br>' + imageHtml;
    }

    if (message.channel.isThread()) {
        // Check if this is a post or the thread starter
        const existingPost = await measureDbQuery('select_post', async () => {
            return await queryOne<{ id: string }>(`
        SELECT id FROM posts WHERE id = ?
      `, [message.id]);
        });

        if (existingPost) {
            // Update existing post
            await measureDbQuery('update_post', async () => {
                await query(`
          UPDATE posts
          SET body_html = ?, updated_at = ?
          WHERE id = ?
        `, [htmlContent, message.editedAt || new Date(), message.id]);
            });

            logger.info({ messageId: message.id, threadId: message.channel.id }, 'Post updated');
        } else {
            // This might be the thread starter message, check threads table
            const existingThread = await measureDbQuery('select_thread', async () => {
                return await queryOne<{ id: string }>(`
          SELECT id FROM threads WHERE id = ?
        `, [message.channel.id]);
            });

            if (existingThread) {
                await measureDbQuery('update_thread', async () => {
                    await query(`
            UPDATE threads
            SET body_html = ?, updated_at = ?
            WHERE id = ?
          `, [htmlContent, message.editedAt || new Date(), message.channel.id]);
                });

                logger.info({ messageId: message.id, threadId: message.channel.id }, 'Thread body updated');
            }
        }
    }
}

async function handleMessageDelete(message: PartialMessage): Promise<void> {
    logger.debug({ messageId: message.id }, 'Handling message delete');

    // Try to delete from posts table first
    const postDeleted = await measureDbQuery('delete_post', async () => {
        const result = await query(`
      DELETE FROM posts WHERE id = ?
    `, [message.id]);
        return (result as any).affectedRows > 0;
    });

    if (postDeleted) {
        // Update thread reply count if a post was deleted
        if (message.channel?.isThread()) {
            await query(`
        UPDATE threads
        SET reply_count = (
          SELECT COUNT(*) FROM posts WHERE thread_id = ?
        ),
        updated_at = ?
        WHERE id = ?
      `, [message.channel.id, new Date(), message.channel.id]);
        }

        logger.info({ messageId: message.id }, 'Post deleted');
    } else {
        logger.debug({ messageId: message.id }, 'Message not found in database');
    }
}
