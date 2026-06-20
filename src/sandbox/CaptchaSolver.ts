import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-3.1-flash-lite';
const GRID_MODEL = 'gemma-4-31b-it';

/**
 * Utility class that uses Google Gemini vision/audio model to solve CAPTCHAs.
 * Designed to be used by BrowserSandbox for automated CAPTCHA resolution.
 *
 * @example
 * const solver = CaptchaSolver.getInstance();
 * const text = await solver.solveImageCaptcha(base64Data, 'image/png');
 */
export class CaptchaSolver {
    private ai: GoogleGenAI;
    private static instance: CaptchaSolver | null = null;

    /**
     * Creates a new CaptchaSolver instance.
     *
     * @param apiKey - Optional Gemini API key. Falls back to GEMINI_KEY env variable.
     * @throws {Error} If no API key is available.
     */
    constructor(apiKey?: string) {
        const key = apiKey || process.env.GEMINI_KEY;
        if (!key) {
            throw new Error(
                'GEMINI_KEY не настроен. Добавьте переменную GEMINI_KEY в .env файл.\n' +
                'Получить ключ: https://aistudio.google.com/app/apikey'
            );
        }
        this.ai = new GoogleGenAI({ apiKey: key });
    }

    /**
     * Returns a singleton instance of CaptchaSolver.
     * Creates one on first call using the GEMINI_KEY environment variable.
     *
     * @returns The singleton CaptchaSolver instance
     * @throws {Error} If GEMINI_KEY is not set
     */
    static getInstance(): CaptchaSolver {
        if (!CaptchaSolver.instance) {
            CaptchaSolver.instance = new CaptchaSolver();
        }
        return CaptchaSolver.instance;
    }

