/**
 * Video Editor Tool
 * 
 * Micro-framework for video creation with asset management and shot composition.
 * Uses Gemini CLI + Remotion for final video rendering.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import sharp from 'sharp';
import { GOOGLE_IMG_SCRAP } from 'google-img-scrap';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from '@ffmpeg-installer/ffmpeg';
import { synthesizeSpeech } from './comfyui-tts.js';

// Setup
const __dirname = path.dirname(fileURLToPath(import.meta.url));
ffmpeg.setFfmpegPath(ffmpegStatic.path);

// Constants
const VIDEO_PROJECT_DIR = "G:\\agent0\\acn1.0\\data\\videos\\my-video";
const PUBLIC_DIR = path.join(VIDEO_PROJECT_DIR, "public");
const GEMINI_CLI_PATH = 'C:\\Users\\maxim\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js';
const COMFY_HTTP = "http://127.0.0.1:8000";
const COMFY_WS = "ws://127.0.0.1:8000/ws";
const TARGET_WIDTH = 1920;
const TARGET_HEIGHT = 1080;

// Load ComfyUI workflow
import workflow from './workflow.json' with { type: 'json' };

// State for shots
interface Shot {
    index: number;
    speakerLine: string;
    prompt: string;
    voiceFile: string;
    duration: number; // in seconds
}

const shots: Shot[] = [];

// ============================================================================
// Retry Logic with Exponential Backoff
// ============================================================================

interface RetryOptions {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    retryOn?: (error: Error) => boolean;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
    maxRetries: 5,
    initialDelayMs: 5000,    // 5 seconds
    maxDelayMs: 120000,       // 2 minutes max
    retryOn: (error: Error) => {
        const msg = error.message.toLowerCase();
        return (
            msg.includes('rate limit') ||
            msg.includes('too many requests') ||
            msg.includes('429') ||
            msg.includes('quota') ||
            msg.includes('resource exhausted') ||
            msg.includes('temporarily unavailable') ||
            msg.includes('timeout') ||
            msg.includes('econnreset') ||
            msg.includes('socket hang up') ||
            msg.includes('network error')
        );
    }
};

/**
 * Execute a function with automatic retry on rate limit errors.
 * Uses exponential backoff with jitter.
 */
async function withRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
    let lastError: Error;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            if (attempt >= opts.maxRetries || !opts.retryOn(lastError)) {
                throw lastError;
            }

            // Calculate delay with exponential backoff + jitter
            const baseDelay = opts.initialDelayMs * Math.pow(2, attempt);
            const jitter = Math.random() * 1000;
            const delay = Math.min(baseDelay + jitter, opts.maxDelayMs);

            console.log(`[Editor] Rate limit hit: "${lastError.message.slice(0, 100)}..."`);
            console.log(`[Editor] Waiting ${Math.round(delay / 1000)}s before retry (attempt ${attempt + 1}/${opts.maxRetries})...`);

            await sleep(delay);
        }
    }

    throw lastError!;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Image Processing Helpers
// ============================================================================

/**
 * Scale image to 16:9 with blurred background fill.
 * Original image is centered without cropping, background is blurred version.
 */
async function scaleImageTo16x9(inputPath: string, outputPath: string): Promise<void> {
    console.log(`[Editor] Scaling image to 16:9: ${path.basename(inputPath)}`);

    // Get original image dimensions
    const metadata = await sharp(inputPath).metadata();
    const origWidth = metadata.width || 1920;
    const origHeight = metadata.height || 1080;

    // Calculate scale to fit within 1920x1080 while preserving aspect ratio
    const scaleX = TARGET_WIDTH / origWidth;
    const scaleY = TARGET_HEIGHT / origHeight;
    const scale = Math.min(scaleX, scaleY);

    const newWidth = Math.round(origWidth * scale);
    const newHeight = Math.round(origHeight * scale);

    // Create blurred background (stretched to fill)
    const blurredBackground = await sharp(inputPath)
        .resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: 'cover' })
        .blur(50)
        .toBuffer();

    // Create scaled foreground (preserving aspect ratio)
    const scaledForeground = await sharp(inputPath)
        .resize(newWidth, newHeight, { fit: 'inside' })
        .toBuffer();

    // Composite: blurred background + centered foreground
    const offsetX = Math.round((TARGET_WIDTH - newWidth) / 2);
    const offsetY = Math.round((TARGET_HEIGHT - newHeight) / 2);

    await sharp(blurredBackground)
        .composite([{
            input: scaledForeground,
            left: offsetX,
            top: offsetY
        }])
        .toFile(outputPath);

    console.log(`[Editor] Image scaled: ${TARGET_WIDTH}x${TARGET_HEIGHT}`);
}

