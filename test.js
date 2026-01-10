import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import cosineSimilarity from 'compute-cosine-similarity';

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

// -------------------------
// Embedding cache
// -------------------------
const wordCache = new Map();
const normalize = (t) => t.toLowerCase().trim();

async function embedWord(word) {
    const key = normalize(word);
    if (wordCache.has(key)) return wordCache.get(key);

    const res = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: [word],
        config: { taskType: 'SEMANTIC_SIMILARITY' }
    });

    const vec = res.embeddings[0].values;
    wordCache.set(key, vec);
    return vec;
}

async function embedSentence(sentence) {
    const res = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: [sentence],
        config: { taskType: 'SEMANTIC_SIMILARITY' }
    });
    return res.embeddings[0].values;
}

// -------------------------
// Realtime input
// -------------------------
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

let sentence = '';
let currentWord = '';
let words = [];

console.log('Type or paste text (Enter = analyze, Ctrl+C = exit)\n');

process.stdin.on('data', async (chunk) => {
    // Ctrl+C
    if (chunk === '\u0003') process.exit();

    // ENTER
    if (chunk === '\r' || chunk === '\n') {
        if (currentWord) {
            words.push(currentWord);
            currentWord = '';
        }

        console.log('\n\n📨 Sentence sent:', sentence);

        const sentenceVec = await embedSentence(sentence);

        const ranked = [];
        for (const w of words) {
            const vec = await embedWord(w);
            ranked.push({
                word: w,
                score: cosineSimilarity(sentenceVec, vec),
                vec: vec
            });
        }

        ranked.sort((a, b) => b.score - a.score);

        // Deduplicate: remove exact duplicates and group similar words
        const deduplicated = [];
        const SIMILARITY_THRESHOLD = 0.95; // Threshold for considering words as similar
        
        for (const item of ranked) {
            const normalizedWord = normalize(item.word);
            
            // Check for exact duplicate (case-insensitive)
            const exactDuplicate = deduplicated.some(
                d => normalize(d.word) === normalizedWord
            );
            if (exactDuplicate) continue;
            
            // Check for similar words using embedding similarity
            let isSimilar = false;
            let similarIndex = -1;
            
            for (let i = 0; i < deduplicated.length; i++) {
                const existing = deduplicated[i];
                const similarity = cosineSimilarity(item.vec, existing.vec);
                if (similarity >= SIMILARITY_THRESHOLD) {
                    isSimilar = true;
                    similarIndex = i;
                    // Keep the one with higher score, or if scores are very close, keep the shorter word
                    if (item.score > existing.score || 
                        (Math.abs(item.score - existing.score) < 0.01 && item.word.length < existing.word.length)) {
                        // Replace existing with this one
                        deduplicated[i] = item;
                    }
                    break;
                }
            }
            
            if (!isSimilar) {
                deduplicated.push(item);
            }
        }

        // Re-sort after deduplication (in case we replaced some items)
        deduplicated.sort((a, b) => b.score - a.score);

        console.log('\n🔥 Ranked by semantic importance:');
        deduplicated.forEach((r, i) =>
            console.log(`${i + 1}. ${r.word} (${r.score.toFixed(4)})`)
        );

        // Reset
        sentence = '';
        currentWord = '';
        words = [];

        console.log('\n-----------------------------\n');
        return;
    }

    // -------------------------
    // PASTE DETECTED
    // -------------------------
    if (chunk.length > 1) {
        process.stdout.write(chunk);
        sentence += chunk;

        const pastedWords = chunk.match(/\p{L}[\p{L}\p{N}_-]*/gu) || [];

        for (const w of pastedWords) {
            words.push(w);
            embedWord(w).catch(() => {});
        }

        return;
    }

    // -------------------------
    // Normal typing
    // -------------------------
    const char = chunk;
    process.stdout.write(char);
    sentence += char;

    if (/\s|[.,!?]/u.test(char)) {
        if (currentWord) {
            words.push(currentWord);
            embedWord(currentWord).catch(() => {});
            currentWord = '';
        }
    } else {
        currentWord += char;
    }
});
