import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { createClient } from '@deepgram/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAgentSandbox } from '../../src/core/AgentContext.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from '@ffmpeg-installer/ffmpeg';
import wav from 'wav';
import * as os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'owner.json');

// Configuration
const BOT_TOKEN = '8307545336:AAH9ok5fO1qlOGXGx0e_zbo_c-H4wy37tfs';
const DEEPGRAM_KEY = 'd41a097d9121982c5f8797e21477a0eb9a63a7d0';
const CLAIM_PASSWORD = 'agent'; // Password to claim ownership

// Initialize global instances
ffmpeg.setFfmpegPath(ffmpegStatic.path);

console.log('[Message] Module loaded successfully. sendVoice function is available.');

// Helper to manage owner persistence
function getOwner(): string | null {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      return data.id;
    }
  } catch (e) {
    console.error('[Message] Error reading owner file:', e);
  }
  return null;
}

function saveOwner(id: string) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ id }));
  } catch (e) {
    console.error('[Message] Error saving owner file:', e);
  }
}

// Transcription helper
async function transcribe(url: string): Promise<string> {
  const deepgram = createClient(DEEPGRAM_KEY);

  const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
    { url },
    {
      model: 'nova-2',
      smart_format: true,
    }
  );

  if (error) {
    throw new Error(`Deepgram error: ${error.message}`);
  }

  return result?.results?.channels[0]?.alternatives[0]?.transcript || '';
}

async function saveWaveFile(filename: string, pcmData: Buffer, channels = 1, rate = 24000, sampleWidth = 2): Promise<void> {
  return new Promise((resolve, reject) => {
    const writer = new wav.FileWriter(filename, {
      channels,
      sampleRate: rate,
      bitDepth: sampleWidth * 8,
    });
    writer.on('finish', resolve);
    writer.on('error', reject);
    writer.write(pcmData);
    writer.end();
  });
}

/**
 * Sends a voice message to the user using Gemini TTS.
 * @param text The text to convert to speech
 * @param voiceName The voice to use (default: 'Orus')
 */
