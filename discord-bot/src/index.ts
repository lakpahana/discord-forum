import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createLogger } from './lib/logger';
import { initializeDatabase } from './lib/db';
import { initializeMetrics } from './lib/metrics';
import { loadStaffFromCSV } from './lib/staffLoader';
import { messageHandler } from './handlers/message';
import { threadHandler } from './handlers/thread';
import { CommandHandler } from './lib/commandHandler';
import { syncHistoricalData, SyncOptions } from './lib/sync';
import { staffRolesRouter } from './routes/staffRoles';
import { moderationRouter } from './routes/moderation';
import { healthRouter } from './routes/health';

const logger = createLogger('main');

async function main() {
    try {
        // Initialize metrics
        initializeMetrics();
        logger.info('Metrics initialized');

        // Initialize database
        await initializeDatabase();
        logger.info('Database initialized');

        // Load staff from CSV if exists
        if (process.env.STAFF_CSV_PATH) {
            await loadStaffFromCSV(process.env.STAFF_CSV_PATH);
            logger.info('Staff roles loaded from CSV');
        }

        // Initialize Discord client
        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
            partials: [Partials.Message, Partials.Channel, Partials.Reaction],
        });

        // Initialize command handler
        const commandHandler = new CommandHandler(client);
        await commandHandler.loadCommands();

        // Set up Discord event handlers
        client.on('ready', async () => {
            logger.info(`Bot logged in as ${client.user?.tag}`);

            // Register commands
            if (client.user && process.env.DISCORD_TOKEN) {
                try {
                    // Use guild ID for faster command registration during development
                    const guildId = process.env.DISCORD_GUILD_ID;
                    await commandHandler.registerCommands(client.user.id, process.env.DISCORD_TOKEN, guildId);
                } catch (error) {
                    logger.error({ error }, 'Failed to register commands');
                }
            }

            // Run historical sync if enabled
            if (process.env.ENABLE_HISTORICAL_SYNC === 'true') {
                logger.info('Historical sync enabled, starting sync process...');

                try {
                    const syncOptions: SyncOptions = {
                        guildId: process.env.SYNC_GUILD_ID || undefined,
                        channelId: process.env.SYNC_CHANNEL_ID || undefined,
                        threadId: process.env.SYNC_THREAD_ID || undefined,
                        limit: process.env.SYNC_LIMIT ? parseInt(process.env.SYNC_LIMIT) : undefined,
                        skipExisting: process.env.SYNC_SKIP_EXISTING === 'true',
                    };

                    logger.info({ syncOptions }, 'Starting historical sync with options');

                    const stats = await syncHistoricalData(client, syncOptions);

                    const duration = stats.endTime!.getTime() - stats.startTime.getTime();
                    const durationMinutes = Math.round(duration / 60000 * 100) / 100;

                    logger.info({
                        channelsProcessed: stats.channelsProcessed,
                        threadsProcessed: stats.threadsProcessed,
                        postsProcessed: stats.postsProcessed,
                        errorsEncountered: stats.errorsEncountered,
                        durationMinutes,
                    }, 'Historical sync completed successfully');

                    if (stats.errorsEncountered > 0) {
                        logger.warn({ errors: stats.errorsEncountered }, 'Historical sync completed with some errors');
                    }

                } catch (error) {
                    logger.error({ error }, 'Historical sync failed');
                }
            }
        });

        client.on('interactionCreate', async (interaction) => {
            if (interaction.isChatInputCommand()) {
                await commandHandler.handleInteraction(interaction);
            }
        });

        client.on('messageCreate', messageHandler);
        client.on('messageUpdate', messageHandler);
        client.on('messageDelete', messageHandler);
        client.on('threadCreate', threadHandler);
        client.on('threadUpdate', threadHandler);

        client.on('error', error => {
            logger.error({ error }, 'Discord client error');
        });

        // Login to Discord
        await client.login(process.env.DISCORD_TOKEN);

        // Graceful shutdown
        const shutdown = (signal: string) => {
            logger.info(`Received ${signal}, shutting down gracefully`);
            client.destroy();
            process.exit(0);
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

    } catch (error) {
        logger.fatal({ error }, 'Failed to start application');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