/**
 * Download image from URL and save to file
 */
async function downloadImage(url: string, outputPath: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
}

/**
 * Download video from URL
 */
async function downloadVideo(url: string, outputPath: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download video: ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
}

// ============================================================================
// ASSETS API
// ============================================================================

export const assets = {
    /**
     * Search for an image using Google Images and save the first result.
     * 
     * @param query - Search query for the image
     * @param assetName - Filename to save as (e.g., "background.png")
     */
    async searchImage(query: string, assetName: string): Promise<string> {
        console.log(`[Editor] Searching image: "${query}" -> ${assetName}`);

        // Ensure public directory exists
        if (!fs.existsSync(PUBLIC_DIR)) {
            fs.mkdirSync(PUBLIC_DIR, { recursive: true });
        }

        return withRetry(async () => {
            const response = await GOOGLE_IMG_SCRAP({ search: query });

            if (!response || !response.result || response.result.length === 0) {
                throw new Error('No images found for query');
            }

            const tempPath = path.join(PUBLIC_DIR, `_temp_${assetName}`);
            const finalPath = path.join(PUBLIC_DIR, assetName);

            // Try multiple images from search results
            const maxAttempts = Math.min(response.result.length, 10);
            let lastError: Error | null = null;

            for (let i = 0; i < maxAttempts; i++) {
                const imageUrl = response.result[i]?.url || response.result[i]?.originalUrl;
                if (!imageUrl) continue;

                try {
                    await downloadImage(imageUrl, tempPath);

                    // Scale to 16:9 with blurred background
                    await scaleImageTo16x9(tempPath, finalPath);

                    // Cleanup temp
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

                    console.log(`[Editor] Image saved: ${finalPath}`);
                    return finalPath;
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                    console.log(`[Editor] Image #${i + 1} failed: ${lastError.message.slice(0, 50)}... trying next`);
                    // Cleanup failed temp file
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    continue;
                }
            }

            throw new Error(`All ${maxAttempts} image download attempts failed. Last error: ${lastError?.message}`);
        });
    },

    /**
     * Generate an image using ComfyUI API.
     * 
     * @param prompt - Detailed prompt for image generation
     * @param assetName - Filename to save as (e.g., "hero.png")
     */
    async generateImage(prompt: string, assetName: string): Promise<string> {
        console.log(`[Editor] Generating image with ComfyUI: "${prompt.substring(0, 50)}..." -> ${assetName}`);

        // Ensure public directory exists
        if (!fs.existsSync(PUBLIC_DIR)) {
            fs.mkdirSync(PUBLIC_DIR, { recursive: true });
        }

        // Clone workflow and set prompt
        const workflowCopy = JSON.parse(JSON.stringify(workflow));
        const promptNodeId = "58";
        workflowCopy[promptNodeId].inputs.value = prompt;

        // Queue prompt
        const promptRes = await fetch(`${COMFY_HTTP}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                prompt: workflowCopy,
                client_id: "editor-client",
            }),
        });

        const { prompt_id } = await promptRes.json();
        console.log(`[Editor] Queued ComfyUI prompt_id: ${prompt_id}`);

        // Wait for completion via WebSocket
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`${COMFY_WS}?clientId=editor-client`);

            const cleanup = () => {
                ws.close();
            };

            ws.on("open", () => {
                console.log("[Editor] ComfyUI WebSocket connected");
            });

            ws.on("message", async (data: Buffer, isBinary: boolean) => {
                if (isBinary) return;

                const msg = JSON.parse(data.toString());

                if (msg.type === "executing") {
                    const { node, prompt_id: msgPromptId } = msg.data;

                    if (node === null && msgPromptId === prompt_id) {
                        console.log("[Editor] ComfyUI execution finished");
                        cleanup();

                        try {
                            // Fetch final images from history
                            const historyRes = await fetch(`${COMFY_HTTP}/history/${prompt_id}`);
                            const history = await historyRes.json();

                            const outputs = history[prompt_id].outputs;
                            if (!outputs) {
                                reject(new Error("No outputs from ComfyUI"));
                                return;
                            }

                            // Get first image
                            for (const nodeId of Object.keys(outputs)) {
                                const node = outputs[nodeId];
                                if (!node.images) continue;

                                for (const img of node.images) {
                                    const url = `${COMFY_HTTP}/view` +
                                        `?filename=${encodeURIComponent(img.filename)}` +
                                        `&subfolder=${encodeURIComponent(img.subfolder ?? "")}` +
                                        `&type=${img.type}`;

                                    const res = await fetch(url);
                                    const buf = Buffer.from(await res.arrayBuffer());

                                    const tempPath = path.join(PUBLIC_DIR, `_temp_${assetName}`);
                                    const finalPath = path.join(PUBLIC_DIR, assetName);

                                    fs.writeFileSync(tempPath, buf);

                                    // Scale to 16:9
                                    await scaleImageTo16x9(tempPath, finalPath);
                                    fs.unlinkSync(tempPath);

                                    console.log(`[Editor] Generated image saved: ${finalPath}`);
                                    resolve(finalPath);
                                    return;
                                }
                            }

                            reject(new Error("No images in ComfyUI output"));
                        } catch (err) {
                            reject(err);
                        }
                    }
                }
            });

            ws.on("error", (err: Error) => {
                cleanup();
                reject(new Error(`ComfyUI WebSocket error: ${err.message}`));
            });
        });
    },

    /**
     * Get a stock image from Pexels.
     * 
     * @param query - Search query
     * @param assetName - Filename to save as
     */
    async stockImage(query: string, assetName: string): Promise<string> {
        console.log(`[Editor] Fetching stock image from Pexels: "${query}" -> ${assetName}`);

        const apiKey = process.env.PEXELS_API_KEY;
        if (!apiKey) {
            throw new Error(
                "PEXELS_API_KEY not configured. Add it to your .env file.\n" +
                "Get your key at: https://www.pexels.com/api/"
            );
        }

        // Ensure public directory exists
        if (!fs.existsSync(PUBLIC_DIR)) {
            fs.mkdirSync(PUBLIC_DIR, { recursive: true });
        }

        return withRetry(async () => {
            const response = await fetch(
                `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=10`,
                { headers: { Authorization: apiKey } }
            );

            if (!response.ok) {
                throw new Error(`Pexels API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            if (!data.photos || data.photos.length === 0) {
                throw new Error(`No stock images found for: ${query}`);
            }

            const tempPath = path.join(PUBLIC_DIR, `_temp_${assetName}`);
            const finalPath = path.join(PUBLIC_DIR, assetName);
            let lastError: Error | null = null;

            // Try multiple photos if download fails
            for (let i = 0; i < data.photos.length; i++) {
                const imageUrl = data.photos[i].src.original || data.photos[i].src.large2x;
                if (!imageUrl) continue;

                try {
                    await downloadImage(imageUrl, tempPath);
                    await scaleImageTo16x9(tempPath, finalPath);
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    console.log(`[Editor] Stock image saved: ${finalPath}`);
                    return finalPath;
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                    console.log(`[Editor] Stock image #${i + 1} failed: ${lastError.message.slice(0, 50)}... trying next`);
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    continue;
                }
            }

            throw new Error(`All stock image download attempts failed. Last error: ${lastError?.message}`);
        });
    },

    /**
     * Get a stock video from Pexels.
     * 
     * @param query - Search query
     * @param assetName - Filename to save as (e.g., "intro.mp4")
     */
    async stockVideo(query: string, assetName: string): Promise<string> {
        console.log(`[Editor] Fetching stock video from Pexels: "${query}" -> ${assetName}`);

        const apiKey = process.env.PEXELS_API_KEY;
        if (!apiKey) {
            throw new Error(
                "PEXELS_API_KEY not configured. Add it to your .env file.\n" +
                "Get your key at: https://www.pexels.com/api/"
            );
        }

        // Ensure public directory exists
        if (!fs.existsSync(PUBLIC_DIR)) {
            fs.mkdirSync(PUBLIC_DIR, { recursive: true });
        }

        return withRetry(async () => {
            const response = await fetch(
                `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=10`,
                { headers: { Authorization: apiKey } }
            );

            if (!response.ok) {
                throw new Error(`Pexels API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            if (!data.videos || data.videos.length === 0) {
                throw new Error(`No stock videos found for: ${query}`);
            }

            const finalPath = path.join(PUBLIC_DIR, assetName);
            let lastError: Error | null = null;

            // Try multiple videos if download fails
            for (let i = 0; i < data.videos.length; i++) {
                const videoFiles = data.videos[i].video_files;
                const hdVideo = videoFiles.find((v: any) => v.quality === 'hd') || videoFiles[0];
                if (!hdVideo?.link) continue;

                try {
                    await downloadVideo(hdVideo.link, finalPath);
                    console.log(`[Editor] Stock video saved: ${finalPath}`);
                    return finalPath;
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                    console.log(`[Editor] Stock video #${i + 1} failed: ${lastError.message.slice(0, 50)}... trying next`);
                    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
                    continue;
                }
            }

            throw new Error(`All stock video download attempts failed. Last error: ${lastError?.message}`);
        });
    }
};

