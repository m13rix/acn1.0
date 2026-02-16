
import { embedText, embedBatch } from './src/memory_system/embeddings.js';

async function test() {
    console.log("Testing Ollama embeddings with 'bge-m3'...");

    try {
        const text = "The quick brown fox jumps over the lazy dog.";
        const model = "bge-m3";

        console.log(`Embedding text: "${text}"`);
        const vector = await embedText(text, model);

        console.log(`Success! Vector length: ${vector.length}`);
        console.log(`First 5 dimensions: ${JSON.stringify(vector.slice(0, 5))}`);

        if (vector.length > 0) {
            console.log("\n✅ Single embedding test passed.");
        } else {
            console.error("\n❌ Vector is empty.");
        }

        console.log("\nTesting batch embedding...");
        const batch = ["Hello world", "Another text"];
        const vectors = await embedBatch(batch, model);
        console.log(`Batch size: ${vectors.length}`);
        console.log(`Vector 1 length: ${vectors[0].length}`);
        console.log(`Vector 2 length: ${vectors[1].length}`);

        if (vectors.length === 2 && vectors[0].length > 0) {
            console.log("\n✅ Batch embedding test passed.");
        }

    } catch (error) {
        console.error("\n❌ Test failed:", error);
    }
}

test();
