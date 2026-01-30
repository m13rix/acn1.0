import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useTranslation } from 'react-i18next';
import { Layout } from './components/Layout';
import { Sidebar } from './components/Sidebar';
import { MobileHeader } from './components/MobileHeader';
import { ChatArea } from './components/ChatArea';
import { AgentSelector } from './components/AgentSelector';
import { TerminalPanel } from './components/TerminalPanel';
import type { Agent, LogEntry, SessionItem, Block, Attachment, ChatMeta, Chat } from './types';
import { Terminal as TerminalIcon } from 'lucide-react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { LandingPage } from './pages/LandingPage';
import { AuthPage } from './pages/AuthPage';
import { SettingsModal } from './components/SettingsModal';
import { SubscriptionPage } from './pages/SubscriptionPage';
import { PaymentPage } from './pages/PaymentPage';
import { PaymentResultPage } from './pages/PaymentResultPage';
import { PaymentRequiredOverlay } from './components/PaymentRequiredOverlay';
import { TopUpModal } from './components/TopUpModal';
import { LimitBanner } from './components/LimitBanner';
import { useMobile } from './hooks/useMobile';
import type { UsageLimitsResponse } from './types';

const socket: Socket = io('/', {
  autoConnect: false
});

// Helper to create a UUID (simple version)
const generateId = () => Math.random().toString(36).substring(2, 15);

