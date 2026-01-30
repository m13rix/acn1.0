import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAgents } from '../core/agentLoader.js';
import { Agent } from '../core/agent.js';
import { 
  getAllChats, 
  getChatById, 
  createChat, 
  updateChat, 
  deleteChat,
  branchChat,
  generateTitleFromMessage 
} from './chatStorage.js';
import dotenv from 'dotenv';
import { clerkMiddleware, getAuth } from '@clerk/express';
import { getSubscription, upsertSubscription, addTopUp, setDailySoftCapBypass, requireActiveSubscription } from './subscriptionStorage.js';
import { computeLimits, canSpendToday, getUsage } from './usageTracker.js';
import { createPayment, getPaymentStatus } from './yookassaService.js';
import { loadJson, saveJson } from './s3Storage.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow dev server
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 50 * 1024 * 1024 // 50MB limit for large images
});

const PORT = process.env.PORT || 1314;

app.use(cors());
app.use(express.json({ limit: '100mb' })); // Increased limit for attachments
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(clerkMiddleware());

function requireUserId(req, res) {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return userId;
}

// ==========================================
// BILLING / SUBSCRIPTION API ENDPOINTS
// ==========================================

const PAYMENT_PREFIX = 'billing/payments/';
function paymentKey(paymentId) {
  return `${PAYMENT_PREFIX}${paymentId}.json`;
}

