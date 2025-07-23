import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { createLogger } from './lib/logger';
import { initializeDatabase } from './lib/db';
import { initializeMetrics } from './lib/metrics';
import { loadStaffFromCSV } from './lib/staffLoader';
import { messageHandler } from './handlers/message';
import { threadHandler } from './handlers/thread';
import { CommandHandler } from './lib/commandHandler';
import { smartSync } from './lib/smartSync';
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

        // Check run mode configuration
        const runMode = process.env.RUN_MODE || 'watch'; // 'watch' or 'once'
        const exitAfterSync = process.env.EXIT_AFTER_SYNC === 'true';

        logger.info({ runMode, exitAfterSync }, 'Bot configuration');

        // Set up Discord event handlers
        client.on('ready', async () => {
            logger.info(`Bot logged in as ${client.user?.tag}`);

            // Register commands only in watch mode or if explicitly enabled
            if ((runMode === 'watch' || process.env.REGISTER_COMMANDS === 'true') && client.user && process.env.DISCORD_TOKEN) {
                try {
                    // Use guild ID for faster command registration during development
                    const guildId = process.env.DISCORD_GUILD_ID;
                    await commandHandler.registerCommands(client.user.id, process.env.DISCORD_TOKEN, guildId);
                } catch (error) {
                    logger.error({ error }, 'Failed to register commands');
                }
            }

            // Run smart sync if enabled
            if (process.env.ENABLE_HISTORICAL_SYNC === 'true') {
                logger.info('Smart sync enabled, starting sync process...');

                try {
                    // Determine if this should be a forced full sync based on environment variables
                    const forceFull = process.env.FORCE_FULL_SYNC === 'true';

                    logger.info({ forceFull }, 'Starting smart sync');

                    await smartSync(client, { forceFull });

                    logger.info('Smart sync completed successfully');

                    // Exit after sync if in one-time mode or explicitly configured
                    if (runMode === 'once' || exitAfterSync) {
                        logger.info('Exiting after sync completion as configured');
                        client.destroy();
                        process.exit(0);
                    }

                } catch (error) {
                    logger.error({ error }, 'Smart sync failed');

                    // Exit on sync failure if in one-time mode
                    if (runMode === 'once' || exitAfterSync) {
                        logger.error('Exiting due to sync failure in one-time mode');
                        client.destroy();
                        process.exit(1);
                    }
                }
            } else if (runMode === 'once') {
                // If running in one-time mode but no sync is enabled, log a warning and exit
                logger.warn('Running in one-time mode but ENABLE_HISTORICAL_SYNC is not true. Nothing to do.');
                client.destroy();
                process.exit(0);
            }
        });

        // Set up interaction and message handlers only in watch mode
        if (runMode === 'watch') {
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

            logger.info('Event handlers registered for watch mode');
        } else {
            logger.info('Skipping event handler registration for one-time mode');
        }

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
