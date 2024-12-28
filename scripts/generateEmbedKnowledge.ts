import fs from "fs/promises";
import path from "path";
import { embed, IAgentRuntime, IDatabaseAdapter, IDatabaseCacheAdapter } from "@elizaos/core"; // Ensure `embed` function is available from the core

export async function embedKnowledge(
    runtime: IAgentRuntime,
    db: IDatabaseAdapter & IDatabaseCacheAdapter,
    knowledgeDirectory: string
) {
    try {
        const files = await fs.readdir(knowledgeDirectory, { withFileTypes: true });

        for (const file of files) {
            if (file.isDirectory()) {
                await embedKnowledge(runtime, db, path.join(knowledgeDirectory, file.name));
            } else if (file.name.endsWith(".json")) {
                const filePath = path.join(knowledgeDirectory, file.name);
                const fileContent = await fs.readFile(filePath, "utf-8");
                const knowledge = JSON.parse(fileContent);

                for (const chunk of knowledge.chunks) {
                    // Generate embedding
                    const embedding = await embed(runtime, chunk.content);

                    // Store the memory in the database
                    await db.createMemory(
                        {
                            type: "knowledge",
                            content: { text: chunk.content, metadata: chunk.metadata },
                            embedding,
                            roomId: null, // Add specific roomId if needed
                            userId: null, // Add specific userId if needed
                            agentId: runtime.agentId, // Use runtime's agentId
                            isUnique: true,
                        },
                        "memories" // Table name
                    );

                    console.log(`Embedded and stored chunk: ${chunk.metadata.filePath}`);
                }
            }
        }

        console.log("Embedding process completed.");
    } catch (error) {
        console.error("Error during embedding:", error);
    }
}