app.get('/api/subscription', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const sub = await getSubscription(userId);
    res.json({ subscription: sub });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/subscription', async (req, res) => {
  try {
    // Legacy stub endpoint (kept for backwards compatibility).
    // Real payments must be created via /api/payments/create and confirmed via YooKassa.
    res.status(410).json({ error: 'PAYMENTS_FLOW_REQUIRED' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/usage', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const limits = await computeLimits(userId);
    res.json(limits);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/topup', async (req, res) => {
  try {
    // Legacy stub endpoint (kept for backwards compatibility).
    // Real payments must be created via /api/payments/create and confirmed via YooKassa.
    res.status(410).json({ error: 'PAYMENTS_FLOW_REQUIRED' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==========================================
// YOOKASSA PAYMENT FLOW
// ==========================================

app.post('/api/payments/create', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const {
      kind, // 'subscription' | 'topup'
      planType,
      priceRub,
      periodDays,
      amountRub,
      profitShare
    } = req.body || {};

    const cleanKind = String(kind || '').toLowerCase();
    if (cleanKind !== 'subscription' && cleanKind !== 'topup') {
      return res.status(400).json({ error: 'Invalid kind' });
    }

    let rubToCharge = null;
    let originalAmount = null;
    let description = 'Оплата Telos Spark';
    let metadata = { userId, kind: cleanKind };

    // YooKassa комиссия 3.5%
    const YOOKASSA_FEE_RATE = 0.035;

    if (cleanKind === 'subscription') {
      const pr = typeof priceRub === 'number' ? priceRub : Number(priceRub);
      const pd = typeof periodDays === 'number' ? periodDays : Number(periodDays);
      if (!Number.isFinite(pr) || pr <= 0) return res.status(400).json({ error: 'Invalid priceRub' });
      if (!Number.isFinite(pd) || pd <= 0) return res.status(400).json({ error: 'Invalid periodDays' });

      originalAmount = pr;
      // Добавляем 3.5% комиссии ЮКассы к сумме платежа
      rubToCharge = Math.round(pr * (1 + YOOKASSA_FEE_RATE) * 100) / 100;
      description = `Подписка Telos Spark (${pr} ₽ / ${pd} дн.)`;
      metadata = {
        ...metadata,
        planType: String(planType || ''),
        priceRub: pr,
        periodDays: Math.floor(pd),
        profitShare: (profitShare !== undefined ? profitShare : undefined)
      };
    } else {
      const ar = typeof amountRub === 'number' ? amountRub : Number(amountRub);
      if (!Number.isFinite(ar) || ar <= 0) return res.status(400).json({ error: 'Invalid amountRub' });
      
      originalAmount = ar;
      // Добавляем 3.5% комиссии ЮКассы к сумме платежа
      rubToCharge = Math.round(ar * (1 + YOOKASSA_FEE_RATE) * 100) / 100;
      description = `Пополнение Telos Spark (${ar} ₽)`;
      metadata = {
        ...metadata,
        amountRub: ar,
        profitShare: (profitShare !== undefined ? profitShare : undefined)
      };
    }

    const created = await createPayment({
      amountRub: rubToCharge,
      description,
      metadata
    });

    res.status(201).json({
      kind: cleanKind,
      paymentId: created.paymentId,
      confirmationToken: created.confirmationToken
    });
  } catch (error) {
    const status = error?.status && Number.isFinite(error.status) ? error.status : 500;
    res.status(status).json({ error: error.message, details: error.details });
  }
});

app.get('/api/payments/:id/status', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const paymentId = req.params.id;
    const payment = await getPaymentStatus(paymentId);

    const metaUserId = payment?.metadata?.userId;
    if (!metaUserId || String(metaUserId) !== String(userId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Idempotent application: store "applied" marker per paymentId
    const existing = await loadJson(paymentKey(paymentId));
    if (existing?.applied) {
      return res.json({
        paymentId,
        status: payment?.status,
        paid: !!payment?.paid,
        applied: true,
        result: existing.result || null
      });
    }

    const status = payment?.status;
    const paid = !!payment?.paid;
    const kind = String(payment?.metadata?.kind || '').toLowerCase();

    if (status !== 'succeeded' || !paid) {
      return res.json({
        paymentId,
        status,
        paid,
        applied: false
      });
    }

    let result = null;
    if (kind === 'subscription') {
      const { planType, priceRub, periodDays, profitShare } = payment.metadata || {};
      const sub = await upsertSubscription(userId, { planType, priceRub, periodDays, profitShare });
      result = { kind, subscription: sub };
    } else if (kind === 'topup') {
      const { amountRub, profitShare } = payment.metadata || {};
      const top = await addTopUp(userId, { amountRub, profitShare });
      result = { kind, ...top };
    } else {
      return res.status(400).json({ error: 'Unknown payment kind' });
    }

    await saveJson(paymentKey(paymentId), {
      applied: true,
      appliedAt: new Date().toISOString(),
      userId,
      kind,
      status,
      paid,
      result
    });

    res.json({
      paymentId,
      status,
      paid,
      applied: true,
      result
    });
  } catch (error) {
    const status = error?.status && Number.isFinite(error.status) ? error.status : 500;
    res.status(status).json({ error: error.message, details: error.details });
  }
});

app.post('/api/subscription/daily-bypass', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const { enabled } = req.body || {};
    const sub = await setDailySoftCapBypass(userId, !!enabled);
    res.json({ subscription: sub });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Serve static files from client/dist
const clientDistPath = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDistPath));

// API to get available agents
app.get('/api/agents', async (req, res) => {
  try {
    const agents = await loadAgents();
    const agentList = Object.keys(agents).map(key => ({
      id: key,
      name: agents[key].name,
      description: agents[key].description || `Agent ${agents[key].name}`
    }));
    res.json(agentList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// CHAT API ENDPOINTS
// ==========================================

// Get all chats (metadata only)
app.get('/api/chats', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const chats = await getAllChats(userId);
    res.json(chats);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single chat by ID (full data)
app.get('/api/chats/:id', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const chat = await getChatById(userId, req.params.id);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }
    res.json(chat);
  } catch (error) {
    console.error('Error fetching chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new chat
app.post('/api/chats', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const chat = await createChat(userId, req.body);
    res.status(201).json(chat);
  } catch (error) {
    console.error('Error creating chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update chat (title, items, etc.)
app.put('/api/chats/:id', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const chat = await updateChat(userId, req.params.id, req.body);
    res.json(chat);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    console.error('Error updating chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete chat
app.delete('/api/chats/:id', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const deleted = await deleteChat(userId, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Chat not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// Branch chat
app.post('/api/chats/:id/branch', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const { messageId } = req.body;
    if (!messageId) return res.status(400).json({ error: 'messageId is required' });

    const newChat = await branchChat(userId, req.params.id, messageId);
    res.status(201).json(newChat);
  } catch (error) {
    console.error('Error branching chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate title from message
app.post('/api/chats/generate-title', async (req, res) => {
  try {
    if (!requireUserId(req, res)) return;
    const { message } = req.body;
    const title = generateTitleFromMessage(message);
    res.json({ title });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fallback for SPA
app.get(/.*/, (req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'Not found' });
    }

    // Check if index.html exists, otherwise send a simple message
    res.sendFile(path.join(clientDistPath, 'index.html'), (err) => {
        if (err) {
            res.status(200).send(`
                <div style="font-family: monospace; background: #000; color: #fff; padding: 20px; height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center;">
                    <h1>Telos Spark Server</h1>
                    <p>Server is running on port ${PORT}</p>
                    <p style="color: #888">Client not found. Please build the frontend or start the Vite dev server.</p>
                </div>
            `);
        }
    });
});

// Socket.io Logic
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  let currentAgent = null;
  // Чтобы не спамить логами: печатаем траты для userId максимум 1 раз за процесс
  // (для дебага этого достаточно, и не раздувает логи при частых сообщениях).
  globalThis.__billingSpentLoggedUserIds = globalThis.__billingSpentLoggedUserIds || new Set();

  const handshakeUserId =
    (socket?.handshake?.auth && socket.handshake.auth.userId) ||
    (socket?.auth && socket.auth.userId) ||
    null;

  // Если userId известен уже на этапе connect — логируем сразу
  if (handshakeUserId && !globalThis.__billingSpentLoggedUserIds.has(handshakeUserId)) {
    globalThis.__billingSpentLoggedUserIds.add(handshakeUserId);
    Promise.all([getSubscription(handshakeUserId), getUsage(handshakeUserId)])
      .then(([sub, usage]) => {
        const spentSub = Number(sub?.period?.totalSpentUsd || 0);
        const spentUsage = Number(usage?.totalSpentUsd || 0);
        const credits = Number(sub?.totalCreditsUsd || 0);
        console.log(
          `[billing] user=${handshakeUserId} spentUsd(sub.period)=${spentSub} spentUsd(usage)=${spentUsage} totalCreditsUsd=${credits}`
        );
      })
      .catch(() => {});
  }

  socket.on('agent:select', async (agentId) => {
    try {
      const agents = await loadAgents();
      const agentConfig = agents[agentId];

      if (!agentConfig) {
        socket.emit('error', `Agent not found: ${agentId}`);
        return;
      }

      currentAgent = new Agent(agentConfig);

      // Hook up logger
      currentAgent.setLogger((message, type) => {
        // Strip ANSI codes for clean frontend display, or keep them if we want to render them
        // For now, let's send raw strings and handle parsing if needed,
        // but maybe a simple regex to strip colors is good for the basic log view
        // const cleanMessage = message.replace(/\u001b\[\d+m/g, '');
        socket.emit('log', { message, type, timestamp: new Date().toISOString() });
      });

      await currentAgent.initialize();
      socket.emit('agent:ready', { id: agentId, name: agentConfig.name });
      console.log(`Agent initialized: ${agentId} for client ${socket.id}`);
    } catch (error) {
      console.error('Error initializing agent:', error);
      socket.emit('error', error.message);
    }
  });

  // Load chat history into agent's context
  socket.on('chat:load', async (data) => {
    if (!currentAgent) {
      socket.emit('error', 'No agent selected');
      return;
    }

    try {
      const { history } = data;
      
      if (Array.isArray(history)) {
        currentAgent.setHistory(history);
        socket.emit('chat:loaded', { 
          success: true, 
          messageCount: history.length 
        });
        console.log(`Chat history loaded: ${history.length} messages for client ${socket.id}`);
      }
    } catch (error) {
      console.error('Error loading chat history:', error);
      socket.emit('error', error.message);
    }
  });

  // Clear agent's history (for new chat)
  socket.on('chat:clear', () => {
    if (currentAgent) {
      currentAgent.clearHistory();
      socket.emit('chat:cleared', { success: true });
      console.log(`Chat history cleared for client ${socket.id}`);
    }
  });

  socket.on('message', async (messageData) => {
    if (!currentAgent) {
      socket.emit('error', 'No agent selected');
      return;
    }

    // Support both string (legacy) and object { text, attachments, planEnabled }
    const userMessage = typeof messageData === 'string' ? messageData : messageData.text;
    const attachments = typeof messageData === 'object' ? messageData.attachments || [] : [];
    const planEnabled = typeof messageData === 'object' ? (messageData.planEnabled !== false) : true;
    const userId = typeof messageData === 'object' ? (messageData.userId || socket.auth?.userId || null) : (socket.auth?.userId || null);
    const userName = typeof messageData === 'object' ? messageData.userName : null;

    try {
      // Дебаг: логируем, сколько пользователь уже потратил (как только узнаем userId)
      if (userId && !globalThis.__billingSpentLoggedUserIds.has(userId)) {
        globalThis.__billingSpentLoggedUserIds.add(userId);
        try {
          const [sub, usage] = await Promise.all([getSubscription(userId), getUsage(userId)]);
          const spentSub = Number(sub?.period?.totalSpentUsd || 0);
          const spentUsage = Number(usage?.totalSpentUsd || 0);
          const credits = Number(sub?.totalCreditsUsd || 0);
          console.log(
            `[billing] user=${userId} spentUsd(sub.period)=${spentSub} spentUsd(usage)=${spentUsage} totalCreditsUsd=${credits}`
          );
        } catch {
          // ignore
        }
      }

      // Enforce subscription & daily soft cap on the server too (UI will also gate)
      if (userId) {
        const active = await requireActiveSubscription(userId);
        if (!active.ok) {
          socket.emit('error', active.reason === 'payment_due' ? 'PAYMENT_DUE' : 'NO_SUBSCRIPTION');
          socket.emit('stream:end');
          return;
        }
        const spend = await canSpendToday(userId);
        if (!spend.ok) {
          if (spend.reason === 'payment_due') {
            socket.emit('error', 'PAYMENT_DUE');
          } else if (spend.reason === 'daily_limit_exhausted') {
            socket.emit('error', 'DAILY_LIMIT_EXHAUSTED');
          } else {
            socket.emit('error', 'NO_SUBSCRIPTION');
          }
          socket.emit('stream:end');
          return;
        }
      }

      // Stream response
      await currentAgent.processMessage(userMessage, 
        // 1. Streaming Text Callback
        (chunk) => {
          socket.emit('stream', chunk);
        },
        // 2. Structured Events Callback
        (event, data) => {
          socket.emit('agent:event', { event, data, timestamp: new Date().toISOString() });
        },
        // 3. Attachments
        attachments,
        // 4. Options
        { planEnabled, userId, userName }
      );
      
      socket.emit('stream:end');
      
      // Send updated history
      socket.emit('history', currentAgent.getHistory());
      
    } catch (error) {
      console.error('Error processing message:', error);
      socket.emit('error', error.message);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    currentAgent = null;
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready`);
});