// ============================================================================
// SHOTS API
// ============================================================================


/**
 * Get audio duration in seconds
 */
function getAudioDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err: Error | null, metadata: { format: { duration?: number } }) => {
            if (err) {
                reject(err);
                return;
            }
            const duration = metadata.format.duration || 0;
            resolve(Math.round(duration * 100) / 100); // Round to 2 decimal places
        });
    });
}

export const shotsApi = {
    /**
     * Add a new shot to the video.
     * Generates TTS voice and calculates duration.
     * 
     * @param speakerLine - The text the speaker says
     * @param shotPrompt - Description of what happens visually in this shot
     */
    async add(speakerLine: string, shotPrompt: string): Promise<Shot> {
        const shotIndex = shots.length + 1;
        const voiceFileName = `shot${shotIndex}_voice.mp3`;
        const voicePath = path.join(PUBLIC_DIR, voiceFileName);

        console.log(`[Editor] Creating shot ${shotIndex}: "${speakerLine.substring(0, 30)}..."`);

        // Ensure public directory exists
        if (!fs.existsSync(PUBLIC_DIR)) {
            fs.mkdirSync(PUBLIC_DIR, { recursive: true });
        }

        // Generate TTS using ComfyUI with retry
        await withRetry(async () => {
            await synthesizeSpeech(speakerLine, voicePath);
        });

        // Get duration
        const duration = await getAudioDuration(voicePath);

        const shot: Shot = {
            index: shotIndex,
            speakerLine,
            prompt: shotPrompt,
            voiceFile: voiceFileName,
            duration
        };

        shots.push(shot);

        console.log(`[Editor] Shot ${shotIndex} created: duration=${duration}s, voice=${voiceFileName}`);
        return shot;
    },

    /**
     * Get all added shots
     */
    getAll(): Shot[] {
        return [...shots];
    },

    /**
     * Clear all shots
     */
    clear(): void {
        shots.length = 0;
        console.log('[Editor] All shots cleared');
    }
};