export async function sendVoice(text: string, voiceName: string = 'Orus'): Promise<void> {
  console.log(`[Message] sendVoice called with text: "${text.substring(0, 30)}...", voice: ${voiceName}`);

  const key = process.env.GEMINI_KEY;
  console.log(`[Message] GEMINI_KEY check: ${key ? 'FOUND' : 'MISSING'}`);
  if (!key) {
    console.error('[Message] GEMINI_KEY not found. Cannot send voice.');
    return;
  }
  console.log('[Message] GEMINI_KEY found, proceeding...');

  const tmpDir = os.tmpdir();
  const wavPath = path.join(tmpDir, `voice_${Date.now()}.wav`);
  const oggPath = wavPath.replace('.wav', '.ogg');

  // Determine Chat ID (Try API env first, then owner file)
  const chatId = process.env.ACN_CHAT_ID || getOwner();
  const apiUrl = process.env.ACN_API_URL;
  const agentName = process.env.ACN_AGENT_NAME;

  console.log(`[Message-Debug] Chat ID: ${chatId} (Env: ${process.env.ACN_CHAT_ID}, Owner: ${getOwner()})`);
  console.log(`[Message-Debug] API URL: ${apiUrl}`);

  if (!chatId) {
    console.error('[Message] Cannot send voice: No owner and no Chat ID found.');
    return;
  }

  try {
    console.log('🎤 Generating voice...');
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-preview-tts' });

    const result = await model.generateContent({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    });

    const response = await result.response;
    // Note: Gemini API structure for Audio might vary, ensuring we access correctly based on prompt snippet
    const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!data) {
      // Fallback or error check if structure is different (e.g. binary blob)
      // But assuming prompt snippet is correct for the library version
      throw new Error('No audio data from Gemini TTS');
    }

    const audioBuffer = Buffer.from(data, 'base64');
    await saveWaveFile(wavPath, audioBuffer);

    // Verify file creation
    if (fs.existsSync(wavPath)) {
      const stats = fs.statSync(wavPath);
      console.log(`[Message-Debug] WAV File created: ${wavPath} (${stats.size} bytes)`);
    } else {
      throw new Error(`[Message-Debug] WAV File failed to create at ${wavPath}`);
    }

    // Convert to OGG Opus for Telegram voice
    await new Promise((resolve, reject) => {
      ffmpeg(wavPath)
        .audioCodec('libopus')
        .audioFrequency(24000)
        .audioChannels(1)
        .format('ogg')
        .on('end', resolve)
        .on('error', reject)
        .save(oggPath);
    });

    if (fs.existsSync(oggPath)) {
      const stats = fs.statSync(oggPath);
      console.log(`[Message-Debug] OGG File created: ${oggPath} (${stats.size} bytes)`);
    } else {
      throw new Error(`[Message-Debug] OGG File failed to create at ${oggPath}`);
    }

    // Send via API if available
    if (apiUrl && process.env.ACN_CHAT_ID) {
      console.log(`[Message] Sending voice via API for Chat ID: ${chatId}`);
      try {
        const apiResponse = await fetch(`${apiUrl}/api/sendVoice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, file: oggPath, agentName })
        });

        if (!apiResponse.ok) {
          const errText = await apiResponse.text();
          console.error(`[Message-Debug] API Error Response: ${apiResponse.status} - ${errText}`);
          throw new Error(`API request failed: ${errText}`);
        }
        console.log('[Message-Debug] API Request Success');
      } catch (apiErr) {
        console.error('[Message-Debug] Fetch Error:', apiErr);
        throw apiErr;
      }
    } else {
      // Legacy: Send directly
      console.log('[Message-Debug] Sending via Legacy Mode (Telegraf directly)');
      const bot = new Telegraf(BOT_TOKEN);
      await bot.telegram.sendVoice(chatId, { source: oggPath });
    }


    console.log('✅ Voice message sent!');
  } catch (error) {
    console.error('❌ sendVoice error:', error);
    throw error;
  } finally {
    // Cleanup
    [wavPath, oggPath].forEach(async (f) => {
      try { await fs.unlink(f); } catch { }
    });
  }
}

/**
 * Sends a question to the user and waits for a response.
 * Supports running via TelegramService API (multi-user) or standalone (legacy).
 */
export async function ask(question: string): Promise<string> {
  // 1. Check if running in a managed context with API access
  const apiUrl = process.env.ACN_API_URL;
  const chatId = process.env.ACN_CHAT_ID;
  const agentName = process.env.ACN_AGENT_NAME;

  if (apiUrl && chatId) {
    console.log(`[Message] Asking via API for Chat ID: ${chatId}`);
    try {
      // Step 1: Send the question — returns immediately with a questionId
      const askResponse = await fetch(`${apiUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, question, agentName })
      });

      if (!askResponse.ok) {
        const err = await askResponse.json();
        throw new Error(err.error || 'API request failed');
      }

      const { questionId } = await askResponse.json() as { questionId: string };
      console.log(`[Message] Question sent (id: ${questionId}). Polling for answer...`);

      // Step 2: Poll for the answer — no timeout, waits indefinitely
      const POLL_INTERVAL_MS = 2000;
      while (true) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

        const pollResponse = await fetch(`${apiUrl}/api/ask/poll?questionId=${encodeURIComponent(questionId)}`);

        if (!pollResponse.ok) {
          const err = await pollResponse.json();
          throw new Error(err.error || 'Poll request failed');
        }

        const pollData = await pollResponse.json() as { status: string; response?: string };

        if (pollData.status === 'answered') {
          console.log("[Message] User Response: " + pollData.response);
          return pollData.response!;
        }
        // status === 'waiting' → continue polling
      }
    } catch (e: any) {
      console.error('[Message] API error:', e.message);
      throw e;
    }
  }

  // 2. Fallback: Legacy Standalone Mode (Bot Owner)
  console.log('[Message] Initializing Telegram bot (Legacy Mode)...');
  const bot = new Telegraf(BOT_TOKEN);
  let ownerId = getOwner();

  // We wrap the logic in a promise to wait for the user's response
  return new Promise((resolve, reject) => {
    let resolved = false;

    // Cleanup function to stop the bot and resolve the promise
    const finish = (response: string) => {
      if (resolved) return;
      resolved = true;
      bot.stop('SIGINT');
      resolve(response);
    };

    // Handle /start command
    bot.command('start', async (ctx) => {
      if (ownerId) {
        if (ctx.chat.id.toString() === ownerId) {
          await ctx.reply('Welcome back, owner!');
        } else {
          await ctx.reply('This agent is already owned by someone else.');
        }
        return;
      }
      await ctx.reply(`Hello! I am your AI Agent. To claim me, please enter the password.`);
    });

    // Handle text messages
    bot.on(message('text'), async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const text = ctx.message.text;

      // Registration flow
      if (!ownerId) {
        if (text === CLAIM_PASSWORD) {
          ownerId = chatId;
          saveOwner(ownerId);
          await ctx.reply('✅ Ownership verified! You are now connected.');
          await ctx.reply(`❓ Question: ${question}`);
        } else {
          await ctx.reply('❌ Incorrect password. Please try again.');
        }
        return;
      }

      // Verification (only owner can reply)
      if (chatId !== ownerId) {
        await ctx.reply('⛔ You are not the owner of this agent.');
        return;
      }

      // Valid response from owner
      finish(text);
    });

    // Handle voice messages
    bot.on(message('voice'), async (ctx) => {
      const chatId = ctx.chat.id.toString();

      if (!ownerId || chatId !== ownerId) {
        return;
      }

      await ctx.reply('🎙️ Processing voice message...');
      try {
        const link = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
        const transcript = await transcribe(link.href);
        await ctx.reply(`📝 Transcript: "${transcript}"`);
        finish(transcript);
      } catch (error) {
        console.error('Transcription error:', error);
        await ctx.reply('❌ Error processing voice message.');
      }
    });

    // Start the bot
    bot.launch(() => console.log('[Message] Bot stopped'))
      .catch(err => {
        console.error('[Message] Bot launch error:', err);
        reject(err);
      });

    console.log('[Message] Bot polling started.');

    // If owner exists, send the question immediately
    if (ownerId) {
      bot.telegram.sendMessage(ownerId, `❓ Question: ${question}`)
        .catch(err => {
          console.error('[Message] Failed to send message:', err);
        });
    } else {
      console.log(`[Message] No owner registered. Waiting for /start and password '${CLAIM_PASSWORD}' on the bot...`);
    }
  });
}

