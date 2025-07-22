import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { syncHistoricalData } from '../lib/sync';
import { createLogger } from '../lib/logger';
import { isStaff } from '../lib/staffLoader';

const logger = createLogger('sync-command');

export const data = new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Sync historical Discord content to database')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
        subcommand
            .setName('all')
            .setDescription('Sync all historical data from this server')
            .addIntegerOption(option =>
                option.setName('limit')
                    .setDescription('Maximum number of threads to process (optional)')
                    .setMinValue(1)
                    .setMaxValue(1000)
            )
            .addBooleanOption(option =>
                option.setName('skip-existing')
                    .setDescription('Skip threads that already exist in database')
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('channel')
            .setDescription('Sync historical data from a specific channel')
            .addChannelOption(option =>
                option.setName('channel')
                    .setDescription('The forum channel to sync')
                    .setRequired(true)
            )
            .addIntegerOption(option =>
                option.setName('limit')
                    .setDescription('Maximum number of threads to process (optional)')
                    .setMinValue(1)
                    .setMaxValue(1000)
            )
            .addBooleanOption(option =>
                option.setName('skip-existing')
                    .setDescription('Skip threads that already exist in database')
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('thread')
            .setDescription('Sync a specific thread')
            .addStringOption(option =>
                option.setName('thread-id')
                    .setDescription('The thread ID to sync')
                    .setRequired(true)
            )
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    // Check if user is staff
    const userIsStaff = await isStaff(interaction.user.id);
    if (!userIsStaff) {
        await interaction.reply({
            content: '❌ You do not have permission to use this command.',
            ephemeral: true
        });
        return;
    } await interaction.deferReply();

    try {
        const subcommand = interaction.options.getSubcommand();
        const limit = interaction.options.getInteger('limit') || undefined;
        const skipExisting = interaction.options.getBoolean('skip-existing') || false;

        let syncOptions: any = {
            limit,
            skipExisting
        };

        switch (subcommand) {
            case 'all':
                syncOptions.guildId = interaction.guildId;
                break;

            case 'channel':
                const channel = interaction.options.getChannel('channel');
                if (!channel || channel.type !== 15) {
                    await interaction.editReply('❌ Please specify a valid forum channel.');
                    return;
                }
                syncOptions.channelId = channel.id;
                break;

            case 'thread':
                const threadId = interaction.options.getString('thread-id');
                syncOptions.threadId = threadId;
                break;
        }

        logger.info({
            userId: interaction.user.id,
            guildId: interaction.guildId,
            subcommand,
            syncOptions
        }, 'Starting sync command');

        const startMessage = await interaction.editReply({
            content: `🔄 Starting sync operation...\n\`\`\`\nSubcommand: ${subcommand}\nOptions: ${JSON.stringify(syncOptions, null, 2)}\n\`\`\``
        });

        const stats = await syncHistoricalData(interaction.client, syncOptions);

        const duration = stats.endTime!.getTime() - stats.startTime.getTime();
        const durationMinutes = Math.round(duration / 60000 * 100) / 100;

        const resultMessage = [
            '✅ **Sync Operation Completed**',
            '',
            '📊 **Statistics:**',
            `• Channels processed: ${stats.channelsProcessed}`,
            `• Threads processed: ${stats.threadsProcessed}`,
            `• Posts processed: ${stats.postsProcessed}`,
            `• Errors encountered: ${stats.errorsEncountered}`,
            `• Duration: ${durationMinutes} minutes`,
            '',
            `🕒 Started: <t:${Math.floor(stats.startTime.getTime() / 1000)}:f>`,
            `🏁 Finished: <t:${Math.floor(stats.endTime!.getTime() / 1000)}:f>`,
        ];

        if (stats.errorsEncountered > 0) {
            resultMessage.push('', '⚠️ Some errors occurred during sync. Check the logs for details.');
        }

        await interaction.editReply({
            content: resultMessage.join('\n')
        });

        logger.info({
            userId: interaction.user.id,
            guildId: interaction.guildId,
            stats,
            durationMinutes
        }, 'Sync command completed');

    } catch (error) {
        logger.error({
            error,
            userId: interaction.user.id,
            guildId: interaction.guildId,
        }, 'Sync command failed');

        await interaction.editReply({
            content: `❌ **Sync Operation Failed**\n\nError: ${error instanceof Error ? error.message : 'Unknown error'}\n\nCheck the logs for more details.`
        });
    }
}
