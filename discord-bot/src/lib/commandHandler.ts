import { Client, Collection, REST, Routes, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from './logger';
import path from 'path';
import fs from 'fs';

const logger = createLogger('command-handler');

interface Command {
    data: any;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export class CommandHandler {
    private commands = new Collection<string, Command>();
    private client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    async loadCommands() {
        const commandsPath = path.join(__dirname, '..', 'commands');

        if (!fs.existsSync(commandsPath)) {
            logger.warn('Commands directory does not exist');
            return;
        }

        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));

        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            try {
                const command = await import(filePath);

                if ('data' in command && 'execute' in command) {
                    this.commands.set(command.data.name, command);
                    logger.info(`Loaded command: ${command.data.name}`);
                } else {
                    logger.warn(`Command ${file} is missing required "data" or "execute" property`);
                }
            } catch (error) {
                logger.error({ error, file }, `Failed to load command: ${file}`);
            }
        }

        logger.info(`Loaded ${this.commands.size} commands`);
    }

    async registerCommands(clientId: string, token: string, guildId?: string) {
        const commands = Array.from(this.commands.values()).map(command => command.data.toJSON());

        const rest = new REST().setToken(token);

        try {
            logger.info(`Started refreshing ${commands.length} application (/) commands`);

            let data: any;
            if (guildId) {
                // Register guild-specific commands (faster for development)
                data = await rest.put(
                    Routes.applicationGuildCommands(clientId, guildId),
                    { body: commands }
                );
            } else {
                // Register global commands (takes up to 1 hour to propagate)
                data = await rest.put(
                    Routes.applicationCommands(clientId),
                    { body: commands }
                );
            }

            logger.info(`Successfully reloaded ${data.length} application (/) commands`);
        } catch (error) {
            logger.error({ error }, 'Failed to register commands');
            throw error;
        }
    }

    async handleInteraction(interaction: ChatInputCommandInteraction) {
        const command = this.commands.get(interaction.commandName);

        if (!command) {
            logger.warn(`Unknown command: ${interaction.commandName}`);
            return;
        }

        try {
            logger.info({
                commandName: interaction.commandName,
                userId: interaction.user.id,
                guildId: interaction.guildId,
                channelId: interaction.channelId,
            }, 'Executing command');

            await command.execute(interaction);

            logger.info({
                commandName: interaction.commandName,
                userId: interaction.user.id,
            }, 'Command executed successfully');

        } catch (error) {
            logger.error({
                error,
                commandName: interaction.commandName,
                userId: interaction.user.id,
                guildId: interaction.guildId,
            }, 'Command execution failed');

            const errorMessage = 'There was an error while executing this command!';

            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: errorMessage, ephemeral: true });
                } else {
                    await interaction.reply({ content: errorMessage, ephemeral: true });
                }
            } catch (replyError) {
                logger.error({ error: replyError }, 'Failed to send error message to user');
            }
        }
    }

    getCommands() {
        return this.commands;
    }
}
