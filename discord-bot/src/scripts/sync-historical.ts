import { Client, GatewayIntentBits } from 'discord.js';
import { syncHistoricalData, SyncOptions } from '../lib/sync';
import { createLogger } from '../lib/logger';
import { initializeDatabase } from '../lib/db';

const logger = createLogger('sync-cli');

interface CLIOptions {
    token: string;
    guildId?: string;
    channelId?: string;
    threadId?: string;
    limit?: number;
    skipExisting?: boolean;
    help?: boolean;
}

function parseArgs(): CLIOptions {
    const args = process.argv.slice(2);
    const options: CLIOptions = {
        token: process.env.DISCORD_TOKEN!,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--help':
            case '-h':
                options.help = true;
                break;
            case '--guild':
            case '-g':
                if (i + 1 < args.length) {
                    options.guildId = args[++i];
                }
                break;
            case '--channel':
            case '-c':
                if (i + 1 < args.length) {
                    options.channelId = args[++i];
                }
                break;
            case '--thread':
            case '-t':
                if (i + 1 < args.length) {
                    options.threadId = args[++i];
                }
                break;
            case '--limit':
            case '-l':
                if (i + 1 < args.length) {
                    const limitStr = args[++i];
                    if (limitStr) {
                        options.limit = parseInt(limitStr);
                    }
                }
                break;
            case '--skip-existing':
            case '-s':
                options.skipExisting = true;
                break;
            case '--token':
                if (i + 1 < args.length) {
                    const tokenStr = args[++i];
                    if (tokenStr) {
                        options.token = tokenStr;
                    }
                }
                break;
        }
    }

    return options;
} function showHelp() {
    console.log(`
Discord Historical Sync CLI

Usage: npm run sync [options]

Options:
  --help, -h              Show this help message
  --token <token>         Discord bot token (or use DISCORD_TOKEN env var)
  --guild, -g <id>        Sync specific guild/server by ID
  --channel, -c <id>      Sync specific forum channel by ID
  --thread, -t <id>       Sync specific thread by ID
  --limit, -l <number>    Maximum number of threads to process
  --skip-existing, -s     Skip threads that already exist in database

Examples:
  npm run sync                           # Sync all guilds
  npm run sync --guild 123456789        # Sync specific guild
  npm run sync --channel 987654321      # Sync specific channel
  npm run sync --thread 111222333       # Sync specific thread
  npm run sync --limit 50 --skip-existing  # Sync up to 50 new threads only

Environment Variables:
  DISCORD_TOKEN          Discord bot token
  MYSQL_HOST            MySQL host
  MYSQL_PORT            MySQL port
  MYSQL_USER            MySQL username
  MYSQL_PASSWORD        MySQL password
  MYSQL_DATABASE        MySQL database name
`);
}

async function main() {
    const options = parseArgs();

    if (options.help) {
        showHelp();
        process.exit(0);
    }

    if (!options.token) {
        console.error('❌ Discord token is required. Set DISCORD_TOKEN environment variable or use --token flag.');
        process.exit(1);
    }

    console.log('🔄 Initializing Discord client...');

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    try {
        // Initialize database
        console.log('🔄 Connecting to database...');
        await initializeDatabase();
        console.log('✅ Database connected');

        // Login to Discord
        console.log('🔄 Logging into Discord...');
        await client.login(options.token);
        console.log('✅ Discord connected');

        // Wait for client to be ready
        await new Promise<void>((resolve) => {
            client.once('ready', () => {
                console.log(`✅ Bot ready as ${client.user?.tag}`);
                resolve();
            });
        });

        // Prepare sync options
        const syncOptions: SyncOptions = {
            guildId: options.guildId,
            channelId: options.channelId,
            threadId: options.threadId,
            limit: options.limit,
            skipExisting: options.skipExisting,
        };

        console.log('🔄 Starting historical sync...');
        console.log('Options:', JSON.stringify(syncOptions, null, 2));

        const stats = await syncHistoricalData(client, syncOptions);

        const duration = stats.endTime!.getTime() - stats.startTime.getTime();
        const durationMinutes = Math.round(duration / 60000 * 100) / 100;

        console.log('\n✅ Sync completed successfully!');
        console.log('📊 Statistics:');
        console.log(`  • Channels processed: ${stats.channelsProcessed}`);
        console.log(`  • Threads processed: ${stats.threadsProcessed}`);
        console.log(`  • Posts processed: ${stats.postsProcessed}`);
        console.log(`  • Errors encountered: ${stats.errorsEncountered}`);
        console.log(`  • Duration: ${durationMinutes} minutes`);

        if (stats.errorsEncountered > 0) {
            console.log('\n⚠️  Some errors occurred during sync. Check the logs for details.');
        }

    } catch (error) {
        console.error('❌ Sync failed:', error);
        logger.error({ error }, 'CLI sync failed');
        process.exit(1);
    } finally {
        client.destroy();
        process.exit(0);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

if (require.main === module) {
    main().catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