/**
 * Sends files to the user.
 */
export async function sendFiles(files: string[]): Promise<void> {
  const apiUrl = process.env.ACN_API_URL;
  const chatId = process.env.ACN_CHAT_ID;
  const agentName = process.env.ACN_AGENT_NAME;

  if (apiUrl && chatId) {
    console.log(`[Message] Sending files via API for Chat ID: ${chatId}`);
    try {
      const sandboxDir = getAgentSandbox()?.directory || process.cwd();
      const absoluteFiles = files.map(f => path.resolve(sandboxDir, f));

      const response = await fetch(`${apiUrl}/api/sendFiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, files: absoluteFiles, agentName })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'API request failed');
      }
      return;
    } catch (e: any) {
      console.error('[Message] API error:', e.message);
      throw e;
    }
  }

  // Fallback: Legacy (Not fully supported for sending arbitary files proactively in legacy mode,
  // but we can try if we have an owner)
  const ownerId = getOwner();
  if (!ownerId) {
    console.error('[Message] Cannot send files: No owner and no API context.');
    return;
  }

  const bot = new Telegraf(BOT_TOKEN);
  for (const file of files) {
    try {
      // We can't easily resolve relative paths here without context of where the tool is running vs where session is.
      // But assuming CWD is sandbox or similar.
      // Telegraf needs explicit upload logic.
      // This legacy path is brittle. API path is preferred.
      await bot.telegram.sendDocument(ownerId, { source: file });
    } catch (e) {
      console.error(`[Message] Failed to send file ${file}:`, e);
    }
  }
}

/**
 * Sends a simple text message to the user.
 */
export async function sendText(text: string): Promise<void> {
  const apiUrl = process.env.ACN_API_URL;
  const chatId = process.env.ACN_CHAT_ID;
  const agentName = process.env.ACN_AGENT_NAME;

  if (apiUrl && chatId) {
    console.log(`[Message] Sending text via API for Chat ID: ${chatId}`);
    try {
      const response = await fetch(`${apiUrl}/api/sendText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, text, agentName })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'API request failed');
      }
      return;
    } catch (e: any) {
      console.error('[Message] API error:', e.message);
      throw e;
    }
  }

  // Fallback: Legacy
  const ownerId = getOwner();
  if (!ownerId) {
    console.error('[Message] Cannot send text: No owner and no API context.');
    return;
  }

  const bot = new Telegraf(BOT_TOKEN);
  try {
    await bot.telegram.sendMessage(ownerId, text);
  } catch (e) {
    console.error(`[Message] Failed to send text:`, e);
  }
}
