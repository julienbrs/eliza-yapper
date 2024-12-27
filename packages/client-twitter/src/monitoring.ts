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

        const REPLY_LIMIT = 5; // Max replies in a time window
        const TIME_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
        const COOLDOWN_AFTER_TWO = 2 * 60 * 1000; // 2 minutes cooldown

        let replyCount = 0;
        let processedCount = 0; // Track the number of replies since the last cooldown
        let startTime = Date.now();

        const targetUsersStr = this.runtime.getSetting("TWITTER_TARGET_USERS") || "";
        const allUsers = targetUsersStr.split(",").map((u) => u.trim()).filter(Boolean);

        while (this.isRunning) {
            // Reset the counter if the time window has passed
            if (Date.now() - startTime > TIME_WINDOW_MS) {
                replyCount = 0;
                processedCount = 0;
                startTime = Date.now();
            }

            // If we have reached the reply limit, wait until the next time window
            if (replyCount >= REPLY_LIMIT) {
                const waitTime = Math.max(0, TIME_WINDOW_MS - (Date.now() - startTime));
                elizaLogger.log(
                    `[DEBUG] Reply limit reached. Waiting for ${Math.ceil(
                        waitTime / 1000
                    )} seconds before resuming.`
                );
                await new Promise((resolve) => setTimeout(resolve, waitTime));
                continue;
            }

            // Select a random user
            const randomIndex = Math.floor(Math.random() * allUsers.length);
            const username = allUsers[randomIndex];

            try {
                const tweet = await this.fetchNewestOriginalTweet(username);

                if (tweet) {
                    elizaLogger.log(
                        `Processing latest original tweet from ${username}:`,
                        { id: tweet.id, text: tweet.text }
                    );

                    await this.processTweetForDiscord(tweet);
                    replyCount++; // Increment the reply count
                    processedCount++; // Increment the count for cooldown
                } else {
                    elizaLogger.log(`No new original tweets to process for ${username}`);
                }
            } catch (error) {
                elizaLogger.error(`Error processing user ${username}:`, error);
            }

            // Cooldown every two replies
            if (processedCount >= 2) {
                elizaLogger.log(`[DEBUG] Cooldown: Waiting for 2 minutes after processing 2 replies.`);
                await new Promise((resolve) => setTimeout(resolve, COOLDOWN_AFTER_TWO));
                processedCount = 0; // Reset the cooldown counter
            }

            // Short delay between checks to avoid overwhelming the API
            await new Promise((resolve) => setTimeout(resolve, 1000));
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
            let quotedTweetContent = null;

            // Si le tweet est un quote tweet, récupérer le contenu du tweet cité
            if (tweet.isQuoted && tweet.quotedStatusId) {
                try {
                    elizaLogger.log(`[DEBUG] Fetching quoted tweet for ${tweet.id}`);

                    // Fetch the quoted tweet using its ID
                    const quotedTweet = await this.client.twitterClient.getTweet(tweet.quotedStatusId);

                    if (quotedTweet) {
                        elizaLogger.log(`[DEBUG] Successfully fetched quoted tweet:`, quotedTweet);

                        // Add quoted tweet context to the current tweet processing
                        const quotedTweetContent = `${quotedTweet.username}: ${quotedTweet.text}`;

                        // Include the quoted tweet content in the LLM prompt
                        tweet.text += `\n\nQuoted Tweet Context: ${quotedTweetContent}`;
                    } else {
                        elizaLogger.warn(`[DEBUG] Quoted tweet not found for ${tweet.id}`);
                    }
                } catch (error) {
                    elizaLogger.error(`[DEBUG] Error fetching quoted tweet for ${tweet.id}:`, error);
                }
            }

            // Préparer la mémoire pour l'état
            const memory: Memory = {
                content: { text: tweet.text },
                agentId: this.runtime.agentId,
                userId: stringToUuid(tweet.userId!),
                roomId: stringToUuid(tweet.conversationId),
            };

            // Composer l'état avec ou sans le contexte du tweet cité
            const state = await this.runtime.composeState(memory, {
                currentPost: `${tweet.username}: ${tweet.text}`,
                formattedConversation: quotedTweetContent
                    ? `Quoted Tweet: ${quotedTweetContent}\nOriginal Tweet: ${tweet.text}`
                    : tweet.text,
            });

            // Générer des réponses
            const responses = await this.generateMultipleResponses(state);

            // Poster le tweet original en embed sur Discord
            const embed = {
                color: 0x1da1f2,
                title: `Tweet from @${tweet.username}`,
                url: tweet.permanentUrl,
                description: tweet.text,
                footer: { text: `Tweet ID: ${tweet.id}` },
            };

            // Ajouter le contenu du tweet cité dans l'embed si présent
            if (quotedTweetContent) {
                embed.description += `\n\n**Quoted Tweet:**\n${quotedTweetContent}`;
            }

            // Récupérer le canal Discord
            const channelId = this.runtime.getSetting("DISCORD_CHANNEL_ID");
            const channel = await this.discordClient.channels.fetch(channelId);
            if (!channel?.isTextBased()) {
                elizaLogger.error("Channel is not text-based or not found!");
                return;
            }

            // Envoyer l'embed
            const sentMsg = await (channel as TextChannel).send({
                embeds: [embed],
            });

            // Créer un thread pour les réponses
            const thread = await sentMsg.startThread({
                name: `Replies to Tweet ${tweet.id}`,
                autoArchiveDuration: 60, // 1 heure
            });

            // Envoyer chaque réponse dans le thread
            for (let i = 0; i < responses.length; i++) {
                await thread.send(`**Reply ${i + 1}:** ${responses[i]}`);
            }

            // Marquer le tweet comme traité
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
