// file: client-twitter/src/index.ts

import { Client as ElizaClient, elizaLogger, IAgentRuntime } from "@elizaos/core";
import { DiscordClient } from "@elizaos/client-discord";
import { Client as DiscordJsClient } from "discord.js";
import { validateTwitterConfig } from "./environment.ts";
import { ClientBase } from "./base.ts";
import { TwitterMonitoringClient } from "./monitoring.ts";
import { TwitterSearchClient } from "./search.ts";

class TwitterManager {
    client: ClientBase;
    monitor: TwitterMonitoringClient;
    search: TwitterSearchClient;

    constructor(
        runtime: IAgentRuntime,
        discordJsClient: DiscordJsClient,
        discordChannelId: string
    ) {
        elizaLogger.log(`[DEBUG] Creating TwitterManager with discordChannelId: ${discordChannelId}`);

        // 1) Initialize the internal Twitter base client
        this.client = new ClientBase(runtime);
        elizaLogger.log(`[DEBUG] Created ClientBase`);

        // 2) Create the TwitterMonitoringClient
        //    Pass the real discord.js client for advanced logic (threads, multiple sends, etc.)
        this.monitor = new TwitterMonitoringClient(
            this.client,
            runtime,
            discordJsClient
        );
        elizaLogger.log(`[DEBUG] Created TwitterMonitoringClient`);

        // 3) (Optional) Create the search client if needed
        this.search = new TwitterSearchClient(this.client, runtime);
        elizaLogger.log(`[DEBUG] Created TwitterSearchClient`);
    }

    async init() {
        elizaLogger.log(`[DEBUG] Initializing TwitterManager`);
        try {
            // 1) Initialize the Twitter base client
            await this.client.init();
            elizaLogger.log(`[DEBUG] Twitter client initialized`);

            // 2) Start the monitoring loop
            await this.monitor.start();
            elizaLogger.log(`[DEBUG] Twitter monitor started`);
        } catch (error) {
            elizaLogger.error(`[DEBUG] Error in TwitterManager init:`, error);
            throw error;
        }
    }
}

/**
 * The exported interface for starting/stopping the Twitter client in Eliza.
 */
export const TwitterClientInterface: ElizaClient = {
    async start(runtime: IAgentRuntime) {
        elizaLogger.log(`[DEBUG] Starting Twitter client`);

        // (Optional) If you want to wait for Discord to be 100% ready, you can do it here
        // e.g. check channel access. We'll skip or comment it out for brevity:
        /*
        const waitForDiscord = async (attempts = 0, maxAttempts = 3): Promise<void> => {
            // ...
        };
        // await waitForDiscord();
        */

        // Validate your Twitter config
        await validateTwitterConfig(runtime);
        elizaLogger.log(`[DEBUG] Twitter config validated`);

        // Check that DISCORD_CHANNEL_ID is set
        const discordChannelId = runtime.getSetting("DISCORD_CHANNEL_ID");
        if (!discordChannelId) {
            throw new Error("DISCORD_CHANNEL_ID must be set in environment");
        }
        elizaLogger.log(`[DEBUG] Discord client verified, channel ID = ${discordChannelId}`);

        // 1) Get the actual Discord.js client from the DiscordClient
        //    The "runtime.clients.discord" is an instance of your own `DiscordClient` class.
        //    We want the underlying discord.js client:
        const discordClient = runtime.clients.discord as DiscordClient;
        const realDiscordJsClient = discordClient.client;  // The actual discord.js "Client" instance

        // 2) Create the manager
        const manager = new TwitterManager(
            runtime,
            realDiscordJsClient,
            discordChannelId
        );

        // 3) Initialize the manager, which initializes the Twitter base client + monitoring
        await manager.init();

        // If you prefer to do a small delay before starting the monitor:
        //   await new Promise(resolve => setTimeout(resolve, 5000));
        //   await manager.monitor.start();

        return manager;
    },

    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("Twitter client does not support stopping yet");
    },
};
