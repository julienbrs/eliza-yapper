import { SearchMode, Tweet } from 'agent-twitter-client';
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
} from '@elizaos/core';
import {
    Client as DiscordJsClient,
    TextChannel,
    Message,
    APIEmbed,
} from 'discord.js';
import { ClientBase } from './base';

const twitterResponseTemplate = `# areas of expertise
{{knowledge}}

# retrieved knowledge context:
{{relevantKnowledge}}

# about {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

{{providers}}

# task: generate three distinct replies that focus on relevance and authenticity while maintaining {{agentName}}'s tech-savvy voice. never use emojis.

tweet to respond to:
id: {{currentPost}}

thread context:
{{formattedConversation}}

response guidelines:
1. first reply:
- offer a different perspective or critical view
- stay constructive while challenging assumptions
- support view with relevant context
- end with a targeted question to op

2. second reply:
- keep it personal and relatable
- stay focused on tweet's specific topic
- use technical terms only when relevant
- question the content creator

3. third reply:
- focus on bullish potential and upside
- highlight promising metrics/developments
- stay grounded in facts while being optimistic
- point out competitive advantages
- maintain ainur's smart perspective even when bullish

key rules:
- adapt length to substance:
  * short for casual/vague/humor tweets
  * deeper for specific technical points
  * let content guide length
- questions should target op's thoughts
- avoid generic starter words like "interesting"
- talk like a young tech guy
- skip unnecessary transitions
- do not repeat the same words of the quoted tweets
- use tickers only when directly relevant
- use tech slang/abbrev sparingly and naturally
- keep it under 240 chars
- no emojis
- no caps unless in tickers

your three strategic replies:`;

const postGenerationTemplate = `# Latest Tweets Context
Here are the latest tweets from influential accounts, serving as inspiration:
{{latestTweets}}

# About Eclipse
Eclipse is a growing Web3 ecosystem that combines Ethereum’s liquidity with Solana’s speed. It empowers dApps through seamless composability, high transaction throughput, and low fees, all underpinned by robust technical architecture and a vibrant community.
Eclipse is on mainnet, turboTap is live for a few weeks.

Key Features of Eclipse:
- Solana Virtual Machine (SVM) Layer 2 with Ethereum settlement
- Focus on Application-Specific Sequencing (ASS) infrastructure
- Developer-friendly tools for fast dApp deployment
- Ecosystem includes DeFi platforms, NFT projects, and GameFi applications

Community Focus:
- Strong emphasis on grassroots involvement and creative expression
- Known for viral campaigns and unique application launches
- Core ethos: “Eclipse everything”

# About You:
You are a passionate member of the Eclipse community. You believe in its mission and have experienced the ecosystem's strengths firsthand. Your tweets should reflect your personal connection and insight, drawing readers into the ecosystem.

# Task:
Generate THREE tweets that demonstrate your involvement and enthusiasm for Eclipse ($ECLP). Focus on variety in length, with:
1. A longer, detailed tweet (300+ characters) that dives into an Eclipse feature or community story.
2. Two shorter tweets (under 150 characters each) that are punchy and engaging.

## Guidelines:
- Highlight your personal connection or perspective as part of the Eclipse community.
- You can compare L2 and Eclipse, but do not dunk too hard on L2s.
- Use the latest tweets as inspiration for tone and content, weaving in relevant trends.
- Stay authentic, engaging, and human. Speak like a real community member, not a marketer.
- Incorporate relevant metrics, examples, or anecdotes, but avoid overly technical jargon.
- Use the slogan "Eclipse everything" naturally and sparingly. No need for excessive branding.
- You can be a developer but you aren't owning a project on Eclipse neitheir building actively on Eclipse.
- You are on Eclipse mainnet for a few weeks now.

Generate the tweets now:`;