// Convert SessionItem[] to agent history format
function sessionItemsToHistory(items: SessionItem[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  
  for (const item of items) {
    if (item.role === 'user') {
      history.push({ role: 'user', content: item.content });
    } else if (item.role === 'assistant' && item.blocks) {
      // Extract text content from text blocks
      const textContent = item.blocks
        .filter(block => block.type === 'text')
        .map(block => block.content)
        .join('');
      
      if (textContent) {
        history.push({ role: 'assistant', content: textContent });
      }
    }
  }
  
  return history;
}

const App: React.FC = () => {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const { isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const clientUserId = user?.id || null;

  const [pathname, setPathname] = useState(() => {
    try {
      return `${window.location.pathname}${window.location.search}`;
    } catch {
      return '/';
    }
  });

  const navigate = useCallback((to: string) => {
    try {
      window.history.pushState({}, '', to);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch {
      window.location.href = to;
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      try {
        setPathname(`${window.location.pathname}${window.location.search}`);
      } catch {
        setPathname('/');
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const authedFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const token = await getToken();
      if (!token) throw new Error('Not authenticated');
      const headers = new Headers(init.headers || {});
      headers.set('Authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    },
    [getToken]
  );

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [usageLimits, setUsageLimits] = useState<UsageLimitsResponse | null>(null);
  const [isTopUpOpen, setIsTopUpOpen] = useState(false);

  const [userName, setUserName] = useState<string>(() => {
    try {
      return localStorage.getItem('user.aiName') || '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    const syncSettings = () => {
      const savedName = localStorage.getItem('user.aiName') || '';
      setUserName(savedName);
    };
    window.addEventListener('settings-updated', syncSettings);
    return () => window.removeEventListener('settings-updated', syncSettings);
  }, []);

  const [isConnected, setIsConnected] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [isAgentSelectorOpen, setIsAgentSelectorOpen] = useState(false);

  // Plan toggle (default ON)
  const [planEnabled, setPlanEnabled] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('ui.planEnabled');
      if (raw === null) return true;
      return raw === 'true';
    } catch {
      return true;
    }
  });

  // Pro Mode toggle (default OFF)
  const [proModeEnabled, setProModeEnabled] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('ui.proModeEnabled');
      return raw === 'true';
    } catch {
      return false;
    }
  });
  
  // Chat management
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [isLoadingChats, setIsLoadingChats] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  
  // Session data
  const [sessionItems, setSessionItems] = useState<SessionItem[]>([]);
  
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  // Refs for socket callbacks
  const sessionItemsRef = useRef<SessionItem[]>([]);
  const currentChatIdRef = useRef<string | null>(null);
  const selectedAgentRef = useRef<string | null>(null);
  
  const updateSessionItems = useCallback((newItems: SessionItem[]) => {
    sessionItemsRef.current = newItems;
    setSessionItems(newItems);
  }, []);

  // Keep refs in sync
  useEffect(() => {
    currentChatIdRef.current = currentChatId;
  }, [currentChatId]);
  
  useEffect(() => {
    selectedAgentRef.current = selectedAgent;
  }, [selectedAgent]);

  useEffect(() => {
    try {
      localStorage.setItem('ui.planEnabled', String(planEnabled));
    } catch {
      // ignore
    }
  }, [planEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem('ui.proModeEnabled', String(proModeEnabled));
    } catch {
      // ignore
    }
  }, [proModeEnabled]);

  // Handle agent switching based on Pro Mode
  useEffect(() => {
    if (!agents || agents.length === 0) return;

    const targetId = proModeEnabled ? 'pro' : 'spark';
    const agent = 
      agents.find(a => a.id === targetId) || 
      agents.find(a => (a.name || '').toLowerCase().includes(targetId)) ||
      agents[0];

    if (agent && agent.id !== selectedAgentRef.current) {
      setSelectedAgent(agent.id);
      socket.emit('agent:select', agent.id);
    }
  }, [proModeEnabled, agents]);

  // ==========================================
  // CHAT API FUNCTIONS
  // ==========================================

  const fetchChats = useCallback(async () => {
    try {
      if (!isSignedIn) {
        setChats([]);
        return;
      }
      const response = await authedFetch('/api/chats');
      const data = await response.json();
      setChats(data);
    } catch (error) {
      console.error('Failed to fetch chats:', error);
    } finally {
      setIsLoadingChats(false);
    }
  }, [authedFetch, isSignedIn]);

  const refreshUsage = useCallback(async () => {
    try {
      if (!isSignedIn) {
        setUsageLimits(null);
        return;
      }
      const res = await authedFetch('/api/usage');
      const data = (await res.json()) as UsageLimitsResponse;
      setUsageLimits(data);
    } catch {
      // ignore
    }
  }, [authedFetch, isSignedIn]);

  const loadChat = useCallback(async (chatId: string) => {
    try {
      if (!isSignedIn) return;
      const response = await authedFetch(`/api/chats/${chatId}`);
      if (!response.ok) throw new Error('Chat not found');
      
      const chat: Chat = await response.json();
      setCurrentChatId(chat.id);
      updateSessionItems(chat.items || []);
      
      // If chat has an agent, select it
      if (chat.agentId && chat.agentId !== selectedAgentRef.current) {
        setSelectedAgent(chat.agentId);
        socket.emit('agent:select', chat.agentId);
      }
      
      // Convert and send history to agent for context restoration
      const history = sessionItemsToHistory(chat.items || []);
      if (history.length > 0) {
        socket.emit('chat:load', { history });
      }
    } catch (error) {
      console.error('Failed to load chat:', error);
    }
  }, [authedFetch, isSignedIn, updateSessionItems]);

  const createNewChat = useCallback(async () => {
    try {
      if (!isSignedIn) return null;
      const response = await authedFetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: t('sidebar.newChatDefaultName'),
          agentId: selectedAgentRef.current
        })
      });
      
      const chat: Chat = await response.json();
      setCurrentChatId(chat.id);
      updateSessionItems([]);
      
      // Clear agent's history for fresh start
      socket.emit('chat:clear');
      
      // Refresh chat list
      fetchChats();
      
      return chat;
    } catch (error) {
      console.error('Failed to create chat:', error);
      return null;
    }
  }, [authedFetch, fetchChats, isSignedIn, updateSessionItems]);


  const renameChat = useCallback(async (chatId: string, newTitle: string) => {
    try {
      if (!isSignedIn) return;
      await authedFetch(`/api/chats/${chatId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle })
      });
      fetchChats();
    } catch (error) {
      console.error('Failed to rename chat:', error);
    }
  }, [authedFetch, fetchChats, isSignedIn]);

  const deleteChat = useCallback(async (chatId: string) => {
    try {
      if (!isSignedIn) return;
      await authedFetch(`/api/chats/${chatId}`, { method: 'DELETE' });
      
      // If we deleted the current chat, clear state
      if (currentChatId === chatId) {
        setCurrentChatId(null);
        updateSessionItems([]);
      }
      
      fetchChats();
    } catch (error) {
      console.error('Failed to delete chat:', error);
    }
  }, [authedFetch, currentChatId, fetchChats, isSignedIn, updateSessionItems]);

  // Auto-save is now triggered only on stream:end (see socket handler below)
  // This is much more efficient than saving on every sessionItems change

  // ==========================================
  // INITIAL LOAD
  // ==========================================

  useEffect(() => {
    // Fetch agents
    fetch('/api/agents')
      .then(res => res.json())
      .then((data: Agent[]) => setAgents(data))
      .catch(err => console.error('Failed to fetch agents:', err));

    // Fetch chats + connect socket only when signed in
    if (!isSignedIn) {
      setIsLoadingChats(false);
      setChats([]);
      setCurrentChatId(null);
      updateSessionItems([]);
      try {
        socket.disconnect();
      } catch {
        // ignore
      }
      return;
    }

    setIsLoadingChats(true);
    fetchChats();
    refreshUsage();

    // Socket connection (authenticated)
    (async () => {
      try {
        const token = await getToken();
        socket.auth = { token, userId: clientUserId };
        socket.connect();
      } catch (e) {
        console.error('Failed to initialize socket auth:', e);
      }
    })();

    socket.on('connect', () => {
      setIsConnected(true);
      console.log('Connected to server');
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      console.log('Disconnected from server');
    });

    socket.on('log', (log: LogEntry) => {
      setLogs(prev => [...prev, log]);
    });

    // When agent is ready, load current chat history into context
    socket.on('agent:ready', () => {
      const currentItems = sessionItemsRef.current;
      if (currentItems.length > 0) {
        const history = sessionItemsToHistory(currentItems);
        if (history.length > 0) {
          socket.emit('chat:load', { history });
        }
      }
    });

    // --- Event Handling Logic ---

    socket.on('agent:event', (payload: { event: string, data: any, timestamp: string }) => {
      const { event, data } = payload;
      const currentItems = [...sessionItemsRef.current];
      const lastItem = currentItems[currentItems.length - 1];

      if (!lastItem || lastItem.role !== 'assistant') return;

      const blocks = lastItem.blocks || [];

      if (event === 'plan:created') {
        const planBlock: Block = {
          id: generateId(),
          type: 'plan',
          todos: data,
          timestamp: new Date().toISOString()
        };
        blocks.push(planBlock);
      } 
      else if (event === 'plan:update') {
        const planBlockIndex = blocks.findIndex(b => b.type === 'plan');
        if (planBlockIndex !== -1) {
          blocks[planBlockIndex] = {
             ...blocks[planBlockIndex],
             todos: data
          } as any;
        }
      }
      else if (event === 'thinking:start') {
        blocks.push({
          id: generateId(),
          type: 'thought',
          content: t('chat.thinkingDot'),
          isFinished: false,
          reasoning: '',
          timestamp: new Date().toISOString()
        });
      }
      else if (event === 'reasoning') {
        // Find the latest unfinished thought block and append reasoning
        for (let i = blocks.length - 1; i >= 0; i--) {
          const block = blocks[i];
          if (block.type === 'thought' && !block.isFinished) {
            block.reasoning = (block.reasoning || '') + data.chunk;
            break;
          }
        }
      }
      else if (event === 'action:start') {
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock && lastBlock.type === 'thought' && !lastBlock.isFinished) {
            lastBlock.isFinished = true;
        }
        blocks.push({
          id: generateId(),
          type: 'action',
          content: t('chat.executingAction'),
          isFinished: false,
          timestamp: new Date().toISOString()
        });
      }
      else if (event === 'action:end') {
        for (let i = blocks.length - 1; i >= 0; i--) {
            const block = blocks[i];
            if (block.type === 'action' && !block.isFinished) {
                block.isFinished = true;
                block.duration = data.duration;
                break;
            }
        }
      }
      else if (event === 'model:switch:start') {
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock && (lastBlock.type === 'thought' || lastBlock.type === 'action') && !lastBlock.isFinished) {
            lastBlock.isFinished = true;
        }
        blocks.push({
          id: generateId(),
          type: 'switch',
          content: t('chat.switchingModel'),
          reason: data.description,
          isFinished: false,
          timestamp: new Date().toISOString()
        });
      }
      else if (event === 'model:switch:end') {
        for (let i = blocks.length - 1; i >= 0; i--) {
            const block = blocks[i];
            if (block.type === 'switch' && !block.isFinished) {
                block.isFinished = true;
                block.modelName = data.to;
                break;
            }
        }
      }
      else if (event === 'context:switch') {
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && (lastBlock.type === 'thought' || lastBlock.type === 'action' || lastBlock.type === 'switch') && !lastBlock.isFinished) {
              lastBlock.isFinished = true;
          }

          let content = t('chat.updatingContext');
          if (data.mode === 'whitelist') content = `Context: Whitelist [${data.indices.join(', ')}]`;
          else if (data.mode === 'blacklist') content = `Context: Blacklist [${data.indices.join(', ')}]`;
          else if (data.mode === 'attachments') content = t('chat.contextAttachments', { state: data.value ? t('chat.enabled') : t('chat.disabled') });
          else if (data.mode === 'reset') content = t('chat.contextReset');

          blocks.push({
              id: generateId(),
              type: 'context',
              content: content,
              mode: data.mode,
              details: data,
              isFinished: true,
              timestamp: new Date().toISOString()
          });
      }
      // Tool Custom UI Events
      else if (event === 'tool:ui:start') {
          // Start a new toolUI block with UI state
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && (lastBlock.type === 'thought' || lastBlock.type === 'action' || lastBlock.type === 'switch') && !lastBlock.isFinished) {
              lastBlock.isFinished = true;
          }

          // Check if there's already an unfinished toolUI block to add to
          let toolUIBlock = blocks.find(b => b.type === 'toolUI' && !b.isFinished) as any;
          
          if (toolUIBlock) {
            // Add new UI to existing block
            toolUIBlock.uis.push({
              id: data.uiId || generateId(),
              label: data.label || t('chat.processing'),
              labelFinished: data.labelFinished,
              html: data.html || '',
              height: data.height,
              data: data.data || {}
            });
            toolUIBlock.content = data.label || toolUIBlock.content;
          } else {
            // Create new toolUI block
            blocks.push({
              id: generateId(),
              type: 'toolUI',
              content: data.label || t('chat.processing'),
              isFinished: false,
              uis: [{
                id: data.uiId || generateId(),
                label: data.label || t('chat.processing'),
                labelFinished: data.labelFinished,
                html: data.html || '',
                height: data.height,
                data: data.data || {}
              }],
              currentUIIndex: 0,
              timestamp: new Date().toISOString()
            });
          }
      }
      else if (event === 'tool:ui:update') {
          // Update existing UI in toolUI block
          for (let i = blocks.length - 1; i >= 0; i--) {
            const block = blocks[i] as any;
            if (block.type === 'toolUI') {
              const uiIndex = block.uis.findIndex((ui: any) => ui.id === data.uiId);
              if (uiIndex !== -1) {
                // Immutable update of the specific UI item
                const updatedUI = { ...block.uis[uiIndex] };
                
                if (data.label) updatedUI.label = data.label;
                if (data.html) updatedUI.html = data.html;
                if (data.height !== undefined) updatedUI.height = data.height;
                // Deep merge data
                if (data.data) updatedUI.data = { ...updatedUI.data, ...data.data };
                
                // Update array with new object reference
                block.uis[uiIndex] = updatedUI;
                
                // Update main content if this is the current UI
                if (block.currentUIIndex === uiIndex) {
                  block.content = updatedUI.label;
                }
                break;
              }
            }
          }
      }
      else if (event === 'tool:ui:end') {
          // Mark specific UI or entire block as finished
          for (let i = blocks.length - 1; i >= 0; i--) {
            const block = blocks[i] as any;
            if (block.type === 'toolUI' && !block.isFinished) {
              if (data.uiId) {
                // Mark specific UI as done (update its label to finished state)
                const uiIndex = block.uis.findIndex((ui: any) => ui.id === data.uiId);
                if (uiIndex !== -1 && block.uis[uiIndex].labelFinished) {
                  block.uis[uiIndex].label = block.uis[uiIndex].labelFinished;
                }
              }
              if (data.allDone || !data.uiId) {
                // Mark entire block as finished
                block.isFinished = true;
                block.duration = data.duration;
                // Update content to finished label of current UI
                if (block.uis[block.currentUIIndex]?.labelFinished) {
                  block.content = block.uis[block.currentUIIndex].labelFinished;
                }
              }
              break;
            }
          }
      }

      lastItem.blocks = blocks;
      updateSessionItems(currentItems);
    });

    socket.on('stream', (chunk: string) => {
      const currentItems = [...sessionItemsRef.current];
      const lastItem = currentItems[currentItems.length - 1];
      
      if (!lastItem || lastItem.role !== 'assistant') return;

      const blocks = lastItem.blocks || [];
      const lastBlock = blocks[blocks.length - 1];

      if (lastBlock && (lastBlock.type === 'thought' || lastBlock.type === 'action' || lastBlock.type === 'switch') && !lastBlock.isFinished) {
          lastBlock.isFinished = true;
      }

      // Get or create text block
      let textBlock = lastBlock && lastBlock.type === 'text' ? lastBlock : null;
      if (!textBlock) {
          textBlock = {
              id: generateId(),
              type: 'text',
              content: '',
              timestamp: new Date().toISOString()
          };
          blocks.push(textBlock);
      }

      // Append the chunk to content first
      textBlock.content += chunk;
      
      // Parse <think></think> tags from the content
      // We need to handle partial tags during streaming
      const fullContent = textBlock.content;
      
      // Check for <think> opening tag
      const thinkOpenIdx = fullContent.indexOf('<think>');
      if (thinkOpenIdx !== -1) {
        const thinkCloseIdx = fullContent.indexOf('</think>', thinkOpenIdx);
        
        if (thinkCloseIdx !== -1) {
          // Complete <think>...</think> block found
          const beforeThink = fullContent.substring(0, thinkOpenIdx);
          const thinkContent = fullContent.substring(thinkOpenIdx + 7, thinkCloseIdx);
          const afterThink = fullContent.substring(thinkCloseIdx + 8);
          
          // Store as reasoning in the last thought block, or create a new one
          let targetThoughtBlock: Block | null = null;
          for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].type === 'thought') {
              targetThoughtBlock = blocks[i];
              break;
            }
          }
          
          if (!targetThoughtBlock) {
            // Create a thought block for the <think> content
            const newThoughtBlock: Block = {
              id: generateId(),
              type: 'thought',
              content: t('chat.thinkingDot'),
              isFinished: true,
              reasoning: '',
              timestamp: new Date().toISOString()
            };
            // Insert before the text block
            const textBlockIdx = blocks.indexOf(textBlock);
            blocks.splice(textBlockIdx, 0, newThoughtBlock);
            targetThoughtBlock = newThoughtBlock;
          }
          
          if (targetThoughtBlock && targetThoughtBlock.type === 'thought') {
            targetThoughtBlock.reasoning = (targetThoughtBlock.reasoning || '') + thinkContent;
          }
          
          // Update text content to exclude the think tag
          textBlock.content = beforeThink + afterThink;
        } else {
          // Opening tag found but not closed yet - wait for more content
          // But extract everything before <think> as valid content
          // and treat everything after <think> as pending reasoning
          // For now, let's keep the full content and process when tag closes
        }
      }

      lastItem.blocks = blocks;
      updateSessionItems(currentItems);
    });

    socket.on('stream:end', async () => {
      setIsStreaming(false);

      if (!isSignedIn) return;
      
      const currentItems = [...sessionItemsRef.current];
      const lastItem = currentItems[currentItems.length - 1];
      if (lastItem && lastItem.blocks) {
          lastItem.blocks.forEach(b => {
              if ((b.type === 'thought' || b.type === 'action' || b.type === 'switch') && !b.isFinished) {
                  b.isFinished = true;
              }
          });
          updateSessionItems(currentItems);
      }
      
      // Save chat after agent finishes response
      const chatId = currentChatIdRef.current;
      if (chatId && currentItems.length > 0) {
        try {
          let updateData: any = { items: currentItems };
          
          // Generate title from first user message if it's a new chat
          const firstUserMessage = currentItems.find(item => item.role === 'user');
          if (firstUserMessage?.content) {
            // Fetch current chat to check title
            const chatRes = await authedFetch(`/api/chats/${chatId}`);
            const chat = await chatRes.json();
            if (chat?.title === 'New Chat') {
              const titleResponse = await authedFetch('/api/chats/generate-title', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: firstUserMessage.content })
              });
              const { title } = await titleResponse.json();
              updateData.title = title;
            }
          }
          
          await authedFetch(`/api/chats/${chatId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updateData)
          });
          
          // Refresh chat list
          fetchChats();
        } catch (error) {
          console.error('Failed to save chat:', error);
        }
      }

      // Refresh usage after every completed response (cost is accounted on server)
      try {
        await refreshUsage();
      } catch {
        // ignore
      }
    });

    socket.on('error', (err: string) => {
      setLogs(prev => [...prev, { message: err, type: 'error', timestamp: new Date().toISOString() }]);
      console.error('Socket error:', err);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('log');
      socket.off('agent:ready');
      socket.off('agent:event');
      socket.off('stream');
      socket.off('stream:end');
      socket.off('error');
      socket.disconnect();
    };
  }, [authedFetch, clientUserId, fetchChats, getToken, isSignedIn, updateSessionItems]);

  // Poll usage occasionally while signed in (keeps UI fresh even when idle)
  useEffect(() => {
    if (!isSignedIn) return;
    const t = window.setInterval(() => {
      refreshUsage();
    }, 15_000);
    return () => window.clearInterval(t);
  }, [isSignedIn, refreshUsage]);

  // Dev shortcut to open agent selector: Ctrl+Alt+S
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing IME composition, etc.
      if (e.isComposing) return;

      const key = (e.key || '').toLowerCase();
      if (e.ctrlKey && e.altKey && key === 's') {
        e.preventDefault();
        setIsAgentSelectorOpen(prev => !prev);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ==========================================
  // HANDLERS
  // ==========================================

  const handleAgentSelect = (agentId: string) => {
    setSelectedAgent(agentId);
    socket.emit('agent:select', agentId);
    setIsAgentSelectorOpen(false);
  };

  const handleSendMessage = async (text: string, attachments: Attachment[] = []) => {
    if (!isSignedIn) {
      navigate('/auth?mode=sign-in');
      return;
    }

    // Ensure we have a chat
    let chatId = currentChatId;
    if (!chatId) {
      const newChat = await createNewChat();
      if (!newChat) return;
      chatId = newChat.id;
    }

    const userItem: SessionItem = { 
        id: generateId(), 
        role: 'user', 
        content: text, 
        attachments: attachments,
        timestamp: new Date().toISOString() 
    };
    
    const assistantItem: SessionItem = {
        id: generateId(),
        role: 'assistant',
        content: '',
        blocks: [],
        timestamp: new Date().toISOString()
    };

    updateSessionItems([...sessionItems, userItem, assistantItem]);
    
    setIsStreaming(true);
    
    // Get final user name for prompt (fallback to clerk first name if empty)
    const finalUserName = userName || user?.firstName || t('userMenu.account');

    socket.emit('message', { 
      text, 
      attachments, 
      planEnabled, 
      userId: clientUserId,
      userName: finalUserName
    });
  };

  const handleNewChat = async () => {
    await createNewChat();
  };

  const handleSelectChat = (chatId: string) => {
    if (chatId !== currentChatId) {
      loadChat(chatId);
    }
    setIsSidebarOpen(false);
  };

  const handleBranch = async (messageId: string) => {
    if (!currentChatId || !isSignedIn) return;

    try {
        const response = await authedFetch(`/api/chats/${currentChatId}/branch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId })
        });
        
        if (!response.ok) throw new Error('Failed to branch chat');
        
        const newChat = await response.json();
        
        // Refresh chat list and switch to new chat
        await fetchChats();
        await loadChat(newChat.id);
        
    } catch (error) {
        console.error('Error branching chat:', error);
    }
  };

  const handleRegenerate = async (messageId: string) => {
    if (!currentChatId || !isSignedIn || isStreaming) return;

    // Find the message and truncate items
    const items = [...sessionItems];
    const index = items.findIndex(item => item.id === messageId);
    if (index === -1) return;

    // Keep items up to and including the message
    const newItems = items.slice(0, index + 1);
    
    // Update server chat first
    try {
        await authedFetch(`/api/chats/${currentChatId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: newItems })
        });
        
        // Get the content of the message to regenerate
        const message = items[index];
        if (message.role === 'user') {
            setIsStreaming(true);
            
            // Add placeholder assistant item for streaming
            const assistantItem: SessionItem = {
                id: generateId(),
                role: 'assistant',
                content: '',
                blocks: [],
                timestamp: new Date().toISOString()
            };
            
            // Update local state with the placeholder
            updateSessionItems([...newItems, assistantItem]);
            
            // Sync history with agent (load history up to BEFORE this message)
            const history = sessionItemsToHistory(newItems);
            const historyToLoad = history.slice(0, -1);
            socket.emit('chat:load', { history: historyToLoad });
            
            // Re-send the message as if it's new
            const finalUserName = userName || user?.firstName || 'User';
            socket.emit('message', { 
                text: message.content, 
                attachments: message.attachments, 
                planEnabled, 
                userId: clientUserId,
                userName: finalUserName
            });
        }
    } catch (error) {
        console.error('Error regenerating:', error);
        // Revert on error
        updateSessionItems(items);
    }
  };

  const handleEdit = async (messageId: string, newContent: string) => {
    if (!currentChatId || !isSignedIn || isStreaming) return;

    // Find message
    const items = [...sessionItems];
    const index = items.findIndex(item => item.id === messageId);
    if (index === -1) return;

    // Update content
    const updatedItem = { ...items[index], content: newContent };
    
    // Truncate after this message
    const newItems = items.slice(0, index);
    newItems.push(updatedItem);
    
    try {
        await authedFetch(`/api/chats/${currentChatId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: newItems })
        });
        
        // Trigger regeneration with new content
        setIsStreaming(true);
        
        // Add placeholder assistant item for streaming
        const assistantItem: SessionItem = {
            id: generateId(),
            role: 'assistant',
            content: '',
            blocks: [],
            timestamp: new Date().toISOString()
        };
        
        // Update local state with the placeholder
        updateSessionItems([...newItems, assistantItem]);
        
        // Load history up to BEFORE this message
        const history = sessionItemsToHistory(newItems);
        const historyToLoad = history.slice(0, -1);
        socket.emit('chat:load', { history: historyToLoad });
        
        // Send as new message
        const finalUserName = userName || user?.firstName || 'User';
        socket.emit('message', { 
            text: newContent, 
            attachments: updatedItem.attachments, 
            planEnabled, 
            userId: clientUserId,
            userName: finalUserName
        });
        
    } catch (error) {
        console.error('Error editing:', error);
        updateSessionItems(items);
    }
  };

  // ==========================================
  // RENDER
  // ==========================================

  const routePath = (() => {
    const base = (pathname || '/').split('?')[0] || '/'
    return base
  })()

  if (routePath.startsWith('/auth')) {
    return <AuthPage />
  }

  if (!isSignedIn) {
    return <LandingPage />
  }

  // Route: Payment widget
  if (routePath.startsWith('/payment/result')) {
    return <PaymentResultPage onDone={async () => {
      await refreshUsage();
      navigate('/');
    }} />
  }

  if (routePath.startsWith('/payment')) {
    return <PaymentPage />
  }

  // Route: Subscription selection
  if (routePath.startsWith('/subscribe')) {
    return <SubscriptionPage />
  }

  // Gate: if no subscription, push user to subscribe page
  if (usageLimits && usageLimits.ok === false && usageLimits.reason === 'no_subscription') {
    navigate('/subscribe');
    return null;
  }

  const bypass = !!usageLimits?.subscription?.period?.day?.dailySoftCapBypass;
  const dailyLimitUsd = Number(usageLimits?.dailyLimitUsd || 0);
  const dailySpentUsd = Number(usageLimits?.dailySpentUsd || 0);
  const remainingUsd = Number(usageLimits?.remainingUsd || 0);
  
  // If total budget is exhausted, show payment due overlay instead of daily limit banner
  const isPaymentDue = usageLimits && (
    (usageLimits.ok === false && usageLimits.reason === 'payment_due') ||
    (usageLimits.ok === true && remainingUsd <= 0)
  );
  
  const isDailyBlocked = usageLimits?.ok && !bypass && !isPaymentDue && (dailyLimitUsd <= 0 || dailySpentUsd >= dailyLimitUsd);

  return (
    <Layout
      sidebar={
        <Sidebar
          chats={chats}
          currentChatId={currentChatId}
          onNewChat={() => {
            handleNewChat();
            setIsSidebarOpen(false);
          }}
          onSelectChat={handleSelectChat}
          onRenameChat={renameChat}
          onDeleteChat={deleteChat}
          onOpenSettings={() => {
            setIsSettingsOpen(true);
            setIsSidebarOpen(false);
          }}
          isLoading={isLoadingChats}
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
        />
      }
    >
      <MobileHeader 
        onMenuClick={() => setIsSidebarOpen(true)} 
        chatTitle={chats.find(c => c.id === currentChatId)?.title}
        onNewChat={handleNewChat}
      />

      <PaymentRequiredOverlay
        isOpen={!!isPaymentDue}
        onGoToSubscription={() => navigate('/subscribe')}
      />

      <TopUpModal
        isOpen={isTopUpOpen}
        onClose={() => setIsTopUpOpen(false)}
      />

      {isAgentSelectorOpen && (
        <AgentSelector agents={agents} onSelect={handleAgentSelect} onClose={() => setIsAgentSelectorOpen(false)} />
      )}

      <ChatArea 
        items={sessionItems} 
        onSendMessage={handleSendMessage}
        isStreaming={isStreaming}
        planEnabled={planEnabled}
        onPlanEnabledChange={setPlanEnabled}
        proModeEnabled={proModeEnabled}
        onProModeEnabledChange={setProModeEnabled}
        inputDisabled={!!isPaymentDue || isDailyBlocked}
        onBranch={handleBranch}
        onRegenerate={handleRegenerate}
        onEdit={handleEdit}
        topBanner={
          isDailyBlocked ? (
            <LimitBanner
              isOpen={true}
              variant="limit"
              title={t('limit.title')}
              body={t('limit.body')}
              primaryLabel={t('limit.primary')}
              onPrimary={() => setIsTopUpOpen(true)}
              secondaryLabel={t('limit.secondary')}
              onSecondary={async () => {
                await authedFetch('/api/subscription/daily-bypass', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ enabled: true })
                });
                await refreshUsage();
              }}
            />
          ) : null
        }
      />

      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
        usageLimits={usageLimits}
        onOpenTopUp={() => setIsTopUpOpen(true)}
      />

      {/* Terminal Toggle + Status */}
      {!isMobile && (
        <div className="absolute bottom-6 right-6 z-30 flex gap-2">
           <div className={`px-3 py-1 rounded-full text-xs font-mono flex items-center ${isConnected ? 'text-green-500 bg-green-500/10 border border-green-500/20' : 'text-red-500 bg-red-500/10 border border-red-500/20'}`}>
              {isConnected ? 'CONNECTED' : 'DISCONNECTED'}
        </div>
           <button 
              onClick={() => setIsTerminalOpen(!isTerminalOpen)}
              className="p-3 bg-zinc-900 rounded-full text-muted-foreground hover:text-white border border-white/10 hover:border-white/30 transition-all shadow-lg"
           >
              <TerminalIcon size={20} />
          </button>
        </div>
      )}

      <TerminalPanel 
        logs={logs} 
        isOpen={isTerminalOpen} 
        onClose={() => setIsTerminalOpen(false)} 
      />
    </Layout>
  );
};

export default App;
