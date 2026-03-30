
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
import { runWithAgentContext } from '../core/AgentContext.js';
import { getProvider } from '../providers/base.js';
import { getSyntax } from '../syntax/base.js';
import { getLoop } from '../loops/base.js';
import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { COLORS, SYMBOLS, StreamDisplay } from '../cli/display.js';
import { getInterfaceRouteRegistry } from '../interfaces/registry.js';
import type { InterfaceRouteHandler, InterfaceUiEventPayload } from '../interfaces/base.js';

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
const ROOT_UI_SCOPE_ID = 'root';

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
    uiQueue: Promise<void>;
    uiScopes: Map<string, TelegramUiState>;
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
    private pendingQuestions = new Map<string, { answer?: string; resolver?: (response: string) => void }>();
    private questionCounter = 0;

    constructor() {
        this.bot = new Telegraf(BOT_TOKEN);
        this.agentLoader = new AgentLoader();
        this.toolLoader = new ToolLoader();
        this.accessCode = Math.random().toString(36).slice(-6).toUpperCase();
        this.display = new StreamDisplay();

        this.app = express();
        this.app.use(express.json({ limit: '2mb' }));
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
            const { chatId, question, agentName } = req.body as { chatId?: string; question?: string; agentName?: string };
            if (!chatId || !question) {
                res.status(400).json({ error: 'Missing parameters' });
                return;
            }

            try {
                const questionId = `q_${++this.questionCounter}_${Date.now()}`;

                // Create pending question entry
                const entry: { answer?: string; resolver?: (response: string) => void } = {};
                this.pendingQuestions.set(questionId, entry);

                // Start the ask flow (non-blocking — answer will be stored when user replies)
                this.ask(chatId, question, agentName).then((answer) => {
                    const pending = this.pendingQuestions.get(questionId);
                    if (pending) {
                        pending.answer = answer;
                    }
                }).catch((e) => {
                    // Store error as answer so poll can return it
                    const pending = this.pendingQuestions.get(questionId);
                    if (pending) {
                        pending.answer = `[ERROR] ${e.message}`;
                    }
                });

                // Return immediately with questionId
                res.json({ questionId });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        // Poll for answer to a previously asked question
        this.app.get('/api/ask/poll', async (req, res): Promise<void> => {
            const questionId = req.query.questionId as string;
            if (!questionId) {
                res.status(400).json({ error: 'Missing questionId parameter' });
                return;
            }

            const pending = this.pendingQuestions.get(questionId);
            if (!pending) {
                res.status(404).json({ error: 'Question not found or already completed' });
                return;
            }

            if (pending.answer !== undefined) {
                // Answer is ready — return it and clean up
                const answer = pending.answer;
                this.pendingQuestions.delete(questionId);
                res.json({ status: 'answered', response: answer });
            } else {
                // Still waiting
                res.json({ status: 'waiting' });
            }
        });

        this.app.post('/api/sendFiles', async (req, res): Promise<void> => {
            const { chatId, files, agentName } = req.body as { chatId?: string; files?: string[]; agentName?: string };
            if (!chatId || !files) {
                res.status(400).json({ error: 'Missing parameters' });
                return;
            }

            try {
                await this.sendFiles(chatId, files, agentName);
                res.json({ success: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/sendVoice', async (req, res): Promise<void> => {
            const { chatId, file, agentName } = req.body as { chatId?: string; file?: string; agentName?: string };
            if (!chatId || !file) {
                res.status(400).json({ error: 'Missing parameters' });
                return;
            }

            try {
                await this.sendVoice(chatId, file, agentName);
                res.json({ success: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/sendText', async (req, res): Promise<void> => {
            const { chatId, text, agentName } = req.body as { chatId?: string; text?: string; agentName?: string };
            if (!chatId || !text) {
                res.status(400).json({ error: 'Missing parameters' });
                return;
            }

            try {
                await this.sendText(chatId, text, agentName);
                res.json({ success: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/sendAuthLink', async (req, res): Promise<void> => {
            const { chatId, text, url, label, agentName } = req.body as { chatId?: string; text?: string; url?: string; label?: string; agentName?: string };
            if (!chatId || !text || !url) {
                res.status(400).json({ error: 'Missing parameters' });
                return;
            }

            try {
                await this.sendAuthLink(chatId, text, url, label || 'Open Login', agentName);
                res.json({ success: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/ui/event', async (req, res): Promise<void> => {
            const {
                chatId,
                scopeId,
                event,
                agentName,
                accumulated,
                text,
                code,
                command,
                filename,
                content,
            } = req.body as {
                chatId?: string;
                scopeId?: string;
                event?: string;
                agentName?: string;
                accumulated?: string;
                text?: string;
                code?: string;
                command?: string;
                filename?: string;
                content?: string;
            };

            if (!chatId || !scopeId || !event) {
                res.status(400).json({ error: 'Missing parameters' });
                return;
            }

            try {
                const { routeKey, session } = await this.resolveRouteForApi(chatId, agentName);
                if (!session) {
                    throw new Error(`No session for route "${routeKey}"`);
                }

                await this.handleUiEvent(routeKey, {
                    scopeId,
                    event,
                    agentName,
                    accumulated,
                    text,
                    code,
                    command,
                    filename,
                    content,
                });

                res.json({ success: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });
    }

    private async handleUiEvent(routeKey: string, payload: InterfaceUiEventPayload): Promise<void> {
        switch (payload.event) {
            case 'executor.before_provider_call':
                this.resetUiScope(routeKey, payload.scopeId);
                break;
            case 'executor.reasoning_delta':
                this.pushReasoningPreview(routeKey, payload.scopeId, payload.accumulated || '');
                break;
            case 'executor.text_delta':
                this.pushTextPreview(routeKey, payload.scopeId, payload.accumulated || '');
                break;
            case 'executor.text_done':
                this.finalizeScopeText(routeKey, payload.scopeId, payload.text || '');
                break;
            case 'executor.action':
                this.showExecutionForScope(routeKey, payload.scopeId, 'Executing action...', payload.code || '');
                break;
            case 'executor.cli':
                this.showExecutionForScope(routeKey, payload.scopeId, 'Executing action...', payload.command || '');
                break;
            case 'executor.file':
                this.showExecutionForScope(routeKey, payload.scopeId, 'Executing action...', `// file: ${payload.filename || '(unknown)'}\n${payload.content || ''}`);
                break;
            case 'executor.observation':
                this.showObservationForScope(routeKey, payload.scopeId, payload.content || '');
                break;
            case 'executor.response':
                this.finalizeUiScope(routeKey, payload.scopeId, payload.content || payload.text || '');
                break;
            default:
                throw new Error(`Unsupported UI event "${payload.event}"`);
        }
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

            for (const ui of current.uiScopes.values()) {
                await this.cleanupTurnArtifacts(current, ui);
                await this.clearLivePreview(current, ui);
                await this.clearDraftBestEffort(current.route, ui.currentDraftId);
            }

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
            current.uiQueue = Promise.resolve();
            current.uiScopes = new Map([[ROOT_UI_SCOPE_ID, this.createUiState()]]);

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
            uiQueue: Promise.resolve(),
            uiScopes: new Map([[ROOT_UI_SCOPE_ID, this.createUiState()]]),
        };
    }

    private registerRouteHandler(routeKey: string): void {
        const handler: InterfaceRouteHandler = {
            routeId: routeKey,
            interfaceName: 'telegram',
            getAgentName: () => this.sessions.get(routeKey)?.agentName,
            ensureAgent: async (preferredAgentName?: string) => {
                const session = this.sessions.get(routeKey);
                if (!session) return;
                await this.ensureSessionAgent(routeKey, session.route, preferredAgentName);
            },
            ask: async (question: string, preferredAgentName?: string) => this.ask(routeKey, question, preferredAgentName),
            sendText: async (text: string, preferredAgentName?: string) => this.sendText(routeKey, text, preferredAgentName),
            sendVoice: async (filePath: string, preferredAgentName?: string) => this.sendVoice(routeKey, filePath, preferredAgentName),
            sendFiles: async (files: string[], preferredAgentName?: string) => this.sendFiles(routeKey, files, preferredAgentName),
            sendAuthLink: async (text: string, url: string, label?: string, preferredAgentName?: string) =>
                this.sendAuthLink(routeKey, text, url, label, preferredAgentName),
            emitUiEvent: async (payload: InterfaceUiEventPayload) => {
                await this.handleUiEvent(routeKey, payload);
            },
        };
        getInterfaceRouteRegistry().register(handler);
    }

    private async showAgentMenu(ctx: Context): Promise<void> {
        const agents = (await this.agentLoader.loadAll())
            .filter(agent => (agent.config.interface || 'telegram') === 'telegram')
            .map(agent => agent.config.name);
        const route = this.extractRouteFromContext(ctx);
        const buttons = agents.map((a) => [Markup.button.text(`Select: ${a}`)]);
        const keyboard = Markup.keyboard(buttons).oneTime().resize();
        await this.sendMessageToRoute(route, 'Select an agent to start a session:', keyboard.reply_markup as any);
    }

    private async initializeSession(routeKey: string, route: TelegramRoute, agentName: string): Promise<void> {
        const existing = this.sessions.get(routeKey) || this.createEmptySession(route);
        existing.route = route;
        existing.agentName = agentName;
        this.registerRouteHandler(routeKey);

        let agent = await this.agentLoader.loadByName(agentName);
        if (!agent) {
            const availableAgents = await this.agentLoader.getAvailableAgents();
            const match = availableAgents.find(name => name.toLowerCase() === agentName.toLowerCase());
            if (match) {
                agent = await this.agentLoader.loadByName(match);
            }
        }
        if (!agent) {
            await this.sendMessageToRoute(route, 'Agent not found.');
            return;
        }
        if ((agent.config.interface || 'telegram') !== 'telegram') {
            await this.sendMessageToRoute(route, `Agent "${agent.config.name}" is bound to interface "${agent.config.interface}" and cannot be launched in Telegram.`);
            return;
        }
        if ((agent.config.modality || 'text') !== 'text') {
            await this.sendMessageToRoute(route, `Agent "${agent.config.name}" uses modality "${agent.config.modality}" and cannot run in Telegram chat mode.`);
            return;
        }
        existing.agentName = agent.config.name;

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

        const callbacks = this.createExecutorCallbacks(routeKey, ROOT_UI_SCOPE_ID);
        existing.executor = new Executor(existing.session, {
            stream: true,
            callbacks,
            requireFinish: agent.config.requireFinish,
        });

        this.sessions.set(routeKey, existing);

        console.log(COLORS.secondary(`\n${SYMBOLS.assistant} Session started with agent: ${existing.agentName}`));
        console.log(COLORS.muted(`Route: ${routeKey}`));
        console.log(COLORS.muted('--------------------------------------------------'));

        await this.sendMessageToRoute(route, `Session started with ${existing.agentName}.`, {
            ...Markup.removeKeyboard(),
        });
    }

    private getOrCreateUiState(session: ChatSession, scopeId: string): TelegramUiState {
        let ui = session.uiScopes.get(scopeId);
        if (!ui) {
            ui = this.createUiState();
            session.uiScopes.set(scopeId, ui);
        }
        return ui;
    }

    private createExecutorCallbacks(routeKey: string, scopeId: string): ExecutorCallbacks {
        return {
            onBeforeProviderCall: () => {
                this.display.reset();
                this.resetUiScope(routeKey, scopeId);
            },
            onReasoningDelta: (delta, accumulated) => {
                this.display.startReasoning();
                this.display.writeReasoning(delta);
                this.pushReasoningPreview(routeKey, scopeId, accumulated);
            },
            onReasoningDone: () => {
                this.display.endReasoning();
            },
            onTextDelta: (delta, accumulated) => {
                this.display.startText();
                this.display.writeText(delta);
                this.pushTextPreview(routeKey, scopeId, accumulated);
            },
            onTextDone: (fullText) => {
                this.display.endText();
                this.finalizeScopeText(routeKey, scopeId, fullText);
            },
            onAction: (code) => {
                this.display.showAction(code);
                this.showExecutionForScope(routeKey, scopeId, 'Executing action...', code);
            },
            onCli: (command) => {
                this.display.showAction(command);
                this.showExecutionForScope(routeKey, scopeId, 'Executing action...', command);
            },
            onFile: (filename, content) => {
                this.display.showAction(`file: ${filename}`);
                this.showExecutionForScope(routeKey, scopeId, 'Executing action...', `// file: ${filename}\n${content}`);
            },
            onObservation: (content) => {
                this.display.showObservation(content);
                this.showObservationForScope(routeKey, scopeId, content);
            },
            onResponse: (content) => {
                this.display.finalize();
                console.log('');
                this.finalizeUiScope(routeKey, scopeId, content);
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

        session.uiQueue = session.uiQueue
            .then(async () => task(session))
            .catch((error) => {
                console.error(`[Telegram UI] ${routeKey}:`, error);
            });
    }

    private resetUiScope(routeKey: string, scopeId: string): void {
        this.enqueueUiTask(routeKey, async (session) => {
            const ui = this.getOrCreateUiState(session, scopeId);
            await this.cleanupTurnArtifacts(session, ui);
            await this.clearLivePreview(session, ui);
            ui.currentDraftId = this.nextDraftId();
            ui.reasoningAccumulated = '';
            ui.textAccumulated = '';
            ui.previewText = '';
            ui.previewItalic = false;
            ui.previewDirty = false;
            ui.previewIntervalMs = PREVIEW_INTERVAL_DEFAULT_MS;
            ui.previewNextAllowedAtMs = 0;
        });
    }

    private pushReasoningPreview(routeKey: string, scopeId: string, accumulated: string): void {
        const session = this.sessions.get(routeKey);
        if (!session) return;
        const ui = this.getOrCreateUiState(session, scopeId);
        ui.reasoningAccumulated = accumulated;
        this.updatePreviewState(routeKey, scopeId, accumulated, true);
    }

    private pushTextPreview(routeKey: string, scopeId: string, accumulated: string): void {
        const session = this.sessions.get(routeKey);
        if (!session) return;
        const ui = this.getOrCreateUiState(session, scopeId);
        ui.textAccumulated = accumulated;
        this.updatePreviewState(routeKey, scopeId, accumulated, false);
    }

    private finalizeScopeText(routeKey: string, scopeId: string, fullText: string): void {
        this.enqueueUiTask(routeKey, async (session) => {
            const ui = this.getOrCreateUiState(session, scopeId);
            ui.textAccumulated = fullText;
            if (fullText.trim()) {
                await this.sendPersistentText(session.route, fullText);
            }
            await this.clearLivePreview(session, ui);
            await this.clearDraftBestEffort(session.route, ui.currentDraftId);
        });
    }

    private showExecutionForScope(routeKey: string, scopeId: string, header: string, payload: string): void {
        this.enqueueUiTask(routeKey, async (session) => {
            const ui = this.getOrCreateUiState(session, scopeId);
            await this.clearLivePreview(session, ui);
            await this.clearDraftBestEffort(session.route, ui.currentDraftId);

            const ids = await this.sendExecutionBlock(session.route, header, payload);
            ui.currentTurnActionMessageIds.push(...ids);
        });
    }

    private showObservationForScope(routeKey: string, scopeId: string, content: string): void {
        this.enqueueUiTask(routeKey, async (session) => {
            const ui = this.getOrCreateUiState(session, scopeId);
            const ids = await this.sendObservationBlock(session.route, content);
            ui.currentTurnObservationMessageIds.push(...ids);
        });
    }

    private finalizeUiScope(routeKey: string, scopeId: string, content?: string): void {
        this.enqueueUiTask(routeKey, async (session) => {
            const ui = this.getOrCreateUiState(session, scopeId);
            const completionText = (content || '').trim();
            const streamedText = ui.textAccumulated.trim();

            if (completionText && completionText !== streamedText) {
                await this.sendPersistentText(session.route, completionText);
            }

            await this.cleanupTurnArtifacts(session, ui);
            await this.clearLivePreview(session, ui);
            await this.clearDraftBestEffort(session.route, ui.currentDraftId);

            if (scopeId !== ROOT_UI_SCOPE_ID) {
                session.uiScopes.delete(scopeId);
            }
        });
    }

    private async handleUserActivity(routeKey: string, route: TelegramRoute, activity: PendingMessage): Promise<void> {
        let session = this.sessions.get(routeKey);
        if (!session) {
            session = this.createEmptySession(route);
            session.agentName = 'core';
            this.sessions.set(routeKey, session);
            this.registerRouteHandler(routeKey);

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
                ACN_API_URL: process.env.ACN_INTERFACE_API_URL || this.apiUrl,
                ACN_CHAT_ID: routeKey,
                ACN_INTERFACE_API_URL: process.env.ACN_INTERFACE_API_URL || this.apiUrl,
                ACN_INTERFACE_ROUTE: routeKey,
            };

            await actionContext.run({ chatId: routeKey, telegramService: this, sessionId: session.session?.id, env }, async () => {
                const activeSession = session.session;
                if (!activeSession) {
                    throw new Error('Session is not initialized');
                }

                await runWithAgentContext(
                    activeSession.agent.config.name,
                    () => session.executor!.execute(combinedText),
                    undefined,
                    true,
                    activeSession.sandbox,
                    activeSession.agent.config.modelSwitching,
                    activeSession.agent
                );
            });

            await session.uiQueue;
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

    private updatePreviewState(routeKey: string, scopeId: string, content: string, italic: boolean): void {
        const session = this.sessions.get(routeKey);
        if (!session) return;

        const ui = this.getOrCreateUiState(session, scopeId);
        ui.previewText = this.clipForStream(content, STREAM_PREVIEW_LIMIT);
        ui.previewItalic = italic;
        ui.previewDirty = true;
        this.schedulePreviewFlush(routeKey, scopeId);
    }

    private schedulePreviewFlush(routeKey: string, scopeId: string, forceDelayMs?: number): void {
        const session = this.sessions.get(routeKey);
        if (!session) return;
        const ui = this.getOrCreateUiState(session, scopeId);

        if (ui.previewFlushTimer) {
            return;
        }

        const now = Date.now();
        const dueIn = Math.max(
            forceDelayMs ?? ui.previewIntervalMs,
            ui.previewNextAllowedAtMs - now,
            0
        );

        ui.previewFlushTimer = setTimeout(() => {
            const s = this.sessions.get(routeKey);
            if (!s) return;
            const liveUi = s.uiScopes.get(scopeId);
            if (!liveUi) return;
            liveUi.previewFlushTimer = null;
            this.enqueueUiTask(routeKey, async (liveSession) => {
                await this.flushPreview(liveSession, scopeId, routeKey);
            });
        }, dueIn);
    }

    private async flushPreview(session: ChatSession, scopeId: string, routeKey: string): Promise<void> {
        const ui = session.uiScopes.get(scopeId);
        if (!ui || !ui.previewDirty) return;
        if (ui.previewFlushInFlight) {
            this.schedulePreviewFlush(routeKey, scopeId, ui.previewIntervalMs);
            return;
        }

        const now = Date.now();
        if (ui.previewNextAllowedAtMs > now) {
            this.schedulePreviewFlush(routeKey, scopeId, ui.previewNextAllowedAtMs - now);
            return;
        }

        const preview = ui.previewText;
        const italic = ui.previewItalic;
        ui.previewDirty = false;
        ui.previewFlushInFlight = true;
        const startedAt = Date.now();

        try {
            if (ui.transport === 'draft') {
                await this.sendDraftToRoute(session.route, ui.currentDraftId, preview, italic);
            } else {
                await this.upsertLivePreviewMessage(session, ui, preview, italic);
            }

            const elapsed = Date.now() - startedAt;
            if (elapsed < ui.previewIntervalMs * 0.8) {
                ui.previewIntervalMs = Math.max(PREVIEW_INTERVAL_MIN_MS, Math.floor(ui.previewIntervalMs * 0.9));
            } else if (elapsed > ui.previewIntervalMs * 1.6) {
                ui.previewIntervalMs = Math.min(PREVIEW_INTERVAL_MAX_MS, Math.floor(ui.previewIntervalMs * 1.2));
            }
        } catch (error) {
            if (this.isRateLimitError(error)) {
                const retryMs = this.getRetryAfterMs(error);
                ui.previewNextAllowedAtMs = Date.now() + retryMs;
                ui.previewIntervalMs = Math.min(PREVIEW_INTERVAL_MAX_MS, Math.floor(ui.previewIntervalMs * 1.5));
                ui.previewDirty = true;
                this.schedulePreviewFlush(routeKey, scopeId, retryMs);
                return;
            }

            if (ui.transport === 'draft') {
                console.warn(`[Telegram] sendMessageDraft failed for ${this.routeKey(session.route)}. Falling back to send/edit:`, error);
                ui.transport = 'message';
                ui.previewDirty = true;
                this.schedulePreviewFlush(routeKey, scopeId, 0);
                return;
            }

            throw error;
        } finally {
            ui.previewFlushInFlight = false;
        }

        if (ui.previewDirty) {
            this.schedulePreviewFlush(routeKey, scopeId);
        }
    }

    private async upsertLivePreviewMessage(session: ChatSession, ui: TelegramUiState, text: string, italic: boolean): Promise<void> {
        const route = session.route;
        const content = italic ? `<i>${this.escapeHtml(text)}</i>` : text;
        const extra = italic
            ? ({ parse_mode: 'HTML', disable_web_page_preview: true } as const)
            : ({ disable_web_page_preview: true } as const);

        if (!ui.livePreviewMessageId) {
            const sent = await this.sendMessageToRoute(route, content, extra as any);
            ui.livePreviewMessageId = sent.message_id;
            return;
        }

        const edited = await this.editMessageSafe(route.chatId, ui.livePreviewMessageId, content, extra as any);
        if (!edited) {
            const sent = await this.sendMessageToRoute(route, content, extra as any);
            ui.livePreviewMessageId = sent.message_id;
        }
    }

    private async clearLivePreview(session: ChatSession, ui: TelegramUiState): Promise<void> {
        if (ui.previewFlushTimer) {
            clearTimeout(ui.previewFlushTimer);
            ui.previewFlushTimer = null;
        }
        ui.previewDirty = false;
        ui.previewFlushInFlight = false;

        if (ui.livePreviewMessageId) {
            await this.deleteMessageSafe(session.route.chatId, ui.livePreviewMessageId);
            ui.livePreviewMessageId = null;
        }
    }

    private async clearDraftBestEffort(route: TelegramRoute, draftId: number): Promise<void> {
        try {
            await this.sendDraftToRoute(route, draftId, '\u2060', false);
        } catch {
            // ignore
        }
    }

    private async cleanupTurnArtifacts(session: ChatSession, ui: TelegramUiState): Promise<void> {
        const ids = [...ui.currentTurnActionMessageIds, ...ui.currentTurnObservationMessageIds];
        for (const id of ids) {
            await this.deleteMessageSafe(session.route.chatId, id);
        }
        ui.currentTurnActionMessageIds = [];
        ui.currentTurnObservationMessageIds = [];
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

    private normalizePreferredAgentName(agentName?: string): string | undefined {
        const normalized = String(agentName || '').trim();
        return normalized || undefined;
    }

    private async ensureSessionAgent(routeKey: string, route: TelegramRoute, preferredAgentName?: string): Promise<ChatSession | undefined> {
        const session = this.sessions.get(routeKey);
        if (!session) {
            return undefined;
        }

        const preferred = this.normalizePreferredAgentName(preferredAgentName);
        if (!preferred) {
            return session;
        }

        const current = String(session.agentName || '').trim();
        if (current && current.toLowerCase() === preferred.toLowerCase()) {
            return session;
        }

        session.agentName = preferred;
        await this.initializeSession(routeKey, route, preferred);
        return this.sessions.get(routeKey);
    }

    private async getHeartbeatRouteAndSession(preferredAgentName?: string): Promise<{ routeKey: string; route: TelegramRoute; session?: ChatSession }> {
        // Find owner ID
        let ownerId: string | null = null;
        if (this.authorizedUsers.size > 0) {
            ownerId = Array.from(this.authorizedUsers)[0] ?? null;
        }
        if (!ownerId && process.env.ACN_CHAT_ID && process.env.ACN_CHAT_ID !== 'HEARTBEAT_ROUTE') {
            ownerId = process.env.ACN_CHAT_ID;
        }

        if (!ownerId) {
            try {
                if (fs.existsSync(OWNER_FILE)) {
                    const data = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf-8')) as { id?: string };
                    if (data.id) ownerId = data.id.toString();
                }
            } catch { }
        }

        if (!ownerId) {
            throw new Error('No owner found to send heartbeat message to.');
        }

        const heartbeatTopicCacheFile = path.join(__dirname, '..', '..', 'tools', 'message', 'heartbeat_topic.json');
        let messageThreadId: number | undefined;

        try {
            if (fs.existsSync(heartbeatTopicCacheFile)) {
                const data = JSON.parse(fs.readFileSync(heartbeatTopicCacheFile, 'utf-8')) as { message_thread_id?: number };
                if (typeof data.message_thread_id === 'number') {
                    messageThreadId = data.message_thread_id;
                }
            }
        } catch { }

        if (messageThreadId === undefined) {
            // Create the topic
            try {
                const topic = await this.bot.telegram.createForumTopic(ownerId, "💓Heartbeat");
                messageThreadId = topic.message_thread_id;
                try {
                    const dir = path.dirname(heartbeatTopicCacheFile);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(heartbeatTopicCacheFile, JSON.stringify({ message_thread_id: messageThreadId }));
                } catch { }
            } catch (err: any) {
                // Ignore if chat is not a forum or we don't have permission
                console.warn('[Telegram] Could not create 💓Heartbeat topic:', err.message);
            }
        }

        const route: TelegramRoute = {
            chatId: ownerId,
            messageThreadId,
        };

        const routeKey = this.routeKey(route);
        let session = this.sessions.get(routeKey);
        if (!session) {
            session = this.createEmptySession(route);
            session.agentName = this.normalizePreferredAgentName(preferredAgentName) || 'CORE';
            this.sessions.set(routeKey, session);
            this.registerRouteHandler(routeKey);
            await this.initializeSession(routeKey, route, session.agentName);
            session = this.sessions.get(routeKey);
        } else {
            session = await this.ensureSessionAgent(routeKey, route, preferredAgentName);
        }

        return { routeKey, route, session };
    }

    private async resolveRouteForApi(chatIdOrRouteKey: string, preferredAgentName?: string): Promise<{ routeKey: string; route: TelegramRoute; session?: ChatSession }> {
        if (chatIdOrRouteKey === 'HEARTBEAT_ROUTE') {
            return await this.getHeartbeatRouteAndSession(preferredAgentName);
        }

        const direct = this.sessions.get(chatIdOrRouteKey);
        if (direct) {
            this.registerRouteHandler(chatIdOrRouteKey);
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

    private clearHeartbeatTopicCacheIfMatches(threadId: number) {
        const heartbeatTopicCacheFile = path.join(__dirname, '..', '..', 'tools', 'message', 'heartbeat_topic.json');
        try {
            if (fs.existsSync(heartbeatTopicCacheFile)) {
                const data = JSON.parse(fs.readFileSync(heartbeatTopicCacheFile, 'utf-8')) as { message_thread_id?: number };
                if (data.message_thread_id === threadId) {
                    fs.unlinkSync(heartbeatTopicCacheFile);
                }
            }
        } catch { }
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
                this.clearHeartbeatTopicCacheIfMatches(route.messageThreadId);
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
                this.clearHeartbeatTopicCacheIfMatches(route.messageThreadId);
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
                this.clearHeartbeatTopicCacheIfMatches(route.messageThreadId);
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
                this.clearHeartbeatTopicCacheIfMatches(route.messageThreadId);
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
                this.clearHeartbeatTopicCacheIfMatches(route.messageThreadId);
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
                this.clearHeartbeatTopicCacheIfMatches(route.messageThreadId);
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

    public async ask(chatId: string, question: string, preferredAgentName?: string): Promise<string> {
        const { routeKey, route, session } = await this.resolveRouteForApi(chatId, preferredAgentName);
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

    public async sendFiles(chatId: string, files: string[], preferredAgentName?: string): Promise<void> {
        const { route, session } = await this.resolveRouteForApi(chatId, preferredAgentName);

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

    public async sendVoice(chatId: string, filePath: string, preferredAgentName?: string): Promise<void> {
        const { route } = await this.resolveRouteForApi(chatId, preferredAgentName);

        if (!fs.existsSync(filePath)) {
            throw new Error(`Voice file not found: ${filePath}`);
        }

        try {
            await this.sendVoiceToRoute(route, filePath);
        } catch (e: any) {
            throw new Error(`Failed to send voice message: ${e.message}`);
        }
    }

    public async sendText(chatId: string, text: string, preferredAgentName?: string): Promise<void> {
        const { route } = await this.resolveRouteForApi(chatId, preferredAgentName);
        try {
            await this.sendMessageToRoute(route, text);
        } catch (e: any) {
            throw new Error(`Failed to send text message: ${e.message}`);
        }
    }

    public async sendAuthLink(chatId: string, text: string, url: string, label = 'Open Login', preferredAgentName?: string): Promise<void> {
        const { route } = await this.resolveRouteForApi(chatId, preferredAgentName);
        try {
            await this.sendMessageToRoute(route, text, {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.url(label, url)]
                ]).reply_markup
            });
        } catch (e: any) {
            throw new Error(`Failed to send auth link: ${e.message}`);
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
                process.env.ACN_API_URL = this.apiUrl; // Provide globally to agents
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
