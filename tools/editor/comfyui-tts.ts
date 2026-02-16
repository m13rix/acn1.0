/**
 * ComfyUI TTS Module
 *
 * Text-to-speech synthesis using ComfyUI's Qwen3-TTS VoiceClone.
 * Uses reference audio for voice cloning.
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Constants
const COMFY_HTTP = "http://127.0.0.1:8000";
const COMFY_WS = "ws://127.0.0.1:8000/ws";
const COMFY_AUDIO_OUTPUT = "G:/ComfyUI/output/audio";
const REFERENCE_AUDIO = path.join(__dirname, "Recording.wav");

// Load audio workflow
import audioWorkflow from './audio_workflow.json' with { type: 'json' };

// Node IDs in workflow
const PROMPT_NODE_ID = "42";
const LOAD_AUDIO_NODE_ID = "24";

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Upload file to ComfyUI input folder via API
 */
async function uploadFile(filePath: string): Promise<string> {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\n`),
        Buffer.from(`Content-Disposition: form-data; name="image"; filename="${fileName}"\r\n`),
        Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`),
        fileBuffer,
        Buffer.from(`\r\n--${boundary}\r\n`),
        Buffer.from(`Content-Disposition: form-data; name="type"\r\n\r\n`),
        Buffer.from(`input\r\n`),
        Buffer.from(`--${boundary}--\r\n`),
    ]);

    const res = await fetch(`${COMFY_HTTP}/upload/image`, {
        method: "POST",
        headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: body,
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upload failed: ${res.status} - ${text}`);
    }

    const result = await res.json() as { name: string };
    return result.name;
}

/**
 * Get list of .mp3 files in directory
 */
function getMp3Files(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.mp3'))
        .map(f => path.join(dir, f));
}

/**
 * Wait for a new .mp3 file to appear in directory
 */
async function waitForNewMp3(
    dir: string,
    existingFiles: Set<string>
): Promise<string> {
    while (true) {
        const currentFiles = getMp3Files(dir);

        for (const file of currentFiles) {
            if (!existingFiles.has(file)) {
                // Wait a bit to ensure file is fully written
                await sleep(500);
                return file;
            }
        }

        await sleep(1000);
    }
}

/**
 * Synthesize speech using ComfyUI TTS
 *
 * @param text - Text to synthesize
 * @param outputPath - Path to save the output MP3
 * @returns Path to the generated audio file
 */
export async function synthesizeSpeech(text: string, outputPath: string): Promise<string> {
    console.log(`[ComfyUI-TTS] Generating speech: "${text.substring(0, 50)}..."`);

    // Remember existing files BEFORE generation
    const existingFiles = new Set(getMp3Files(COMFY_AUDIO_OUTPUT));

    // 1. Upload reference audio
    console.log("[ComfyUI-TTS] Uploading reference audio...");
    const uploadedFileName = await uploadFile(REFERENCE_AUDIO);

    // 2. Prepare workflow
    const workflow = JSON.parse(JSON.stringify(audioWorkflow));
    workflow[PROMPT_NODE_ID].inputs.value = text;
    workflow[LOAD_AUDIO_NODE_ID].inputs.audio = uploadedFileName;

    // 3. Queue prompt
    console.log("[ComfyUI-TTS] Queueing prompt...");
    const promptRes = await fetch(`${COMFY_HTTP}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            prompt: workflow,
            client_id: "editor-tts-client",
        }),
    });

    const result = await promptRes.json() as { prompt_id?: string; error?: string; node_errors?: any };

    if (result.error) {
        throw new Error(`ComfyUI API Error: ${result.error}`);
    }

    const prompt_id = result.prompt_id;
    console.log(`[ComfyUI-TTS] Queued prompt_id: ${prompt_id}`);

    // 4. Connect to WebSocket for monitoring
    const ws = new WebSocket(`${COMFY_WS}?clientId=editor-tts-client`);

    let executionFinished = false;
    let executionError: string | null = null;

    ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;

        const msg = JSON.parse(data.toString());

        if (msg.type === "execution_error") {
            executionError = JSON.stringify(msg.data);
        }

        if (msg.type === "executing" && msg.data?.node === null) {
            executionFinished = true;
        }
    });

    // 5. Wait for new .mp3 file
    console.log("[ComfyUI-TTS] Waiting for audio generation...");
    const newFile = await waitForNewMp3(COMFY_AUDIO_OUTPUT, existingFiles);

    ws.close();


    console.log(`[ComfyUI-TTS] Audio generated: ${path.basename(newFile)}`);

    // 6. Copy file to output path
    fs.copyFileSync(newFile, outputPath);

    // 7. Delete original from ComfyUI output
    fs.unlinkSync(newFile);

    console.log(`[ComfyUI-TTS] Saved to: ${outputPath}`);
    return outputPath;
}
