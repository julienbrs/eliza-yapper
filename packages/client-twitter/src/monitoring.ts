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
import { EmbedBuilder } from "discord.js";
import { ClientBase } from "./base";

interface DiscordService {
    sendToDiscord: (content: any) => Promise<unknown>;
}
// Template modifié pour générer UNE réponse unique
const twitterResponseTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

{{providers}}

# Task: Generate ONE unique and engaging tweet reply to this tweet. The reply should match {{agentName}}'s personality and be concise while staying relevant.

Tweet to respond to:
ID: {{currentPost}}

Thread Context:
{{formattedConversation}}

IMPORTANT INSTRUCTIONS:
- Generate exactly ONE reply in a single response
- The reply should be concise and Twitter-appropriate (1-2 sentences maximum)
- Maintain {{agentName}}'s voice and character
- Focus on engagement and relevance

Generate the reply now:`;

export class TwitterMonitoringClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    discordService: DiscordService;
    isRunning: boolean = false;

    constructor(client: ClientBase, runtime: IAgentRuntime, discordService: DiscordService) {
        this.client = client;
        this.runtime = runtime;
        this.discordService = discordService;
    }

    async start() {
        elizaLogger.log(`[DEBUG] Starting Twitter monitoring`);
        this.isRunning = true;

        const monitoringLoop = async () => {
            if (!this.isRunning) {
                elizaLogger.log(`[DEBUG] Monitoring stopped`);
                return;
            }

            try {
                await this.monitorTargetUsers();
            } catch (error) {
                elizaLogger.error(`[DEBUG] Error in monitoring loop:`, error);
            }

            // Planifier la prochaine exécution
            if (this.isRunning) {
                setTimeout(
                    monitoringLoop,
                    Number(this.runtime.getSetting("TWITTER_POLL_INTERVAL") || 120) * 1000
                );
            }
        };

        // Démarrer le premier cycle
        await monitoringLoop();
    }

    stop() {
        elizaLogger.log(`[DEBUG] Stopping Twitter monitoring`);
        this.isRunning = false;
    }

    private async fetchNewTweets(username: string): Promise<Tweet | null> {
        elizaLogger.log(`[DEBUG] Fetching new tweets for ${username}`);

        try {
            const userTweets = (await this.client.twitterClient.fetchSearchTweets(
                `from:${username}`,
                1,
                SearchMode.Latest
            )).tweets;

            elizaLogger.log(`[DEBUG] Raw tweets fetched for ${username}:`, userTweets);

            if (userTweets.length === 0) {
                elizaLogger.log(`[DEBUG] No tweets found for ${username}`);
                return null;
            }

            const latestTweet = userTweets[0];

              // Vérifier l’ID pour éviter de retraiter le même tweet
            if (this.client.lastCheckedTweetId
                && BigInt(latestTweet.id) <= this.client.lastCheckedTweetId) {
            elizaLogger.log(`[DEBUG] Tweet ${latestTweet.id} is already processed or older`);
            return null;
            }

            elizaLogger.log(`[DEBUG] Processing tweet:`, {
                id: latestTweet.id,
                text: latestTweet.text,
                isReply: latestTweet.isReply,
                isRetweet: latestTweet.isRetweet
            });

            // Log l'état actuel du lastCheckedTweetId
            elizaLogger.log(`[DEBUG] Current lastCheckedTweetId:`, this.client.lastCheckedTweetId);

            if (latestTweet.isReply || latestTweet.isRetweet) {
                elizaLogger.log(`[DEBUG] Tweet ${latestTweet.id} skipped: is reply or retweet`);
                return null;
            }

            return latestTweet;
        } catch (error) {
            elizaLogger.error(`[DEBUG] Error fetching tweets for ${username}:`, error);
            throw error;
        }
    }

    private async generateMultipleResponses(tweet: Tweet, state: State): Promise<string[]> {
        elizaLogger.log(`[DEBUG] Starting response generation for tweet:`, {
            id: tweet.id,
            text: tweet.text
        });

        try {
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

            const responses = response.text
                .split(/\[Response \d\]/i)
                .filter(text => text.trim() !== "")
                .map(text => text.trim())
                .slice(0, 3);

            elizaLogger.log(`[DEBUG] Extracted responses:`, responses);
            return responses;
        } catch (error) {
            elizaLogger.error(`[DEBUG] Error generating responses:`, error);
            throw error;
        }
    }

    private async sendToDiscord(tweet: Tweet, responseProposals: string[]) {
        elizaLogger.log(`[DEBUG] Preparing Discord message for tweet:`, {
            id: tweet.id,
            username: tweet.username,
            numResponses: responseProposals.length
        });

        const embed = {
            color: 0x1DA1F2,
            title: `Tweet from @${tweet.username}`,
            url: tweet.permanentUrl,
            description: tweet.text,
            fields: [
                {
                    name: 'Time',
                    value: new Date(tweet.timestamp * 1000).toLocaleString(),
                    inline: true
                },
                {
                    name: '\u200B',
                    value: '\u200B',
                    inline: true
                },
                {
                    name: 'Proposed Responses',
                    value: responseProposals.map((response, idx) =>
                        `**${idx + 1}.** ${response}`
                    ).join('\n\n')
                }
            ],
            footer: { text: `Tweet ID: ${tweet.id}` }
        };

        try {
            elizaLogger.log(`[DEBUG] Created Discord embed:`, embed);

            const result = await this.discordService.sendToDiscord({ embeds: [embed] });
            elizaLogger.log(`[DEBUG] Discord message sent, result:`, result);

        } catch (error) {
            elizaLogger.error(`[DEBUG] Error sending to Discord:`, error);
            elizaLogger.error(`[DEBUG] Failed Discord embed:`, embed);
            throw error;
        }
    }

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
                // Récupérer le dernier tweet non traité
                const latestTweet = await this.fetchNewTweets(username);

                if (latestTweet) {
                    elizaLogger.log(`Processing latest tweet from ${username}:`, {
                        id: latestTweet.id,
                        text: latestTweet.text
                    });

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

    private async processTweetForDiscord(tweet: Tweet) {
        elizaLogger.log(`[DEBUG] Starting processTweetForDiscord for tweet:`, {
            id: tweet.id,
            text: tweet.text
        });

        try {
            const message: Memory = {
                content: { text: tweet.text },
                agentId: this.runtime.agentId,
                userId: stringToUuid(tweet.userId!),
                roomId: stringToUuid(tweet.conversationId),
            };

            elizaLogger.log(`[DEBUG] Created memory object`);

            const state = await this.runtime.composeState(message, {
                currentPost: `${tweet.username}: ${tweet.text}`,
                formattedConversation: tweet.text
            });

            elizaLogger.log(`[DEBUG] State composed`);

            const responses = await this.generateMultipleResponses(tweet, state);
            elizaLogger.log(`[DEBUG] Generated ${responses.length} responses`);

            await this.sendToDiscord(tweet, responses);
            elizaLogger.log(`[DEBUG] Responses sent to Discord`);

            this.client.lastCheckedTweetId = BigInt(tweet.id);
            elizaLogger.log(`[DEBUG] Updated lastCheckedTweetId to:`, this.client.lastCheckedTweetId);

        } catch (error) {
            elizaLogger.error(`[DEBUG] Error in processTweetForDiscord:`, error);
            throw error;
        }
    }
}