export class TwitterMonitoringClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    discordClient: DiscordJsClient; // Actual Discord client
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
        elizaLogger.log('[DEBUG] Starting Twitter monitoring');
        this.isRunning = true;

        if (process.env.CREATE_POST === 'true') {
            elizaLogger.log('CREATE_POST true');
            await this.postGenerationLoop();
        } else {
            elizaLogger.log('REPLY_MODE true');
            await this.replyMonitoringLoop();
        }
    }

    /**
     * postGenerationLoop:
     *  - Gathers context
     *  - Composes a state
     *  - Generates post proposals
     *  - Sends them as separate Discord messages
     */
    private async postGenerationLoop() {
        elizaLogger.success('Starting post generation monitoring');
        while (this.isRunning) {
            try {
                // gather context from accounts
                const latestTweetsContext =
                    await this.gatherContextFromAccounts();
                elizaLogger.success(
                    'gathered context from accounts:',
                    latestTweetsContext,
                );

                const memory: Memory = {
                    content: { text: latestTweetsContext },
                    agentId: this.runtime.agentId,
                    userId: stringToUuid('some-unique-user'),
                    roomId: stringToUuid('GLOBAL_KNOWLEDGE_ROOM'),
                };

                const state = await this.runtime.composeState(memory, {
                    latestTweets: latestTweetsContext,
                });

                const proposals = await this.generatePostProposals(state);
                elizaLogger.success('generated post proposals:', proposals);

                const channelId = this.runtime.getSetting('DISCORD_CHANNEL_ID');
                const channel =
                    await this.discordClient.channels.fetch(channelId);

                if (channel?.isTextBased()) {
                    // Post an initial embed
                    await (channel as TextChannel).send({
                        embeds: [
                            {
                                title: 'Proposed Eclipse Tweets',
                                description:
                                    'Generated based on latest crypto influencer tweets',
                                color: 0x1da1f2,
                                footer: { text: 'Generated by Eclipse Bot' },
                            },
                        ],
                    });
                    // Then each proposal in separate messages
                    for (let i = 0; i < proposals.length; i++) {
                        await (channel as TextChannel).send(
                            `**Tweet Proposal ${i + 1}:**\n${proposals[i]}`,
                        );
                    }
                }

                // Wait 6 hours
                await new Promise((resolve) =>
                    setTimeout(resolve, 6 * 60 * 60 * 1000),
                );
            } catch (error) {
                elizaLogger.error('[DEBUG] Error in post generation cycle:', {
                    message:
                        error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    error,
                });
            }
        }
    }

    private async replyMonitoringLoop() {
        elizaLogger.log('[DEBUG] Starting reply monitoring mode');

        // Normal user constraints
        const REPLY_LIMIT = process.env.REPLY_LIMIT || 10;
        const TIME_WINDOW_MS = process.env.TIME_WINDOW_MS || 30 * 60 * 1000;
        const COOLDOWN_AFTER_TWO =
            process.env.COOLDOWN_AFTER_TWO || 2 * 60 * 1000;

        let replyCount = 0;
        let processedCount = 0;
        let startTime = Date.now();

        // Priority users
        const priorityStr = process.env.TARGET_PRIORITY_USERS || '';
        const priorityUsers = priorityStr
            .split(',')
            .map((u) => u.trim())
            .filter(Boolean);

        // Regular users
        const normalStr = process.env.TWITTER_TARGET_USERS || '';
        const normalUsers = normalStr
            .split(',')
            .map((u) => u.trim())
            .filter(Boolean);

        while (this.isRunning) {
            try {
                // handle priority users first - no cooldown, no limit
                for (const username of priorityUsers) {
                    elizaLogger.log(
                        `[DEBUG] Checking priority user: ${username}`,
                    );
                    const tweet = await this.fetchNewestOriginalTweet(username);
                    if (tweet) {
                        elizaLogger.log(
                            `[DEBUG] Found new tweet from priority user ${username}: ${tweet.id}`,
                        );
                        await this.processTweetForDiscord(tweet);
                    }
                    // no wait or limit for priority
                }

                // now handle normal users with existing constraints
                // reset counters if the time window has passed
                if (Date.now() - startTime > TIME_WINDOW_MS) {
                    replyCount = 0;
                    processedCount = 0;
                    startTime = Date.now();
                    elizaLogger.log(
                        '[DEBUG] Reset counters for new time window',
                    );
                }

                if (replyCount >= REPLY_LIMIT) {
                    const waitTime = Math.max(
                        0,
                        TIME_WINDOW_MS - (Date.now() - startTime),
                    );
                    const nextResumeTime = new Date(Date.now() + waitTime);
                    elizaLogger.info(
                        `[INFO] Reply limit reached (${replyCount}/${REPLY_LIMIT}). Pausing until ${nextResumeTime.toLocaleTimeString()}.`,
                    );
                    await new Promise((resolve) =>
                        setTimeout(resolve, waitTime),
                    );
                    continue;
                }

                // pick a random normal user
                if (normalUsers.length > 0) {
                    const randomIndex = Math.floor(
                        Math.random() * normalUsers.length,
                    );
                    const username = normalUsers[randomIndex];
                    elizaLogger.log(
                        `[DEBUG] Selected random normal user: ${username}`,
                    );

                    const tweet = await this.fetchNewestOriginalTweet(username);
                    if (tweet) {
                        await this.processTweetForDiscord(tweet);
                        replyCount++;
                        processedCount++;
                        elizaLogger.log(
                            `[DEBUG] Processed tweet. Reply count: ${replyCount}, Processed count: ${processedCount}`,
                        );
                    }

                    // handle the cooldown after every two tweets
                    if (processedCount >= 2) {
                        const nextCooldownResume = new Date(
                            Date.now() + COOLDOWN_AFTER_TWO,
                        );
                        elizaLogger.info(
                            `[INFO] Cooldown activated after ${processedCount} tweets. Resuming at ${nextCooldownResume.toLocaleTimeString()}.`,
                        );
                        await new Promise((resolve) =>
                            setTimeout(resolve, COOLDOWN_AFTER_TWO),
                        );
                        processedCount = 0;
                    }
                }

                // short delay between checks
                await new Promise((resolve) => setTimeout(resolve, 1000));
            } catch (error) {
                elizaLogger.error(
                    '[DEBUG] Error in reply monitoring loop:',
                    error,
                );
                // small delay in case of error
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }

    stop() {
        elizaLogger.log('[DEBUG] Stopping Twitter monitoring');
        this.isRunning = false;
    }

    /**
     * Main logic to fetch new tweets from each target user.
     */
    private async monitorTargetUsers() {
        elizaLogger.log('Starting Twitter monitoring cycle');

        const targetUsersStr =
            this.runtime.getSetting('TWITTER_TARGET_USERS') || '';
        const users = targetUsersStr
            .split(',')
            .map((u) => u.trim())
            .filter(Boolean);

        elizaLogger.log('Processing target users:', users);

        for (const username of users) {
            try {
                const tweet = await this.fetchNewestOriginalTweet(username);
                if (tweet) {
                    elizaLogger.log(
                        `Processing latest original tweet from ${username}:`,
                        { id: tweet.id, text: tweet.text },
                    );

                    await this.processTweetForDiscord(tweet);
                } else {
                    elizaLogger.log(
                        `No new original tweets to process for ${username}`,
                    );
                }
            } catch (error) {
                elizaLogger.error(`Error processing user ${username}:`, error);
            }
        }

        elizaLogger.log('Monitoring cycle completed');
    }

    private async gatherContextFromAccounts() {
        // We'll pick 15 random from TWITTER_TARGET_USERS for the "CREATE_POST" context
        const allUsersStr = process.env.TWITTER_TARGET_USERS || '';
        const allUsers = allUsersStr
            .split(',')
            .map((u) => u.trim())
            .filter(Boolean);

        const selected = allUsers.sort(() => Math.random() - 0.5).slice(0, 15);

        elizaLogger.log('[DEBUG] Selected 15 random accounts:', selected);

        const latestTweets: string[] = [];

        for (const username of selected) {
            try {
                const tweet = await this.fetchNewestOriginalTweet(username);
                if (tweet) {
                    latestTweets.push(`@${tweet.username}: ${tweet.text}`);
                }
            } catch (error) {
                elizaLogger.error(
                    `Error fetching tweet from ${username}:`,
                    error,
                );
            }
        }

        return latestTweets.join('\n\n');
    }

    private async generatePostProposals(state: State): Promise<string[]> {
        elizaLogger.log(`[DEBUG] Starting post generation...`);

        const context = composeContext({
            state,
            template: postGenerationTemplate,
        });

        elizaLogger.success('context:', context);

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        elizaLogger.log(`[DEBUG] Raw LLM response:`, response.text);

        // Extraire les trois tweets générés
        const proposals = response.text
            .split(/\d\.\s+/g)
            .filter((text) => text.trim())
            .map((text) => text.trim());

        return proposals;
    }

    /**
     * Fetch the newest *original* (non-reply, non-retweet) tweet for a user by paging back in time
     */
    /**
     * Example of different constraints for "CREATE_POST" mode:
     *  - Tweet must have >= Min likes
     *  - Tweet must be <= 3 days old
     */
    private async fetchNewestOriginalTweet(
        username: string,
    ): Promise<Tweet | null> {
        elizaLogger.log(
            `[DEBUG] fetchNewestOriginalTweet for user ${username}`,
        );

        const isCreatePost = process.env.CREATE_POST === 'true';
        const maxPages = 5;
        let pageCount = 0;
        let nextToken: string | undefined;

        while (pageCount < maxPages) {
            const { tweets, next } =
                await this.client.twitterClient.fetchSearchTweets(
                    `from:${username}`,
                    10,
                    SearchMode.Latest,
                    nextToken,
                );

            if (!tweets || tweets.length === 0) break;

            for (const tweet of tweets) {
                const userLastCheckedId = this.lastCheckedTweetIds[username];
                if (
                    userLastCheckedId &&
                    BigInt(tweet.id) <= userLastCheckedId
                ) {
                    continue;
                }
                if (tweet.isReply || tweet.isRetweet) continue;

                const nowSec = Math.floor(Date.now() / 1000);
                const tweetAgeSec = nowSec - tweet.timestamp;

                if (isCreatePost) {
                    // e.g. 3 days old, 30 likes
                    const THREE_DAYS = 3 * 24 * 3600;
                    if (tweetAgeSec <= THREE_DAYS && tweet.likes >= 30) {
                        elizaLogger.log(
                            `[DEBUG] ACCEPT tweet ${tweet.id} (≥30 likes, <3 days old)`,
                        );
                        return tweet;
                    }
                } else {
                    // your existing constraints
                    const FIVE_MIN = 5 * 60;
                    const THREE_HOURS = 3 * 3600;
                    if (tweetAgeSec < FIVE_MIN) {
                        elizaLogger.log(
                            `[DEBUG] ACCEPT tweet ${tweet.id} (<5min)`,
                        );
                        return tweet;
                    } else if (
                        tweetAgeSec < THREE_HOURS &&
                        tweet.replies < 15
                    ) {
                        elizaLogger.log(
                            `[DEBUG] ACCEPT tweet ${tweet.id} (<3h & <15 replies)`,
                        );
                        return tweet;
                    }
                }
            }

            if (next) {
                nextToken = next;
                pageCount++;
            } else break;
        }

        elizaLogger.log(`[DEBUG] No acceptable tweet found for ${username}`);
        return null;
    }

    /**
     * Summarize + Generate LLM responses from the tweet
     */
    /**
     * Simule ou effectue les appels au LLM en fonction de la configuration
     */
    private async generateMultipleResponses(state: State): Promise<string[]> {
        elizaLogger.log('[DEBUG] Starting response generation...');
        const context = composeContext({
            state,
            template: twitterResponseTemplate,
        });
        elizaLogger.info('[DEBUG] Generated context:', context);

        const enableLLMRequests = process.env.ENABLE_LLM_REQUESTS === 'true';
        if (!enableLLMRequests) {
            const tokenEstimate = context.length;
            elizaLogger.info(
                `[SIMULATION] Context (est. ${tokenEstimate} tokens):`,
                context,
            );
            return [
                '[Reply 1] Simulated controversial reply.',
                '[Reply 2] Simulated technical reply.',
                '[Reply 3] Simulated adaptive reply.',
            ];
        }

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        elizaLogger.log('[DEBUG] Raw LLM response:', response.text);

        return response.text
            .split(/\[Reply \d+\]/i)
            .map((s) => s.trim())
            .filter(Boolean);
    }

    /**
     * Actually do the "post to Discord" + "create thread" + "send replies" steps.
     */
    private async processTweetForDiscord(tweet: Tweet) {
        try {
            let quotedTweetContent: string | null = null;

            if (tweet.isQuoted && tweet.quotedStatusId) {
                try {
                    const quotedTweet =
                        await this.client.twitterClient.getTweet(
                            tweet.quotedStatusId,
                        );
                    if (quotedTweet) {
                        quotedTweetContent = `${quotedTweet.username}: ${quotedTweet.text}`;
                        tweet.text += `\n\nQuoted Tweet Context: ${quotedTweetContent}`;
                    }
                } catch (error) {
                    elizaLogger.error(
                        `[DEBUG] Error fetching quoted tweet for ${tweet.id}:`,
                        error,
                    );
                }
            }

            const memory: Memory = {
                content: { text: tweet.text },
                agentId: this.runtime.agentId,
                userId: stringToUuid(tweet.userId!),
                roomId: stringToUuid(tweet.conversationId),
            };

            const state = await this.runtime.composeState(memory, {
                currentPost: `${tweet.username}: ${tweet.text}`,
                formattedConversation: quotedTweetContent
                    ? `Quoted Tweet: ${quotedTweetContent}\nOriginal Tweet: ${tweet.text}`
                    : tweet.text,
            });

            // We generate 3 replies
            const responses = await this.generateMultipleResponses(state);

            // Post original tweet as embed
            const embed: APIEmbed = {
                color: 0x1da1f2,
                title: `Tweet from @${tweet.username}`,
                url: tweet.permanentUrl,
                description: tweet.text,
                timestamp: new Date().toISOString(),
                footer: { text: `Tweet ID: ${tweet.id}` },
            };

            if (quotedTweetContent) {
                embed.fields = [
                    {
                        name: 'Quoted Tweet',
                        value: quotedTweetContent,
                        inline: false,
                    },
                ];
            }

            const channelId = this.runtime.getSetting('DISCORD_CHANNEL_ID');
            const channel = await this.discordClient.channels.fetch(channelId);
            if (!channel?.isTextBased()) {
                elizaLogger.error('Channel is not text-based or not found!');
                return;
            }

            const sentMsg = await (channel as TextChannel).send({
                embeds: [embed],
            });
            const thread = await sentMsg.startThread({
                name: `Replies to Tweet ${tweet.id}`,
                autoArchiveDuration: 60,
            });

            // Send each reply in the thread
            for (let i = 0; i < responses.length; i++) {
                await thread.send(`**Reply ${i + 1}:** ${responses[i]}`);
            }

            this.lastCheckedTweetIds[tweet.username] = BigInt(tweet.id);
            elizaLogger.log(
                `[DEBUG] Done handling tweet ${tweet.id} for user ${tweet.username}.`,
            );
        } catch (error) {
            elizaLogger.error(
                '[DEBUG] Error in processTweetForDiscord:',
                error,
            );
            throw error;
        }
    }
}