    /**
     * Solves a text-based image CAPTCHA by reading distorted/stylized characters.
     *
     * @param imageBase64 - Base64-encoded image data (no data URI prefix)
     * @param mimeType - MIME type of the image (e.g. 'image/png', 'image/jpeg')
     * @returns The recognized CAPTCHA text
     *
     * @example
     * const solver = CaptchaSolver.getInstance();
     * const text = await solver.solveImageCaptcha(screenshotBase64, 'image/png');
     * console.log(text); // "X7kP2"
     */
    async solveImageCaptcha(imageBase64: string, mimeType: string): Promise<string> {
        try {
            const response = await this.ai.models.generateContent({
                model: MODEL,
                contents: [{
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType,
                                data: imageBase64,
                            }
                        },
                        {
                            text: "You are solving a CAPTCHA for the user's personal browser assistant. Look at this image and read the distorted/stylized text characters shown. Return ONLY the exact characters/text, nothing else. No explanation, no quotes, just the raw text."
                        }
                    ]
                }],
                config: {
                    responseMimeType: 'text/plain',
                }
            });
            return (response.text || '').trim();
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to solve image CAPTCHA: ${msg}`);
        }
    }

    /**
     * Solves an audio CAPTCHA by transcribing spoken words or numbers.
     *
     * @param audioBase64 - Base64-encoded audio data (no data URI prefix)
     * @param mimeType - MIME type of the audio (e.g. 'audio/mp3', 'audio/wav')
     * @returns The transcribed text from the audio CAPTCHA
     *
     * @example
     * const solver = CaptchaSolver.getInstance();
     * const text = await solver.solveAudioCaptcha(audioData, 'audio/mp3');
     * console.log(text); // "7 3 9 2"
     */
    async solveAudioCaptcha(audioBase64: string, mimeType: string): Promise<string> {
        try {
            const response = await this.ai.models.generateContent({
                model: MODEL,
                contents: [{
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType,
                                data: audioBase64,
                            }
                        },
                        {
                            text: "You are solving an audio CAPTCHA for the user's personal browser assistant. Listen to this audio and transcribe the spoken words or numbers. Return ONLY the exact words/numbers spoken, nothing else. No explanation, no quotes."
                        }
                    ]
                }],
                config: {
                    responseMimeType: 'text/plain',
                }
            });
            return (response.text || '').trim();
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to solve audio CAPTCHA: ${msg}`);
        }
    }

    /**
     * Solves a reCAPTCHA-style image grid challenge (e.g. "select all images with traffic lights").
     *
     * @param imageBase64 - Base64-encoded screenshot of the grid (no data URI prefix)
     * @param mimeType - MIME type of the image (e.g. 'image/png')
     * @param taskDescription - The challenge text (e.g. "Select all images with traffic lights")
     * @returns Array of 1-based tile indices that match the task (left-to-right, top-to-bottom)
     *
     * @example
     * const solver = CaptchaSolver.getInstance();
     * const tiles = await solver.solveImageGridCaptcha(gridScreenshot, 'image/png', 'Select all images with buses');
     * console.log(tiles); // [1, 4, 7]
     */
    async solveImageGridCaptcha(imageBase64: string, mimeType: string, taskDescription: string): Promise<number[]> {
        try {
            const response = await this.ai.models.generateContent({
                model: MODEL,
                contents: [{
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType,
                                data: imageBase64,
                            }
                        },
                        {
                            text: `You are solving an image grid CAPTCHA for the user's personal browser assistant. The task says: '${taskDescription}'. The image shows a grid of tiles (usually 3x3 or 4x4). Identify which tiles match the task. Number tiles left-to-right, top-to-bottom starting from 1. Return ONLY a JSON array of matching tile numbers, e.g. [1,4,7]. No explanation.`
                        }
                    ]
                }],
                config: {
                    responseMimeType: 'text/plain',
                }
            });

            const text = (response.text || '').trim();

            // Extract JSON array from the response (handle potential markdown wrapping)
            const match = text.match(/\[[\d\s,]*\]/);
            if (!match) {
                throw new Error(`Model response is not a valid JSON array: ${text}`);
            }

            const parsed = JSON.parse(match[0]);
            if (!Array.isArray(parsed) || !parsed.every((n: unknown) => typeof n === 'number')) {
                throw new Error(`Parsed response is not a number array: ${text}`);
            }

            return parsed as number[];
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to solve image grid CAPTCHA: ${msg}`);
        }
    }

    /**
     * Solves a reCAPTCHA/hCaptcha grid using known instruction and grid dimensions from the DOM.
     * The screenshot may include red tile numbers overlaid for easier matching.
     */
    async solveRecaptchaGrid(
        imageBase64: string,
        mimeType: string,
        options: {
            instruction: string;
            rows: number;
            cols: number;
            mode: 'square' | 'image';
            tileCount: number;
            annotated?: boolean;
            provider?: string;
        }
    ): Promise<number[]> {
        const { instruction, rows, cols, mode, tileCount, annotated, provider = 'recaptcha' } = options;
        const modeHint = mode === 'square'
            ? 'This is a "select all squares" challenge. Select every square that contains ANY part of the target object, even partial matches at tile edges.'
            : 'This is a "select all images" challenge. Select every image tile that clearly contains the target object.';

        const numberingHint = annotated
            ? 'Each tile has a red number label drawn on it. Return the numbers of ALL matching tiles.'
            : `Number tiles left-to-right, top-to-bottom from 1 to ${tileCount}. Return ALL matching tile numbers.`;

        try {
            const response = await this.ai.models.generateContent({
                model: GRID_MODEL,
                contents: [{
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType,
                                data: imageBase64,
                            }
                        },
                        {
                            text: `You are solving a ${provider} image-grid CAPTCHA.\n` +
                                `Instruction shown to the user: "${instruction}"\n` +
                                `Grid size: ${rows} rows x ${cols} columns (${tileCount} tiles total).\n` +
                                `${modeHint}\n` +
                                `${numberingHint}\n` +
                                `Be thorough: include every matching tile. Missing even one correct tile fails the challenge.\n` +
                                `Do not include tiles that clearly do not match.\n` +
                                `Return ONLY JSON: {"matches":[1,4,7]}`
                        }
                    ]
                }],
                config: {
                    responseMimeType: 'application/json',
                }
            });

            const text = (response.text || '').trim();
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                throw new Error(`Model response is not a valid JSON object: ${text}`);
            }

            const parsed = JSON.parse(match[0]) as { matches?: unknown[] };
            if (!Array.isArray(parsed.matches)) {
                throw new Error(`Parsed response missing matches array: ${text}`);
            }

            const matches = [...new Set(
                parsed.matches
                    .map(value => Number(value))
                    .filter(value => Number.isInteger(value) && value >= 1 && value <= tileCount)
            )];

            if (!matches.length) {
                throw new Error(`Model returned no valid tile numbers: ${text}`);
            }

            return matches;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to solve reCAPTCHA grid: ${msg}`);
        }
    }

    /**
     * Solves a grid-based CAPTCHA (like reCAPTCHA or hCaptcha) by reading the instructions
     * from the image, detecting the grid size, and returning the matching tile indices.
     *
     * @param imageBase64 - Base64-encoded screenshot of the challenge iframe (no data URI prefix)
     * @param mimeType - MIME type of the image (e.g. 'image/png')
     * @returns Object containing grid dimensions and the matching tile numbers (1-based)
     */
    async solveGridCaptchaAuto(imageBase64: string, mimeType: string): Promise<{ rows: number; cols: number; matches: number[] }> {
        try {
            const response = await this.ai.models.generateContent({
                model: GRID_MODEL,
                contents: [{
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType,
                                data: imageBase64,
                            }
                        },
                        {
                            text: "You are solving a grid CAPTCHA challenge for the user's personal browser assistant. Look at this image. " +
                                  "1. Read the instruction text shown at the top (e.g., 'Select all squares with traffic lights'). " +
                                  "2. Determine the grid size (usually 3x3 or 4x4 tiles). " +
                                  "3. Identify ALL tiles that match the instruction. Number the tiles left-to-right, top-to-bottom starting from 1. " +
                                  "Include every matching tile; missing one causes failure. " +
                                  "Return ONLY a JSON object in this format: {\"rows\": 3, \"cols\": 3, \"matches\": [1, 4, 7]}. No explanation, no markdown formatting."
                        }
                    ]
                }],
                config: {
                    responseMimeType: 'application/json',
                }
            });

            const text = (response.text || '').trim();
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                throw new Error(`Model response is not a valid JSON object: ${text}`);
            }

            const parsed = JSON.parse(match[0]);
            if (typeof parsed.rows !== 'number' || typeof parsed.cols !== 'number' || !Array.isArray(parsed.matches)) {
                throw new Error(`Parsed response does not match expected format: ${text}`);
            }

            const matches: number[] = [...new Set(
                (parsed.matches as unknown[])
                    .map(value => Number(value))
                    .filter(value => Number.isInteger(value) && value >= 1)
            )];

            return {
                rows: parsed.rows,
                cols: parsed.cols,
                matches
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to solve auto grid CAPTCHA: ${msg}`);
        }
    }
}
