import { Client, elizaLogger, IAgentRuntime } from "@elizaos/core";
import { DiscordClient } from "@elizaos/client-discord";
import { ClientBase } from "./base.ts";
import { validateTwitterConfig } from "./environment.ts";
import { TwitterMonitoringClient } from "./monitoring.ts";
import { TwitterSearchClient } from "./search.ts";
import {
    Message as DiscordMessage,
    PermissionsBitField,
    TextChannel,
} from "discord.js";

interface DiscordInterface {
    channels: {
        fetch: (channelId: string) => Promise<{
            send: (content: any) => Promise<unknown>;
        }>;
    };
}

class TwitterManager {
    client: ClientBase;
    monitor: TwitterMonitoringClient;
    search: TwitterSearchClient;

    constructor(
        runtime: IAgentRuntime,
        discordInterface: DiscordInterface,
        discordChannelId: string
    ) {
        elizaLogger.log(`[DEBUG] Creating TwitterManager with discordChannelId: ${discordChannelId}`);

        this.client = new ClientBase(runtime);
        elizaLogger.log(`[DEBUG] Created ClientBase`);

        this.monitor = new TwitterMonitoringClient(
            this.client,
            runtime,
            {
                sendToDiscord: async (content: any) => {
                    elizaLogger.log(`[DEBUG] Attempting to send to Discord channel: ${discordChannelId}`);
                    try {
                        const discordClient = runtime.clients.discord as DiscordClient;
                        // const discordJsClient = discordClient.client; // This is the actual discord.js `Client` instance
                        const channelId = runtime.getSetting("DISCORD_CHANNEL_ID");
                        const channel = await discordClient.client.channels.fetch(channelId);
                        if (!channel?.isTextBased()) {
                            throw new Error("Target channel is not a text-based channel!");
                          }
                        elizaLogger.log(`[DEBUG] Successfully fetched Discord channel`);
                        const result = await (channel as TextChannel).send(content);
                        elizaLogger.log(`[DEBUG] Successfully sent message to Discord`);
                        return result;
                    } catch (error) {
                        console.error("Discord send error (raw)", error);
                        console.error("Discord send error (keys):", Object.getOwnPropertyNames(error));

                        // If it's a DiscordAPIError, you might also have these properties:
                        if ("code" in error) {
                            console.error("Discord send error code:", error.code);
                        }
                        if ("status" in error) {
                            console.error("Discord send error status:", error.status);
                        }
                        if ("message" in error) {
                            console.error("Discord send error message:", error.message);
                        }
                        throw error;
                    }
                }
            }
        );
        elizaLogger.log(`[DEBUG] Created TwitterMonitoringClient`);

        this.search = new TwitterSearchClient(this.client, runtime);
        elizaLogger.log(`[DEBUG] Created TwitterSearchClient`);
    }

    async init() {
        elizaLogger.log(`[DEBUG] Initializing TwitterManager`);
        try {
            await this.client.init();
            elizaLogger.log(`[DEBUG] Twitter client initialized`);

            await this.monitor.start();
            elizaLogger.log(`[DEBUG] Twitter monitor started`);

        } catch (error) {
            elizaLogger.error(`[DEBUG] Error in TwitterManager init:`, error);
            throw error;
        }
    }
}

export const TwitterClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        elizaLogger.log(`[DEBUG] Starting Twitter client`);

        // Attendre que Discord soit complètement initialisé
        const waitForDiscord = async (attempts = 0, maxAttempts = 3): Promise<void> => {
            if (attempts >= maxAttempts) {
                // throw new Error("Timeout waiting for Discord initialization");
                elizaLogger.log(`[DEBUG] Waiting for Discord client (attempt ${attempts + 1}/${maxAttempts})`);
                return;
            }

            if (!runtime.clients?.discord) {
                elizaLogger.log(`[DEBUG] Waiting for Discord client (attempt ${attempts + 1}/${maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return waitForDiscord(attempts + 1, maxAttempts);
            }

            // Vérifier le canal Discord
            const discordChannelId = runtime.getSetting("DISCORD_CHANNEL_ID");
            if (!discordChannelId) {
                throw new Error("DISCORD_CHANNEL_ID must be set in environment");
            }

            try {
                const discordClient = runtime.clients.discord;
                const channel = await discordClient.channels.fetch(discordChannelId);
                if (!channel) {
                    throw new Error(`Discord channel ${discordChannelId} not found`);
                }
                elizaLogger.log(`[DEBUG] Discord channel ${discordChannelId} verified`);
            } catch (error) {
                elizaLogger.log(`[DEBUG] Discord channel check failed, retrying... (${attempts + 1}/${maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return waitForDiscord(attempts + 1, maxAttempts);
            }
        };

        await validateTwitterConfig(runtime);
        elizaLogger.log(`[DEBUG] Twitter config validated`);

        // Attendre que Discord soit prêt
        // await waitForDiscord();
        elizaLogger.log(`[DEBUG] Discord client verified`);

        const discordChannelId = runtime.getSetting("DISCORD_CHANNEL_ID");
        const manager = new TwitterManager(
            runtime,
            runtime.clients.discord as DiscordInterface,
            discordChannelId
        );

        // Initialiser le client Twitter seulement après Discord
        await manager.client.init();
        elizaLogger.log(`[DEBUG] Twitter client initialized`);

        // Attendre 5 secondes avant de démarrer le monitor
        await new Promise(resolve => setTimeout(resolve, 5000));
        await manager.monitor.start();
        elizaLogger.log(`[DEBUG] Twitter monitor started`);

        return manager;
    },

    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("Twitter client does not support stopping yet");
    },
};