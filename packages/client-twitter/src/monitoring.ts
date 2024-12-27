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

# Task: Generate THREE strategically different replies to maximize engagement. First reply should be controversial yet thoughtful, second highly technical, and third flexible/adaptable. Each must encourage response through questioning or provocation while maintaining {{agentName}}'s analytical, witty persona. Never use emojis or '—'.

Tweet to respond to:
ID: {{currentPost}}

Thread Context:
{{formattedConversation}}

IMPORTANT INSTRUCTIONS:
- Generate 3 distinct replies, clearly labeled
- Format: [reply 1] controversial but intelligent
- Format: [reply 2] deep technical analysis
- Format: [reply 3] adaptive (tech/controversial/supportive)
- Each reply should end with a question or provocation
- Include relevant tickers when natural ($KAITO, $BERA, etc)
- Keep under 240 characters
- Maintain dry wit and technical credibility
- Focus on triggering thoughtful responses
- Avoid emotional or exaggerated language

Your three strategic replies:"
}`;

export class TwitterMonitoringClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    discordClient: DiscordJsClient;  // Actual Discord client
    isRunning: boolean = false;
    private lastCheckedTweetIds: Record<string, bigint> = {};

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

        const targetUsersStr = this.runtime.getSetting("TWITTER_TARGET_USERS") || "";
        const users = targetUsersStr.split(",").map((u) => u.trim()).filter(Boolean);

        elizaLogger.log("Processing target users:", users);

        for (const username of users) {
            try {
                const tweet = await this.fetchNewestOriginalTweet(username);
                if (tweet) {
                    elizaLogger.log(
                        `Processing latest original tweet from ${username}:`,
                        { id: tweet.id, text: tweet.text }
                    );

                    await this.processTweetForDiscord(tweet);
                } else {
                    elizaLogger.log(
                        `No new original tweets to process for ${username}`
                    );
                }
            } catch (error) {
                elizaLogger.error(`Error processing user ${username}:`, error);
            }
        }

        elizaLogger.log("Monitoring cycle completed");
    }


/**
 * Fetch the newest *original* (non-reply, non-retweet) tweet for a user by paging back in time
 */
private async fetchNewestOriginalTweet(username: string): Promise<Tweet | null> {
    elizaLogger.log(
      `[DEBUG] fetchNewestOriginalTweet: Searching for an original tweet from ${username}`
    );

    const maxPages = 5;
    let pageCount = 0;
    let nextToken: string | undefined = undefined;

    while (pageCount < maxPages) {
        // Retrieve up to 10 tweets from the user’s timeline
        const { tweets, next, previous } = await this.client.twitterClient.fetchSearchTweets(
            `from:${username}`,
            10,
            SearchMode.Latest,
            nextToken
        );

        elizaLogger.log(`[DEBUG] Page #${pageCount + 1} of tweets for ${username}`, tweets);

        if (!tweets || tweets.length === 0) {
            elizaLogger.log("[DEBUG] No more tweets found, stopping.");
            break;
        }

        for (const tweet of tweets) {
            const userLastCheckedId = this.lastCheckedTweetIds[username];

            // Skip if older/equal to last processed
            if (userLastCheckedId && BigInt(tweet.id) <= userLastCheckedId) {
                elizaLogger.log(
                  `[DEBUG] Tweet ${tweet.id} is older/processed for ${username}, skipping.`
                );
                continue;
            }

            // Skip if it's a reply or retweet
            if (tweet.isReply || tweet.isRetweet) {
                elizaLogger.log(
                  `[DEBUG] Tweet ${tweet.id} is a reply or retweet; continuing search...`
                );
                continue;
            }

            // Now enforce your time + replies constraints:

            // 1) Compute how old the tweet is in seconds
            //    tweet.timestamp is presumably a Unix timestamp (seconds).
            const nowSec = Math.floor(Date.now() / 1000);
            const tweetAgeSec = nowSec - tweet.timestamp;

            // We'll define some time limits in seconds:
            const FIVE_MIN = 5 * 60;     // 300 sec
            const THREE_HOURS = 3 * 3600; // 10800 sec

            // 2) Check constraints:
            //   (a) If < 5 minutes old => OK
            //   (b) Else if < 3 hours AND replies < 15 => OK
            //   otherwise skip
            if (tweetAgeSec < FIVE_MIN) {
                // Tweet is younger than 5 minutes
                elizaLogger.log(`[DEBUG] Tweet ${tweet.id} is under 5 minutes old => ACCEPT`);
                return tweet;
            } else if (tweetAgeSec < THREE_HOURS && tweet.replies < 15) {
                // Tweet is younger than 3h and has fewer than 15 replies
                elizaLogger.log(
                  `[DEBUG] Tweet ${tweet.id} is under 3 hours old and <15 replies => ACCEPT`
                );
                return tweet;
            } else {
                // Otherwise skip
                elizaLogger.log(
                  `[DEBUG] Tweet ${tweet.id} fails the time+replies constraints => SKIP`
                );
                continue;
            }
        }

        // If we haven't returned a tweet yet in this page,
        // move to the 'older' page (the `next` token)
        if (next) {
            nextToken = next;
            pageCount++;
        } else {
            // no more pages
            break;
        }
    }

    elizaLogger.log(
      `[DEBUG] No acceptable original tweet found for ${username} within ${maxPages} pages.`
    );
    return null;
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
            this.lastCheckedTweetIds[tweet.username] = BigInt(tweet.id);
            elizaLogger.log(
            `[DEBUG] Done handling tweet ${tweet.id} for user ${tweet.username}.
            Updated lastCheckedTweetId to: ${tweet.id}`
            );
        } catch (error) {
            elizaLogger.error("[DEBUG] Error in processTweetForDiscord:", error);
            throw error;
        }
    }
}
