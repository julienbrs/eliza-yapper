import { SearchMode, Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateMessageResponse,
    Content,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    stringToUuid,
    elizaLogger,
} from "@elizaos/core";
import {  Client as DiscordJsClient, TextChannel, Message } from "discord.js";
import { ClientBase } from "./base";

// Template modifié pour générer UNE réponse unique
const twitterResponseTemplate =
`# Areas of Expertise
{{knowledge}}

# About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

{{providers}}

# Task: Generate THREE DISTINCT possible tweet reply to this tweet. Each reply should be unique in its approach, tone, and content while matching {{agentName}}'s personality.

Tweet to respond to:
ID: {{currentPost}}

Thread Context:
{{formattedConversation}}

IMPORTANT INSTRUCTIONS:
- Generate exactly 3 different replies in a single response
- Each reply should be 1-2 sentences maximum
- Each reply must be distinct in its approach
- Label them clearly as [reply 1], [reply 2], and [reply 3]
- Maintain {{agentName}}'s voice and character in each reply
- Focus on engagement and relevance
- Keep reply concise and Twitter-appropriate

Generate three replies now in a single response:`;

export class TwitterMonitoringClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    discordClient: DiscordJsClient;  // Actual Discord client
    isRunning: boolean = false;

    constructor(
        client: ClientBase,
        runtime: IAgentRuntime,
        discordClient: DiscordJsClient,
    ) {
        this.client = client;
        this.runtime = runtime;
        this.discordClient = discordClient;
    }

    async start() {
        elizaLogger.log("[DEBUG] Starting Twitter monitoring");
        this.isRunning = true;

        // Kick off the loop
        await this.monitoringLoop();
    }

    private async monitoringLoop() {
        if (!this.isRunning) {
            elizaLogger.log("[DEBUG] Monitoring stopped");
            return;
        }

        try {
            await this.monitorTargetUsers();
        } catch (error) {
            elizaLogger.error("[DEBUG] Error in monitoring loop:", error);
        }

        // Schedule the next run
        if (this.isRunning) {
            setTimeout(
                () => this.monitoringLoop(),
                Number(this.runtime.getSetting("TWITTER_POLL_INTERVAL") || 120) * 1000
            );
        }
    }

    stop() {
        elizaLogger.log("[DEBUG] Stopping Twitter monitoring");
        this.isRunning = false;
    }

    /**
     * Main logic to fetch new tweets from each target user.
     */
    private async monitorTargetUsers() {
        elizaLogger.log("Starting Twitter monitoring cycle");

        const targetUsersStr = this.runtime.getSetting("TWITTER_TARGET_USERS");
        if (!targetUsersStr?.trim()) {
            elizaLogger.log("No target users configured");
            return;
        }

        const TARGET_USERS = targetUsersStr
            .split(",")
            .map(u => u.trim())
            .filter(u => u.length > 0);

        elizaLogger.log("Processing target users:", TARGET_USERS);

        for (const username of TARGET_USERS) {
            try {
                const latestTweet = await this.fetchNewTweets(username);

                if (latestTweet) {
                    elizaLogger.log(
                        `Processing latest tweet from ${username}:`,
                        { id: latestTweet.id, text: latestTweet.text }
                    );

                    await this.processTweetForDiscord(latestTweet);
                } else {
                    elizaLogger.log(`No new tweets to process for ${username}`);
                }
            } catch (error) {
                elizaLogger.error(`Error processing user ${username}:`, error);
            }
        }

        elizaLogger.log("Monitoring cycle completed");
    }

    /**
     * Grab the latest tweet from a user, checking if it's new.
     */
    private async fetchNewTweets(username: string): Promise<Tweet | null> {
        elizaLogger.log(`[DEBUG] Fetching new tweets for ${username}`);

        const userTweets = (
            await this.client.twitterClient.fetchSearchTweets(
                `from:${username}`,
                1,
                SearchMode.Latest
            )
        ).tweets;

        elizaLogger.log(`[DEBUG] Raw tweets fetched for ${username}:`, userTweets);

        if (userTweets.length === 0) {
            elizaLogger.log(`[DEBUG] No tweets found for ${username}`);
            return null;
        }

        const latestTweet = userTweets[0];

        // Filter if we've seen it
        if (
            this.client.lastCheckedTweetId &&
            BigInt(latestTweet.id) <= this.client.lastCheckedTweetId
        ) {
            elizaLogger.log(
                `[DEBUG] Tweet ${latestTweet.id} is already processed or older`
            );
            return null;
        }

        // Skip replies/retweets
        if (latestTweet.isReply || latestTweet.isRetweet) {
            elizaLogger.log(`[DEBUG] Tweet ${latestTweet.id} skipped: is reply or retweet`);
            return null;
        }

        return latestTweet;
    }

    /**
     * Summarize + Generate LLM responses from the tweet
     */
    private async generateMultipleResponses(state: State): Promise<string[]> {
        elizaLogger.log(`[DEBUG] Starting response generation...`);

        const context = composeContext({
            state,
            template: twitterResponseTemplate,
        });

        elizaLogger.log(`[DEBUG] Generated context:`, context);

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        elizaLogger.log(`[DEBUG] Raw LLM response:`, response.text);

        // Example: If you split by markers or just want one
        // Adjust this for your own format
        const responses = response.text
            .split(/\[Reply \d+\]/i)
            .map(str => str.trim())
            .filter(Boolean);

        elizaLogger.log(`[DEBUG] Extracted responses:`, responses);
        return responses;
    }

    /**
     * Actually do the "post to Discord" + "create thread" + "send replies" steps.
     */
    private async processTweetForDiscord(tweet: Tweet) {
        try {
            // STEP A: Prepare memory for state
            const memory: Memory = {
                content: { text: tweet.text },
                agentId: this.runtime.agentId,
                userId: stringToUuid(tweet.userId!),
                roomId: stringToUuid(tweet.conversationId),
            };

            // Compose state
            const state = await this.runtime.composeState(memory, {
                currentPost: `${tweet.username}: ${tweet.text}`,
                formattedConversation: tweet.text,
            });

            // Generate replies
            const responses = await this.generateMultipleResponses(state);

            // B: Post the original tweet as an embed
            const embed = {
                color: 0x1da1f2,
                title: `Tweet from @${tweet.username}`,
                url: tweet.permanentUrl,
                description: tweet.text,
                footer: { text: `Tweet ID: ${tweet.id}` },
            };

            // C: Grab the text channel
            const channelId = this.runtime.getSetting("DISCORD_CHANNEL_ID");
            const channel = await this.discordClient.channels.fetch(channelId);
            if (!channel?.isTextBased()) {
                elizaLogger.error("Channel is not text-based or not found!");
                return;
            }

            // D: Send the embed
            const sentMsg = await (channel as TextChannel).send({
                embeds: [embed],
            });

            // E: Create a thread
            const thread = await sentMsg.startThread({
                name: `Replies to Tweet ${tweet.id}`,
                autoArchiveDuration: 60, // 1 hour
            });

            // F: Send each reply in the thread
            for (let i = 0; i < responses.length; i++) {
                // e.g. label them
                await thread.send(`**Reply ${i + 1}:** ${responses[i]}`);
            }

            // G: Mark tweet as processed
            this.client.lastCheckedTweetId = BigInt(tweet.id);
            elizaLogger.log(`[DEBUG] Done handling tweet ${tweet.id}.`);
        } catch (error) {
            elizaLogger.error("[DEBUG] Error in processTweetForDiscord:", error);
            throw error;
        }
    }
}
