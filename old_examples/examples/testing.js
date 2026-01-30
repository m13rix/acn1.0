// To run this code you need to install the following dependencies:
// npm install @google/genai
// npm install -D @types/node

import { GoogleGenAI, PersonGeneration } from '@google/genai';

import { writeFile } from 'fs/promises';
import fetch from 'node-fetch';

async function main() {
    const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
    });

    let operation = await ai.models.generateVideos({
        model: 'veo-2.0-generate-001',
        prompt: `A macro shot focuses on long, slender calamus leaves, rendered in a cinematic photography realistic style. The main leaf, a vibrant, deep green, is positioned diagonally across the frame. Its surface is covered in tiny, glistening spherical dewdrops that catch and refract the bright morning sunlight, creating sparkling highlights. Initially, a larger, perfectly round dewdrop clings to the upper section of the leaf, its surface tension holding it in place. Then, as the leaf sways almost imperceptibly, the dewdrop begins to slowly dislodge. Next, it starts to trickle down the central vein of the leaf, its shape elongating slightly as it moves, leaving a subtle, glistening wet trail in its path. Finally, it reaches the pointed tip of the leaf, hangs for a brief moment, and falls out of the bottom of the frame. In the background, other leaves and blades of grass are softly blurred, creating a beautiful bokeh effect with soft, out-of-focus circles of light. The environment is bathed in the warm, golden glow of early morning sunlight, which streams in from behind the leaves, backlighting them and causing their wet edges to shine brilliantly. The overall impression is one of serene, natural beauty, captured in a highly realistic and detailed manner. This is a macro shot. The camera tilts down very slowly, following the path of the main dewdrop as it travels down the leaf. The lighting is soft and natural, with strong backlighting to create a radiant, glowing effect on the dewdrops and leaf edges, characteristic of professional nature photography. The atmosphere is peaceful and serene. The overall video presents a cinematic photography realistic style.`,
        config: {
            numberOfVideos: 1,
            aspectRatio: '16:9',
            durationSeconds: 8,
            personGeneration: PersonGeneration.ALLOW_ALL,
        },
    });

    while (!operation.done) {
        console.log(`Video ${operation.name} has not been generated yet. Check again in 10 seconds...`);
        await new Promise((resolve) => setTimeout(resolve, 10000));
        operation = await ai.operations.getVideosOperation({
            operation: operation,
        });
    }

    console.log(`Generated ${operation.response?.generatedVideos?.length ?? 0} video(s).`);

    operation.response?.generatedVideos?.forEach(async (generatedVideo, i) => {
        console.log(`Video has been generated: ${generatedVideo?.video?.uri}`);
        const response = await fetch(`${generatedVideo?.video?.uri}&key=${process.env.GEMINI_API_KEY}`);
        const buffer = await response.arrayBuffer();
        await writeFile(`video_${i}.mp4`, Buffer.from(buffer));
        console.log(`Video ${generatedVideo?.video?.uri} has been downloaded to video_${i}.mp4.`);
    });
}

main();