// ============================================================================
// RENDER API
// ============================================================================

/**
 * Execute Gemini CLI command
 */
function runGeminiCli(prompt: string, resume: boolean = false): Promise<string> {
    return new Promise((resolve, reject) => {
        const args = [
            GEMINI_CLI_PATH,
            '-p',
            prompt,
            '--yolo',
        ];

        if (resume) {
            args.push('--resume');
        }

        console.log(`[Editor] Running Gemini CLI${resume ? ' (resume)' : ''}...`);

        const proc = spawn('node', args, { cwd: VIDEO_PROJECT_DIR });

        let output = '';
        let stderrOutput = '';

        proc.stdout.on('data', (chunk) => {
            output += chunk.toString();
            process.stdout.write(chunk); // Stream to console
        });

        proc.stderr.on('data', (chunk) => {
            stderrOutput += chunk.toString();
        });

        proc.on('close', (code) => {
            if (stderrOutput.trim()) {
                console.log(`[Editor] Gemini CLI stderr: ${stderrOutput.trim().slice(0, 200)}...`);
            }

            const result = output.trim();
            if (result || code === 0) {
                console.log(`[Editor] Gemini CLI completed`);
                resolve(result);
            } else {
                reject(new Error(`Gemini CLI exited with code ${code}, no output`));
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`Failed to start Gemini CLI: ${err.message}`));
        });
    });
}

/**
 * Generate and render the complete video using Gemini CLI + Remotion.
 * Processes all added shots sequentially.
 */
export async function generateAndRender(): Promise<void> {
    if (shots.length === 0) {
        throw new Error('No shots added. Use shots.add() first.');
    }

    console.log(`[Editor] Starting video generation with ${shots.length} shots...`);

    for (let i = 0; i < shots.length; i++) {
        const shot = shots[i];
        const isFirstShot = i === 0;

        let prompt: string;

        if (isFirstShot) {
            // First shot: full setup prompt
            prompt = `You are a professional Remotion video creator. please build a really high-quality video, exactly following given instruction. Use your Remotion best practices skill. Let's start by creating the first shot, adding it to the main, and root files for everything to work. You can use assets in @public/ Make a high-quality shot based on this description: ${shot.prompt} The duration of this shot should be EXACTLY ${shot.duration}. For audio, add ${shot.voiceFile}. Create the shot and add it to the main video`;
        } else {
            // Subsequent shots: add to existing
            prompt = `Ok. Now add another shot. ${shot.prompt} The duration of this shot should be EXACTLY ${shot.duration}. For audio, add ${shot.voiceFile}. Create the shot and add it to the main video`;
        }

        console.log(`[Editor] Processing shot ${shot.index}/${shots.length}...`);
        await runGeminiCli(prompt, !isFirstShot);
    }

    console.log(`[Editor] ✅ Video generation complete! Check ${VIDEO_PROJECT_DIR}`);
}

// Export shots with a friendlier name
export { shotsApi as shots };
