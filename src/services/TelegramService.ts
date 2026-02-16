
import { Telegraf, Markup, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { createClient } from '@deepgram/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { AgentLoader } from '../loaders/AgentLoader.js';
import { ToolLoader } from '../loaders/ToolLoader.js';
import { Session } from '../core/Session.js';
import { Executor, ExecutorCallbacks } from '../core/Executor.js';
import { actionContext } from '../core/ActionContext.js';
import { getProvider } from '../providers/base.js';
import { getSyntax } from '../syntax/base.js';
import { getLoop } from '../loops/base.js';
import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { COLORS, SYMBOLS, StreamDisplay } from '../cli/display.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTHORIZED_USERS_FILE = path.join(__dirname, '..', '..', 'tools', 'message', 'authorized_users.json');
const OWNER_FILE = path.join(__dirname, '..', '..', 'tools', 'message', 'owner.json');

const BOT_TOKEN = '8307545336:AAH9ok5fO1qlOGXGx0e_zbo_c-H4wy37tfs';
const DEEPGRAM_KEY = 'd41a097d9121982c5f8797e21477a0eb9a63a7d0';
const DEBOUNCE_MS = 1000;
const STREAM_PREVIEW_LIMIT = 3900;
const MESSAGE_CHUNK_LIMIT = 3900;
const CODE_CHUNK_LIMIT = 1800;
const PREVIEW_INTERVAL_MIN_MS = 80;
const PREVIEW_INTERVAL_MAX_MS = 1500;
const PREVIEW_INTERVAL_DEFAULT_MS = 180;

interface PendingMessage {
    text?: string;
    files?: string[];
    timestamp: number;
}

interface TelegramRoute {
    chatId: string;
    messageThreadId?: number;
    directMessagesTopicId?: number;
}

type StreamingTransport = 'draft' | 'message';

interface TelegramUiState {
    transport: StreamingTransport;
    queue: Promise<void>;
    currentDraftId: number;
    livePreviewMessageId: number | null;
    reasoningAccumulated: string;
    textAccumulated: string;
    currentTurnActionMessageIds: number[];
    currentTurnObservationMessageIds: number[];
    previewText: string;
    previewItalic: boolean;
    previewDirty: boolean;
    previewFlushTimer: NodeJS.Timeout | null;
    previewFlushInFlight: boolean;
    previewIntervalMs: number;
    previewNextAllowedAtMs: number;
}

interface ChatSession {
    route: TelegramRoute;
    session: Session | null;
    agentName: string | null;
    pendingMessages: PendingMessage[];
    pendingTimer: NodeJS.Timeout | null;
    executor: Executor | null;
    isProcessing: boolean;
    waitingForQuestionResponse: boolean;
    questionResolver: ((response: string) => void) | null;
    ui: TelegramUiState;
}

interface TelegramApiErrorLike {
    response?: {
        error_code?: number;
        description?: string;
        parameters?: {
            retry_after?: number;
        };
    };
}

export class TelegramService {
    private bot: Telegraf;
    private authorizedUsers: Set<string> = new Set();
    private accessCode: string;
    private sessions: Map<string, ChatSession> = new Map();
    private agentLoader: AgentLoader;
    private toolLoader: ToolLoader;

    private app: express.Express;
    private server: Server | null = null;
    private apiUrl = '';
    private display: StreamDisplay;
    private draftCounter = Date.now();

    constructor() {
        this.bot = new Telegraf(BOT_TOKEN);
        this.agentLoader = new AgentLoader();
        this.toolLoader = new ToolLoader();
        this.accessCode = Math.random().toString(36).slice(-6).toUpperCase();
        this.display = new StreamDisplay();

        this.app = express();
        this.app.use(express.json());
        this.setupApiRoutes();

        this.loadAuthorizedUsers();
        this.setupHandlers();

        this.bot.catch((err: unknown, ctx: Context) => {
            console.error(`[Telegram] Error for ${ctx.updateType}:`, err);
            if (ctx.chat) {
                const chatId = ctx.chat.id.toString();
                const message = `Internal error: ${(err as Error)?.message ?? 'Unknown error'}`;
                void this.bot.telegram.sendMessage(chatId, message).catch(() => {
                    // Avoid recursive failures in error handler.
                });
            }
        });
    }

    private setupApiRoutes(): void {
        this.app.post('/api/ask', async (req, res): Promise<void> => {
            const { chatId, question } = req.body as { chatId?: string; question?: string };
            if (!chatId || !question) {
                res.status(400).json({ error: 'Missing parameters' });
                return;
            }

            try {
                const answer = await this.ask(chatId, question);
                res.json({ response: answer });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/sendFiles', async (req, res): Promise<void> => {
            const { chatId, files } = req.body as { chatId?: string; files?: string[] };
            if (!chatId || !files) {
                res.status(400).json({ error: 'Missing parameters' });
                return;
            }

            try {
                await this.sendFiles(chatId, files);
                res.json({ success: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/sendVoice', async (req, res): Promise<void> => {
            const { chatId, file } = req.body as { chatId?: string; file?: string };
            if (!chatId || !file) {
                res.status(400).json({ error: 'Missing parameters' });
                return;
            }

            try {
                await this.sendVoice(chatId, file);
                res.json({ success: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/sendText', async (req, res): Promise<void> => {
            const { chatId, text } = req.body as { chatId?: string; text?: string };
            if (!chatId || !text) {
                res.status(400).json({ error: 'Missing parameters' });
                return;
            }

            try {
                await this.sendText(chatId, text);
                res.json({ success: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });
    }

    private loadAuthorizedUsers(): void {
        try {
            if (fs.existsSync(AUTHORIZED_USERS_FILE)) {
                const data = JSON.parse(fs.readFileSync(AUTHORIZED_USERS_FILE, 'utf-8')) as string[];
                if (Array.isArray(data)) {
                    data.forEach((id) => this.authorizedUsers.add(String(id)));
                }
            } else if (fs.existsSync(OWNER_FILE)) {
                const data = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf-8')) as { id?: string };
                if (data.id) {
                    this.authorizeUser(data.id);
                }
            }
        } catch (e) {
            console.error('Error loading authorized users:', e);
        }
    }

    private saveAuthorizedUsers(): void {
        try {
            const dir = path.dirname(AUTHORIZED_USERS_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(AUTHORIZED_USERS_FILE, JSON.stringify(Array.from(this.authorizedUsers)));
        } catch (e) {
            console.error('Error saving authorized users:', e);
        }
    }

    private authorizeUser(chatId: string): void {
        this.authorizedUsers.add(chatId);
        this.saveAuthorizedUsers();
    }

    private checkAuth(ctx: Context): boolean {
        const chatId = ctx.chat?.id.toString();
        if (!chatId) return false;

        if (this.authorizedUsers.has(chatId)) return true;

        const text = (ctx.message as any)?.text?.trim();
        if (text === this.accessCode) {
            this.authorizeUser(chatId);
            void ctx.reply('Access granted.');
            void this.showAgentMenu(ctx);
            return true;
        }

        return false;
    }

    private setupHandlers(): void {
        this.bot.command('start', async (ctx) => {
            const chatId = ctx.chat.id.toString();
            if (this.authorizedUsers.has(chatId)) {
                await this.showAgentMenu(ctx);
            } else {
                await ctx.reply(`Authorization required. Enter access code: ${this.accessCode}`);
            }
        });

        this.bot.command('new_session', async (ctx) => {
            if (!this.checkAuth(ctx)) return;

            const route = this.extractRouteFromContext(ctx);
            const routeKey = this.routeKey(route);
            const current = this.sessions.get(routeKey);

            if (!current) {
                await this.showAgentMenu(ctx);
                return;
            }

            if (current.pendingTimer) {
                clearTimeout(current.pendingTimer);
                current.pendingTimer = null;
            }

            await this.cleanupTurnArtifacts(current);
            await this.clearLivePreview(current);
            await this.clearDraftBestEffort(current.route, current.ui.currentDraftId);

            if (current.session) {
                await current.session.cleanup().catch((err) => {
                    console.warn(`[Telegram] Failed to cleanup session ${routeKey}:`, err);
                });
            }

            current.session = null;
            current.executor = null;
            current.pendingMessages = [];
            current.waitingForQuestionResponse = false;
            current.questionResolver = null;
            current.isProcessing = false;
            current.ui = this.createUiState();

            await this.sendMessageToRoute(route, 'Session cleared.');
            if (current.agentName) {
                await this.initializeSession(routeKey, route, current.agentName);
            } else {
                await this.showAgentMenu(ctx);
            }
        });

        this.bot.on(message('text'), async (ctx) => {
            if (!this.checkAuth(ctx)) return;

            const route = this.extractRouteFromContext(ctx);
            const routeKey = this.routeKey(route);
            const text = ctx.message.text;

            if (text.startsWith('Select: ') || text.startsWith('?? Select: ')) {
                const agentName = text.replace('?? ', '').replace('Select: ', '').trim();
                await this.initializeSession(routeKey, route, agentName);
                return;
            }

            await this.handleUserActivity(routeKey, route, { text, timestamp: Date.now() });
        });

        this.bot.on(message('voice'), async (ctx) => {
            if (!this.checkAuth(ctx)) return;

            const route = this.extractRouteFromContext(ctx);
            const routeKey = this.routeKey(route);

            await this.sendChatActionToRoute(route, 'typing');
            try {
                const link = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
                console.log(COLORS.muted(`\n${SYMBOLS.user} [Telegram Voice] Downloading/transcribing...`));

                const transcript = await this.transcribe(link.href);
                await this.sendMessageToRoute(route, `Transcript: "${transcript}"`);
                await this.handleUserActivity(routeKey, route, { text: transcript, timestamp: Date.now() });
            } catch (e) {
                console.error('Transcription error:', e);
                await this.sendMessageToRoute(route, 'Error processing voice message.');
            }
        });

        this.bot.on([message('document'), message('photo')], async (ctx) => {
            if (!this.checkAuth(ctx)) return;

            const route = this.extractRouteFromContext(ctx);
            const routeKey = this.routeKey(route);
            await this.sendMessageToRoute(route, 'Downloading file...');

            try {
                let fileId: string;
                let fileName: string;

                const asAny = ctx.message as any;
                if (asAny.document) {
                    fileId = asAny.document.file_id;
                    fileName = asAny.document.file_name || `doc_${Date.now()}`;
                } else {
                    const photos = asAny.photo;
                    fileId = photos[photos.length - 1].file_id;
                    fileName = `photo_${Date.now()}.jpg`;
                }

                const link = await ctx.telegram.getFileLink(fileId);
                const response = await fetch(link.href);
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                let saveDir = path.join(process.cwd(), 'temp_uploads');
                const chatSession = this.sessions.get(routeKey);
                if (chatSession?.session) {
                    saveDir = chatSession.session.sandbox.directory;
                }

                if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
                const filePath = path.join(saveDir, fileName);
                fs.writeFileSync(filePath, buffer);

                const caption = asAny.caption || '';
                await this.handleUserActivity(routeKey, route, { files: [fileName], text: caption, timestamp: Date.now() });
            } catch (e) {
                console.error('File download error:', e);
                await this.sendMessageToRoute(route, 'Error downloading file.');
            }
        });
    }

    private createUiState(): TelegramUiState {
        return {
            transport: 'draft',
            queue: Promise.resolve(),
            currentDraftId: this.nextDraftId(),
            livePreviewMessageId: null,
            reasoningAccumulated: '',
            textAccumulated: '',
            currentTurnActionMessageIds: [],
            currentTurnObservationMessageIds: [],
            previewText: '',
            previewItalic: false,
            previewDirty: false,
            previewFlushTimer: null,
            previewFlushInFlight: false,
            previewIntervalMs: PREVIEW_INTERVAL_DEFAULT_MS,
            previewNextAllowedAtMs: 0,
        };
    }

    private createEmptySession(route: TelegramRoute): ChatSession {
        return {
            route,
            session: null,
            agentName: null,
            pendingMessages: [],
            pendingTimer: null,
            executor: null,
            isProcessing: false,
            waitingForQuestionResponse: false,
            questionResolver: null,
            ui: this.createUiState(),
        };
    }

    private async showAgentMenu(ctx: Context): Promise<void> {
        const agents = await this.agentLoader.getAvailableAgents();
        const route = this.extractRouteFromContext(ctx);
        const buttons = agents.map((a) => [Markup.button.text(`Select: ${a}`)]);
        const keyboard = Markup.keyboard(buttons).oneTime().resize();
        await this.sendMessageToRoute(route, 'Select an agent to start a session:', keyboard.reply_markup as any);
    }

    private async initializeSession(routeKey: string, route: TelegramRoute, agentName: string): Promise<void> {
        const existing = this.sessions.get(routeKey) || this.createEmptySession(route);
        existing.route = route;
        existing.agentName = agentName;

        const agent = await this.agentLoader.loadByName(agentName);
        if (!agent) {
            await this.sendMessageToRoute(route, 'Agent not found.');
            return;
        }

        const provider = getProvider(agent.config.provider || 'gemini');
        const syntax = getSyntax(agent.config.syntax);
        const loop = getLoop(agent.config.loop);

        const toolNames = [...(agent.config.tools || [])];
        if (!toolNames.includes('files')) toolNames.push('files');
        if (agent.config.skillsTable && !toolNames.includes('skills')) toolNames.push('skills');
        if (agent.config.memory && agent.config.memory.enabled !== false && !toolNames.includes('memory')) {
            toolNames.push('memory');
        }
        if (!toolNames.includes('message')) toolNames.push('message');

        const tools = await this.toolLoader.loadByNames(toolNames);

        existing.session = new Session({
            agent,
            provider,
            syntax,
            loop,
            tools,
        });

        await existing.session.initialize();

        const callbacks = this.createExecutorCallbacks(routeKey);
        existing.executor = new Executor(existing.session, {
            stream: true,
            callbacks,
            requireFinish: agent.config.requireFinish,
        });

        this.sessions.set(routeKey, existing);

        console.log(COLORS.secondary(`\n${SYMBOLS.assistant} Session started with agent: ${agentName}`));
        console.log(COLORS.muted(`Route: ${routeKey}`));
        console.log(COLORS.muted('--------------------------------------------------'));

        await this.sendMessageToRoute(route, `Session started with ${agentName}.`, {
            ...Markup.removeKeyboard(),
        });
    }

    private createExecutorCallbacks(routeKey: string): ExecutorCallbacks {
        return {
            onBeforeProviderCall: () => {
                this.display.reset();
                this.enqueueUiTask(routeKey, async (session) => {
                    await this.cleanupTurnArtifacts(session);
                    await this.clearLivePreview(session);
                    session.ui.currentDraftId = this.nextDraftId();
                    session.ui.reasoningAccumulated = '';
                    session.ui.textAccumulated = '';
                    session.ui.previewText = '';
                    session.ui.previewItalic = false;
                    session.ui.previewDirty = false;
                    session.ui.previewIntervalMs = PREVIEW_INTERVAL_DEFAULT_MS;
                    session.ui.previewNextAllowedAtMs = 0;
                });
            },
            onReasoningDelta: (delta, accumulated) => {
                this.display.startReasoning();
                this.display.writeReasoning(delta);
                const session = this.sessions.get(routeKey);
                if (!session) return;
                session.ui.reasoningAccumulated = accumulated;
                this.updatePreviewState(routeKey, accumulated, true);
            },
            onReasoningDone: () => {
                this.display.endReasoning();
            },
            onTextDelta: (delta, accumulated) => {
                this.display.startText();
                this.display.writeText(delta);
                const session = this.sessions.get(routeKey);
                if (!session) return;
                session.ui.textAccumulated = accumulated;
                this.updatePreviewState(routeKey, accumulated, false);
            },
            onTextDone: (fullText) => {
                this.display.endText();

                this.enqueueUiTask(routeKey, async (session) => {
                    if (fullText.trim()) {
                        await this.sendPersistentText(session.route, fullText);
                    }
                    await this.clearLivePreview(session);
                    await this.clearDraftBestEffort(session.route, session.ui.currentDraftId);
                });
            },
            onAction: (code) => {
                this.display.showAction(code);

                this.enqueueUiTask(routeKey, async (session) => {
                    await this.clearLivePreview(session);
                    await this.clearDraftBestEffort(session.route, session.ui.currentDraftId);

                    const ids = await this.sendExecutionBlock(session.route, 'Executing action...', code);
                    session.ui.currentTurnActionMessageIds.push(...ids);
                });
            },
            onCli: (command) => {
                this.display.showAction(command);

                this.enqueueUiTask(routeKey, async (session) => {
                    await this.clearLivePreview(session);
                    await this.clearDraftBestEffort(session.route, session.ui.currentDraftId);

                    const ids = await this.sendExecutionBlock(session.route, 'Executing action...', command);
                    session.ui.currentTurnActionMessageIds.push(...ids);
                });
            },
            onFile: (filename, content) => {
                this.display.showAction(`file: ${filename}`);

                this.enqueueUiTask(routeKey, async (session) => {
                    await this.clearLivePreview(session);
                    await this.clearDraftBestEffort(session.route, session.ui.currentDraftId);

                    const payload = `// file: ${filename}\n${content}`;
                    const ids = await this.sendExecutionBlock(session.route, 'Executing action...', payload);
                    session.ui.currentTurnActionMessageIds.push(...ids);
                });
            },
            onObservation: (content) => {
                this.display.showObservation(content);

                this.enqueueUiTask(routeKey, async (session) => {
                    const ids = await this.sendObservationBlock(session.route, content);
                    session.ui.currentTurnObservationMessageIds.push(...ids);
                });
            },
            onResponse: () => {
                this.display.finalize();
                console.log('');

                this.enqueueUiTask(routeKey, async (session) => {
                    await this.cleanupTurnArtifacts(session);
                    await this.clearLivePreview(session);
                    await this.clearDraftBestEffort(session.route, session.ui.currentDraftId);
                });
            },
            onThinking: (content) => {
                console.log(COLORS.reasoning(`\n${SYMBOLS.thinking} Thinking...`));
                console.log(COLORS.muted(content));
            },
            onSkillsRetrieved: (content, score) => {
                console.log(COLORS.skills(`\n${SYMBOLS.skills} Skills retrieved (${(score * 100).toFixed(0)}% match)`));
                const preview = content.length > 80 ? `${content.slice(0, 80)}...` : content;
                console.log(COLORS.muted(`  ${preview}`));
            },
        };
    }

    private enqueueUiTask(routeKey: string, task: (session: ChatSession) => Promise<void>): void {
        const session = this.sessions.get(routeKey);
        if (!session) return;

        session.ui.queue = session.ui.queue
            .then(async () => task(session))
            .catch((error) => {
                console.error(`[Telegram UI] ${routeKey}:`, error);
            });
    }

    private async handleUserActivity(routeKey: string, route: TelegramRoute, activity: PendingMessage): Promise<void> {
        let session = this.sessions.get(routeKey);
        if (!session) {
            session = this.createEmptySession(route);
            session.agentName = 'core';
            this.sessions.set(routeKey, session);

            await this.initializeSession(routeKey, route, 'core');
            await this.handleUserActivity(routeKey, route, activity);
            return;
        }

        if (session.waitingForQuestionResponse && session.questionResolver && activity.text) {
            session.waitingForQuestionResponse = false;
            const resolver = session.questionResolver;
            session.questionResolver = null;
            resolver(activity.text);
            return;
        }

        session.pendingMessages.push(activity);
        this.schedulePendingProcessing(routeKey);
    }

    private schedulePendingProcessing(routeKey: string): void {
        const session = this.sessions.get(routeKey);
        if (!session) return;

        if (session.pendingTimer) {
            clearTimeout(session.pendingTimer);
        }

        session.pendingTimer = setTimeout(() => {
            void this.processPendingMessages(routeKey);
        }, DEBOUNCE_MS);
    }

    private async processPendingMessages(routeKey: string): Promise<void> {
        const session = this.sessions.get(routeKey);
        if (!session) return;

        if (session.pendingTimer) {
            clearTimeout(session.pendingTimer);
            session.pendingTimer = null;
        }

        if (session.waitingForQuestionResponse && session.questionResolver && session.pendingMessages.length > 0) {
            const answerIndex = session.pendingMessages.findIndex((m) => Boolean(m.text));
            if (answerIndex >= 0) {
                const [answer] = session.pendingMessages.splice(answerIndex, 1);
                if (answer?.text) {
                    session.waitingForQuestionResponse = false;
                    const resolver = session.questionResolver;
                    session.questionResolver = null;
                    resolver(answer.text);
                    return;
                }
            }
        }

        if (session.pendingMessages.length === 0) return;
        if (session.isProcessing) return;

        session.isProcessing = true;

        try {
            const messages = [...session.pendingMessages];
            session.pendingMessages = [];

            let combinedText = messages.map((m) => m.text).filter(Boolean).join('\n\n');
            const files = messages.flatMap((m) => m.files || []);

            if (files.length > 0) {
                combinedText += `\n\n[Attached files: ${files.join('; ')}]`;
            }

            console.log(COLORS.primary(`\n${SYMBOLS.user} User [${routeKey}]:`));
            console.log(COLORS.text(combinedText));
            console.log('');

            if (!session.executor) {
                await this.sendMessageToRoute(session.route, 'Session is not active. Use /start.');
                return;
            }

            const env = {
                ACN_API_URL: this.apiUrl,
                ACN_CHAT_ID: routeKey,
            };

            await actionContext.run({ chatId: routeKey, telegramService: this, sessionId: session.session?.id, env }, async () => {
                await session.executor!.execute(combinedText);
            });

            await session.ui.queue;
        } catch (e: any) {
            console.error(`Error executing agent for ${routeKey}:`, e);
            await this.sendMessageToRoute(session.route, `Error: ${e.message}`);
        } finally {
            session.isProcessing = false;

            if (session.pendingMessages.length > 0) {
                this.schedulePendingProcessing(routeKey);
            }
        }
    }

    private updatePreviewState(routeKey: string, content: string, italic: boolean): void {
        const session = this.sessions.get(routeKey);
        if (!session) return;

        session.ui.previewText = this.clipForStream(content, STREAM_PREVIEW_LIMIT);
        session.ui.previewItalic = italic;
        session.ui.previewDirty = true;
        this.schedulePreviewFlush(routeKey);
    }

    private schedulePreviewFlush(routeKey: string, forceDelayMs?: number): void {
        const session = this.sessions.get(routeKey);
        if (!session) return;

        if (session.ui.previewFlushTimer) {
            return;
        }

        const now = Date.now();
        const dueIn = Math.max(
            forceDelayMs ?? session.ui.previewIntervalMs,
            session.ui.previewNextAllowedAtMs - now,
            0
        );

        session.ui.previewFlushTimer = setTimeout(() => {
            const s = this.sessions.get(routeKey);
            if (!s) return;
            s.ui.previewFlushTimer = null;
            this.enqueueUiTask(routeKey, async (liveSession) => {
                await this.flushPreview(liveSession, routeKey);
            });
        }, dueIn);
    }

    private async flushPreview(session: ChatSession, routeKey: string): Promise<void> {
        if (!session.ui.previewDirty) return;
        if (session.ui.previewFlushInFlight) {
            this.schedulePreviewFlush(routeKey, session.ui.previewIntervalMs);
            return;
        }

        const now = Date.now();
        if (session.ui.previewNextAllowedAtMs > now) {
            this.schedulePreviewFlush(routeKey, session.ui.previewNextAllowedAtMs - now);
            return;
        }

        const preview = session.ui.previewText;
        const italic = session.ui.previewItalic;
        session.ui.previewDirty = false;
        session.ui.previewFlushInFlight = true;
        const startedAt = Date.now();

        try {
            if (session.ui.transport === 'draft') {
                await this.sendDraftToRoute(session.route, session.ui.currentDraftId, preview, italic);
            } else {
                await this.upsertLivePreviewMessage(session, preview, italic);
            }

            const elapsed = Date.now() - startedAt;
            if (elapsed < session.ui.previewIntervalMs * 0.8) {
                session.ui.previewIntervalMs = Math.max(PREVIEW_INTERVAL_MIN_MS, Math.floor(session.ui.previewIntervalMs * 0.9));
            } else if (elapsed > session.ui.previewIntervalMs * 1.6) {
                session.ui.previewIntervalMs = Math.min(PREVIEW_INTERVAL_MAX_MS, Math.floor(session.ui.previewIntervalMs * 1.2));
            }
        } catch (error) {
            if (this.isRateLimitError(error)) {
                const retryMs = this.getRetryAfterMs(error);
                session.ui.previewNextAllowedAtMs = Date.now() + retryMs;
                session.ui.previewIntervalMs = Math.min(PREVIEW_INTERVAL_MAX_MS, Math.floor(session.ui.previewIntervalMs * 1.5));
                session.ui.previewDirty = true;
                this.schedulePreviewFlush(routeKey, retryMs);
                return;
            }

            if (session.ui.transport === 'draft') {
                console.warn(`[Telegram] sendMessageDraft failed for ${this.routeKey(session.route)}. Falling back to send/edit:`, error);
                session.ui.transport = 'message';
                session.ui.previewDirty = true;
                this.schedulePreviewFlush(routeKey, 0);
                return;
            }

            throw error;
        } finally {
            session.ui.previewFlushInFlight = false;
        }

        if (session.ui.previewDirty) {
            this.schedulePreviewFlush(routeKey);
        }
    }

    private async upsertLivePreviewMessage(session: ChatSession, text: string, italic: boolean): Promise<void> {
        const route = session.route;
        const content = italic ? `<i>${this.escapeHtml(text)}</i>` : text;
        const extra = italic
            ? ({ parse_mode: 'HTML', disable_web_page_preview: true } as const)
            : ({ disable_web_page_preview: true } as const);

        if (!session.ui.livePreviewMessageId) {
            const sent = await this.sendMessageToRoute(route, content, extra as any);
            session.ui.livePreviewMessageId = sent.message_id;
            return;
        }

        const edited = await this.editMessageSafe(route.chatId, session.ui.livePreviewMessageId, content, extra as any);
        if (!edited) {
            const sent = await this.sendMessageToRoute(route, content, extra as any);
            session.ui.livePreviewMessageId = sent.message_id;
        }
    }

    private async clearLivePreview(session: ChatSession): Promise<void> {
        if (session.ui.previewFlushTimer) {
            clearTimeout(session.ui.previewFlushTimer);
            session.ui.previewFlushTimer = null;
        }
        session.ui.previewDirty = false;
        session.ui.previewFlushInFlight = false;

        if (session.ui.livePreviewMessageId) {
            await this.deleteMessageSafe(session.route.chatId, session.ui.livePreviewMessageId);
            session.ui.livePreviewMessageId = null;
        }
    }

    private async clearDraftBestEffort(route: TelegramRoute, draftId: number): Promise<void> {
        try {
            await this.sendDraftToRoute(route, draftId, '\u2060', false);
        } catch {
            // ignore
        }
    }

    private async cleanupTurnArtifacts(session: ChatSession): Promise<void> {
        const ids = [...session.ui.currentTurnActionMessageIds, ...session.ui.currentTurnObservationMessageIds];
        for (const id of ids) {
            await this.deleteMessageSafe(session.route.chatId, id);
        }
        session.ui.currentTurnActionMessageIds = [];
        session.ui.currentTurnObservationMessageIds = [];
    }

    private async sendExecutionBlock(route: TelegramRoute, header: string, code: string): Promise<number[]> {
        const chunks = this.splitText(code || '(empty)', CODE_CHUNK_LIMIT);
        const ids: number[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const partLabel = chunks.length > 1 ? `${header} (part ${i + 1}/${chunks.length})` : header;
            const body = `${this.escapeHtml(partLabel)}\n<pre>${this.escapeHtml(chunks[i] || '')}</pre>`;
            const sent = await this.sendMessageToRoute(route, body, { parse_mode: 'HTML' });
            ids.push(sent.message_id);
        }

        return ids;
    }

    private async sendObservationBlock(route: TelegramRoute, observation: string): Promise<number[]> {
        const chunks = this.splitText(observation || '(empty)', CODE_CHUNK_LIMIT);
        const ids: number[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const prefix = chunks.length > 1 ? `${this.escapeHtml(`Observation (part ${i + 1}/${chunks.length})`)}\n` : '';
            const body = `${prefix}<pre>${this.escapeHtml(chunks[i] || '')}</pre>`;
            const sent = await this.sendMessageToRoute(route, body, { parse_mode: 'HTML' });
            ids.push(sent.message_id);
        }

        return ids;
    }

    private async sendPersistentText(route: TelegramRoute, text: string): Promise<void> {
        const chunks = this.splitText(text, MESSAGE_CHUNK_LIMIT);
        for (let i = 0; i < chunks.length; i++) {
            const prefix = chunks.length > 1 ? `[part ${i + 1}/${chunks.length}]\n` : '';
            await this.sendMessageToRoute(route, `${prefix}${chunks[i] || ''}`);
        }
    }

    private splitText(text: string, maxLength: number): string[] {
        if (text.length <= maxLength) return [text];

        const chunks: string[] = [];
        let index = 0;

        while (index < text.length) {
            let end = Math.min(index + maxLength, text.length);
            if (end < text.length) {
                const newline = text.lastIndexOf('\n', end);
                if (newline > index + Math.floor(maxLength * 0.6)) {
                    end = newline;
                }
            }

            const chunk = text.slice(index, end);
            if (chunk) chunks.push(chunk);
            index = end;

            if (text[index] === '\n') {
                index += 1;
            }
        }

        return chunks.length > 0 ? chunks : [''];
    }

    private clipForStream(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;
        return `...${text.slice(-(maxLength - 3))}`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    private async transcribe(url: string): Promise<string> {
        const deepgram = createClient(DEEPGRAM_KEY);
        const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
            { url },
            {
                model: 'nova-2',
                smart_format: true,
                detect_language: true,
                punctuate: true,
            }
        );

        if (error) throw new Error(error.message);

        const transcript = result?.results?.channels[0]?.alternatives[0]?.transcript || '';
        const detectedLang = result?.results?.channels[0]?.detected_language || 'unknown';
        console.log(COLORS.muted(`   Detected language: ${detectedLang}`));
        return transcript;
    }

    private extractRouteFromContext(ctx: Context): TelegramRoute {
        const chatId = ctx.chat?.id.toString();
        if (!chatId) {
            throw new Error('Context has no chat id');
        }

        const msg = (ctx.message as any) || (ctx.update as any)?.message || null;

        const messageThreadId = msg?.is_topic_message === true && typeof msg?.message_thread_id === 'number'
            ? msg.message_thread_id
            : undefined;

        const directMessagesTopicId = typeof msg?.direct_messages_topic?.topic_id === 'number'
            ? msg.direct_messages_topic.topic_id
            : (typeof msg?.direct_messages_topic_id === 'number' ? msg.direct_messages_topic_id : undefined);

        return {
            chatId,
            messageThreadId,
            directMessagesTopicId,
        };
    }

    private routeKey(route: TelegramRoute): string {
        const mt = route.messageThreadId ?? '-';
        const dm = route.directMessagesTopicId ?? '-';
        return `${route.chatId}|mt:${mt}|dm:${dm}`;
    }

    private parseRouteKey(routeKey: string): TelegramRoute | null {
        const match = routeKey.match(/^(.*)\|mt:([^|]+)\|dm:([^|]+)$/);
        if (!match) return null;

        const [, chatId, mtRaw, dmRaw] = match;
        if (!chatId) return null;

        const mt = mtRaw !== '-' ? Number(mtRaw) : undefined;
        const dm = dmRaw !== '-' ? Number(dmRaw) : undefined;

        return {
            chatId,
            messageThreadId: Number.isFinite(mt) ? mt : undefined,
            directMessagesTopicId: Number.isFinite(dm) ? dm : undefined,
        };
    }

    private resolveRouteForApi(chatIdOrRouteKey: string): { routeKey: string; route: TelegramRoute; session?: ChatSession } {
        const direct = this.sessions.get(chatIdOrRouteKey);
        if (direct) {
            return { routeKey: chatIdOrRouteKey, route: direct.route, session: direct };
        }

        const parsedRoute = this.parseRouteKey(chatIdOrRouteKey);
        if (parsedRoute) {
            return { routeKey: chatIdOrRouteKey, route: parsedRoute, session: undefined };
        }

        const matches = Array.from(this.sessions.entries()).filter(([, s]) => s.route.chatId === chatIdOrRouteKey);
        if (matches.length === 1) {
            const [key, session] = matches[0]!;
            return { routeKey: key, route: session.route, session };
        }

        if (matches.length > 1) {
            throw new Error(`Ambiguous chat identifier "${chatIdOrRouteKey}". Use routeKey format.`);
        }

        throw new Error(`No active session for identifier "${chatIdOrRouteKey}".`);
    }

    private threadExtra(route: TelegramRoute): Record<string, unknown> {
        const extra: Record<string, unknown> = {};
        if (route.messageThreadId !== undefined) {
            extra['message_thread_id'] = route.messageThreadId;
        }
        if (route.directMessagesTopicId !== undefined) {
            extra['direct_messages_topic_id'] = route.directMessagesTopicId;
        }
        return extra;
    }

    private isMessageThreadNotFoundError(error: unknown): boolean {
        const description = (error as TelegramApiErrorLike)?.response?.description || '';
        return typeof description === 'string' && description.toLowerCase().includes('message thread not found');
    }

    private isRateLimitError(error: unknown): boolean {
        return (error as TelegramApiErrorLike)?.response?.error_code === 429;
    }

    private getRetryAfterMs(error: unknown): number {
        const retryAfter = (error as TelegramApiErrorLike)?.response?.parameters?.retry_after;
        if (typeof retryAfter === 'number' && retryAfter > 0) {
            return retryAfter * 1000;
        }
        return 1000;
    }

    private withoutMessageThread(route: TelegramRoute): TelegramRoute {
        return {
            ...route,
            messageThreadId: undefined,
        };
    }

    private async sendMessageToRoute(route: TelegramRoute, text: string, extra: Record<string, unknown> = {}): Promise<any> {
        try {
            return await this.bot.telegram.sendMessage(
                route.chatId,
                text,
                {
                    ...this.threadExtra(route),
                    ...extra,
                } as any
            );
        } catch (error) {
            if (this.isMessageThreadNotFoundError(error) && route.messageThreadId !== undefined) {
                const fallbackRoute = this.withoutMessageThread(route);
                return this.bot.telegram.sendMessage(
                    fallbackRoute.chatId,
                    text,
                    {
                        ...this.threadExtra(fallbackRoute),
                        ...extra,
                    } as any
                );
            }
            throw error;
        }
    }

    private async sendPhotoToRoute(route: TelegramRoute, source: string): Promise<any> {
        try {
            return await this.bot.telegram.sendPhoto(
                route.chatId,
                { source },
                this.threadExtra(route) as any
            );
        } catch (error) {
            if (this.isMessageThreadNotFoundError(error) && route.messageThreadId !== undefined) {
                const fallbackRoute = this.withoutMessageThread(route);
                return this.bot.telegram.sendPhoto(
                    fallbackRoute.chatId,
                    { source },
                    this.threadExtra(fallbackRoute) as any
                );
            }
            throw error;
        }
    }

    private async sendDocumentToRoute(route: TelegramRoute, source: string): Promise<any> {
        try {
            return await this.bot.telegram.sendDocument(
                route.chatId,
                { source },
                this.threadExtra(route) as any
            );
        } catch (error) {
            if (this.isMessageThreadNotFoundError(error) && route.messageThreadId !== undefined) {
                const fallbackRoute = this.withoutMessageThread(route);
                return this.bot.telegram.sendDocument(
                    fallbackRoute.chatId,
                    { source },
                    this.threadExtra(fallbackRoute) as any
                );
            }
            throw error;
        }
    }

    private async sendVoiceToRoute(route: TelegramRoute, source: string): Promise<any> {
        try {
            return await this.bot.telegram.sendVoice(
                route.chatId,
                { source },
                this.threadExtra(route) as any
            );
        } catch (error) {
            if (this.isMessageThreadNotFoundError(error) && route.messageThreadId !== undefined) {
                const fallbackRoute = this.withoutMessageThread(route);
                return this.bot.telegram.sendVoice(
                    fallbackRoute.chatId,
                    { source },
                    this.threadExtra(fallbackRoute) as any
                );
            }
            throw error;
        }
    }

    private async sendChatActionToRoute(route: TelegramRoute, action: 'typing'): Promise<void> {
        const extra: Record<string, unknown> = {};
        if (route.messageThreadId !== undefined) {
            extra['message_thread_id'] = route.messageThreadId;
        }

        try {
            await this.bot.telegram.sendChatAction(route.chatId, action, extra as any);
        } catch (error) {
            if (this.isMessageThreadNotFoundError(error) && route.messageThreadId !== undefined) {
                await this.bot.telegram.sendChatAction(route.chatId, action).catch(() => {
                    // ignore typing status failures
                });
                return;
            }
            // ignore typing status failures
        }
    }

    private async sendDraftToRoute(route: TelegramRoute, draftId: number, text: string, italic: boolean): Promise<void> {
        const chatId = Number(route.chatId);
        if (!Number.isFinite(chatId)) {
            throw new Error('sendMessageDraft requires numeric private chat id');
        }

        const payload: Record<string, unknown> = {
            chat_id: chatId,
            draft_id: draftId,
            text: italic ? `<i>${this.escapeHtml(text)}</i>` : text,
        };

        if (italic) {
            payload['parse_mode'] = 'HTML';
        }

        if (route.messageThreadId !== undefined) {
            payload['message_thread_id'] = route.messageThreadId;
        }

        try {
            await this.bot.telegram.callApi('sendMessageDraft' as any, payload as any);
        } catch (error) {
            if (this.isMessageThreadNotFoundError(error) && route.messageThreadId !== undefined) {
                const fallbackPayload = { ...payload };
                delete fallbackPayload['message_thread_id'];
                await this.bot.telegram.callApi('sendMessageDraft' as any, fallbackPayload as any);
                return;
            }
            throw error;
        }
    }

    private async deleteMessageSafe(chatId: string, messageId: number): Promise<void> {
        await this.bot.telegram.deleteMessage(chatId, messageId).catch(() => {
            // ignore delete errors
        });
    }

    private async editMessageSafe(
        chatId: string,
        messageId: number,
        text: string,
        extra: Record<string, unknown> = {}
    ): Promise<boolean> {
        try {
            await this.bot.telegram.editMessageText(chatId, messageId, undefined, text, extra as any);
            return true;
        } catch {
            return false;
        }
    }

    private nextDraftId(): number {
        this.draftCounter += 1;
        return this.draftCounter;
    }

    public async ask(chatId: string, question: string): Promise<string> {
        const { routeKey, route, session } = this.resolveRouteForApi(chatId);
        if (!session) throw new Error(`No session for route "${routeKey}"`);

        await this.sendMessageToRoute(route, `Question:\n${question}`);

        return new Promise((resolve) => {
            session.waitingForQuestionResponse = true;
            session.questionResolver = resolve;

            const idx = session.pendingMessages.findIndex((m) => Boolean(m.text));
            if (idx >= 0) {
                const [answer] = session.pendingMessages.splice(idx, 1);
                if (answer?.text) {
                    session.waitingForQuestionResponse = false;
                    session.questionResolver = null;
                    resolve(answer.text);

                    if (session.pendingMessages.length > 0) {
                        this.schedulePendingProcessing(routeKey);
                    }
                }
            }
        });
    }

    public async sendFiles(chatId: string, files: string[]): Promise<void> {
        const { route, session } = this.resolveRouteForApi(chatId);

        for (const file of files) {
            const fullPath = path.isAbsolute(file)
                ? file
                : session?.session
                    ? path.join(session.session.sandbox.directory, file)
                    : file;

            if (!fs.existsSync(fullPath)) {
                await this.sendMessageToRoute(route, `File not found: ${file}`);
                continue;
            }

            try {
                const ext = path.extname(file).toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
                    await this.sendPhotoToRoute(route, fullPath);
                } else {
                    await this.sendDocumentToRoute(route, fullPath);
                }
            } catch (e: any) {
                await this.sendMessageToRoute(route, `Failed to send ${file}: ${e.message}`);
            }
        }
    }

    public async sendVoice(chatId: string, filePath: string): Promise<void> {
        const { route } = this.resolveRouteForApi(chatId);

        if (!fs.existsSync(filePath)) {
            throw new Error(`Voice file not found: ${filePath}`);
        }

        try {
            await this.sendVoiceToRoute(route, filePath);
        } catch (e: any) {
            throw new Error(`Failed to send voice message: ${e.message}`);
        }
    }

    public async sendText(chatId: string, text: string): Promise<void> {
        const { route } = this.resolveRouteForApi(chatId);
        try {
            await this.sendMessageToRoute(route, text);
        } catch (e: any) {
            throw new Error(`Failed to send text message: ${e.message}`);
        }
    }

    public async broadcast(messageText: string): Promise<void> {
        for (const chatId of this.authorizedUsers) {
            try {
                await this.bot.telegram.sendMessage(chatId, messageText);
            } catch (e) {
                console.error(`Failed to broadcast to ${chatId}:`, e);
            }
        }
    }

    public async start(): Promise<void> {
        console.log(chalk.blue('Starting Telegram Bot Service...'));
        console.log(chalk.gray(`Access Code: ${chalk.bold(this.accessCode)}`));

        await new Promise<void>((resolve) => {
            this.server = this.app.listen(0, () => {
                const addr = this.server?.address() as AddressInfo;
                this.apiUrl = `http://localhost:${addr.port}`;
                console.log(chalk.gray(`Internal API listening on ${this.apiUrl}`));
                resolve();
            });
        });

        this.bot.launch(({
            dropPendingUpdates: false,
            allowedUpdates: ['message', 'callback_query'],
        }), () => {
            console.log(chalk.green('Telegram bot is online'));
        }).catch((err) => {
            console.error(chalk.red('Failed to launch Telegram bot:'), err);
        });

        process.once('SIGINT', () => this.bot.stop('SIGINT'));
        process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
    }
}
