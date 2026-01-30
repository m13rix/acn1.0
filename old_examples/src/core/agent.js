import { Planner } from './planner.js';
import { Executor } from './executor.js';
import { loadTools, getToolDocumentation, getToolCapabilities } from './toolLoader.js';
import { loadAgents } from './agentLoader.js';
import { countdown } from '../utils/timer.js';
import { createGeminiFileSearchManager } from '../experimental/geminiFileSearch.js';
import chalk from 'chalk';
import { recordCost } from '../server/usageTracker.js';

/**
 * Main Agent orchestrator - coordinates Planner and Executor
 */
export class Agent {
  constructor(config) {
    this.config = config;
    this.logger = null;
    this.planner = new Planner(config.planner, config.planner.systemPrompt, this.log.bind(this));
    this.executor = new Executor(config.executor, config.executor.systemPrompt, this.log.bind(this));
    this.history = [];
    this.plannerHistory = []; // Отдельная история для планировщика: только запросы пользователя и ответы планировщика
    this.tools = null;
    this.toolDocs = null;
    this.toolCapabilities = null;
    this.agentDocs = '';
    this.agentCapabilities = '';
    // Генерируем уникальный sessionId для этого экземпляра агента
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    // Текущий onChunk callback для streaming (устанавливается в processMessage)
    this.currentOnChunk = null;
    // Callback для событий (устанавливается в processMessage)
    this.currentOnEvent = null;
    // Experimental: Gemini File Search Manager
    this.fileSearchManager = null;
  }

  log(message, type = 'info') {
    if (this.logger) {
      this.logger(message, type);
    }
  }

  emit(event, data) {
    if (this.currentOnEvent) {
      this.currentOnEvent(event, data);
    }
  }

  setLogger(logger) {
    this.logger = logger;
    this.planner.logger = logger;
    this.executor.logger = logger;

    // Bind emit for planner and executor
    this.planner.emit = this.emit.bind(this);
    this.executor.emit = this.emit.bind(this);
  }

  /**
   * Initialize the agent by loading tools
   */
  async initialize() {
    this.tools = await loadTools(this.config.tools);

    // Оборачиваем memory.search для автоматической передачи sessionId
    if (this.tools.memory) {
      const originalMemorySearch = this.tools.memory.search.bind(this.tools.memory);
      const originalMemoryClearSession = this.tools.memory.clearSession.bind(this.tools.memory);
      const originalMemoryGetSessionStats = this.tools.memory.getSessionStats.bind(this.tools.memory);

      this.tools.memory = {
        ...this.tools.memory,
        search: async (query, clientId = 'default') => {
          // Автоматически передаём sessionId текущего агента
          return await originalMemorySearch(query, clientId, this.sessionId);
        },
        clearSession: async () => {
          // Очищаем сессию текущего агента
          return await originalMemoryClearSession(this.sessionId);
        },
        getSessionStats: async () => {
          // Получаем статистику сессии текущего агента
          return await originalMemoryGetSessionStats(this.sessionId);
        }
      };
    }

    this.toolDocs = await getToolDocumentation(this.config.tools);
    this.toolCapabilities = getToolCapabilities(this.config.tools);

    // Build agents documentation and capabilities for prompts
    const agentsMap = await loadAgents();
    const allowedAgents = Array.isArray(this.config.callableAgents) ? this.config.callableAgents : [];

    const nameToKey = new Map();
    for (const [key, ag] of Object.entries(agentsMap)) {
      nameToKey.set(ag.name, key);
      nameToKey.set(key, key);
    }

    const allowedResolved = allowedAgents
        .map(name => nameToKey.get(name))
        .filter(Boolean);

    const allowedDisplay = allowedResolved.map(key => agentsMap[key]?.name || key);

    this.agentDocs = allowedResolved.length > 0 ? [
      'callAgent(name: string, prompt: string): Promise<string>',
      '  Call another agent as if the user prompted it directly.',
      '  Parameters:',
      '    - name: Agent display name or key. Allowed:',
      `      ${allowedDisplay.join(', ')}`,
      '    - prompt: Detailed, self-contained task prompt with all context',
      '  Returns: The called agent\'s full assistant response as a string',
      '  Note: The called agent may wait a brief delay before starting (to respect rate limits).'
    ].join('\n') : 'No other agents available to call from this agent.';

    this.agentCapabilities = allowedResolved.length > 0
        ? allowedResolved.map(key => `- Agent Call: Can delegate a task to the "${agentsMap[key]?.name || key}" agent using callAgent(name, prompt).`).join('\n')
        : '';

    // === EXPERIMENTAL: Gemini File Search ===
    // Инициализируем File Search если включено в конфигурации
    await this.initializeFileSearch();

    // Provide built-ins to executor, including callAgent
    this.executor.setBuiltIns({
      callAgent: async (agentName, prompt) => {
        const allAgents = await loadAgents();
        const allowed = new Set(allowedResolved);

        // Resolve input to key
        let targetKey = null;
        for (const [key, ag] of Object.entries(allAgents)) {
          if (key === agentName || ag.name === agentName) {
            targetKey = key;
            break;
          }
        }

        if (!targetKey) {
          throw new Error(`Agent not found: ${agentName}`);
        }

        if (!allowed.has(targetKey)) {
          throw new Error(`Calling agent "${agentName}" is not permitted by this agent's configuration`);
        }

        const targetConfig = allAgents[targetKey];
        const delaySec = typeof targetConfig.interAgentDelaySeconds === 'number' ? targetConfig.interAgentDelaySeconds : 5;
        if (delaySec > 0) {
          await countdown(delaySec, `Calling agent "${agentName}" (rate limit delay)`);
        }

        // Создаём нужный тип агента (кастомный или обычный)
        let nested;
        if (targetConfig.isCustom) {
          const { CustomAgent } = await import('./customAgent.js');
          nested = new CustomAgent(targetConfig);
        } else {
          const { Agent } = await import('./agent.js');
          nested = new Agent(targetConfig);
        }

        // Inherit logger for consistent output
        if (this.logger) {
          nested.setLogger(this.logger);
        }

        await nested.initialize();

        // Create wrapper for onChunk to show it's from the called agent
        const calledAgentOnChunk = this.currentOnChunk ? (chunk) => {
          // Pass through the chunk with streaming for the called agent
          this.currentOnChunk(chunk);
        } : null;

        // Pass events from nested agent
        const calledAgentOnEvent = this.currentOnEvent ? (event, data) => {
           this.currentOnEvent(event, data);
        } : null;

        const response = await nested.processMessage(String(prompt || ''), calledAgentOnChunk, calledAgentOnEvent);

        // Trim response to only include last action and preceding text
        // Для кастомных агентов просто возвращаем ответ как есть
        const trimmedResponse = targetConfig.isCustom ? response : this.trimToLastAction(response);

        return trimmedResponse;
      }
    });
  }

  /**
   * Инициализирует Gemini File Search если включено в experimental конфигурации
   * Работает только для провайдеров gemini
   */
  async initializeFileSearch() {
    const experimental = this.config.experimental;
    if (!experimental?.geminiFileSearch?.enabled) {
      return;
    }

    this.log(`${chalk.blue('🔬')} Experimental: Gemini File Search enabled`, 'system');

    // Проверяем, что executor использует gemini (File Search только для executor)
    const executorIsGemini = this.config.executor?.provider?.toLowerCase() === 'gemini';

    if (!executorIsGemini) {
      this.log(`${chalk.yellow('⚠')} File Search requires gemini provider for executor, skipping`, 'warning');
      return;
    }

    // Получаем API ключ для Gemini
    const apiKey = this.config.planner?.apiKey ||
                   this.config.executor?.apiKey ||
                   process.env.GEMINI_API_KEY;

    if (!apiKey) {
      this.log(`${chalk.yellow('⚠')} No Gemini API key found for File Search`, 'warning');
      return;
    }

    try {
      // Создаём и инициализируем File Search Manager
      this.fileSearchManager = await createGeminiFileSearchManager(
        apiKey,
        {
          contextPath: experimental.geminiFileSearch.contextPath,
          storeName: experimental.geminiFileSearch.storeName
        },
        this.log.bind(this)
      );

      if (this.fileSearchManager && this.fileSearchManager.isInitialized()) {
        const storeName = this.fileSearchManager.getStoreName();
        const uploadedFiles = this.fileSearchManager.getUploadedFiles();

        this.log(`${chalk.green('✓')} File Search initialized with ${uploadedFiles.length} file(s)`, 'system');
        this.log(`${chalk.blue('📁')} Store name: ${storeName}`, 'system');
        uploadedFiles.forEach(f => {
          this.log(`  - ${f.name}`, 'system');
        });

        // Сохраняем store names ТОЛЬКО для executor (планировщик не получает доступ)
        this.executor.fileSearchStoreNames = [storeName];

        // Executor провайдер создаётся лениво, поэтому fileSearchStoreNames
        // применится в applyModelConfig() при первом вызове ensureProviderReady()
      } else {
        this.log(`${chalk.yellow('⚠')} File Search Manager not initialized (no files or error)`, 'warning');
      }
    } catch (error) {
      this.log(`${chalk.red('✗')} Failed to initialize File Search: ${error.message}`, 'error');
    }
  }

  /**
   * Extract the last 3 steps (action-observation cycles) from a full agent response
   * @param {string} fullResponse - Complete agent response
   * @returns {string} Trimmed response with last 3 steps (text -> action -> obs cycles)
   */
  trimToLastAction(fullResponse) {
    // Find all action blocks with their positions
    const actionMatches = [];
    const actionRegex = /<action>([\s\S]*?)<\/action>/g;
    let match;

    while ((match = actionRegex.exec(fullResponse)) !== null) {
      actionMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        full: match[0]
      });
    }

    // If no action found, return the full response
    if (actionMatches.length === 0) {
      return fullResponse;
    }

    // Find all observation blocks with their positions
    const obsMatches = [];
    const obsRegex = /<obs>([\s\S]*?)<\/obs>/g;
    while ((match = obsRegex.exec(fullResponse)) !== null) {
      obsMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        full: match[0]
      });
    }

    // Group actions with their corresponding observations to form steps
    const steps = [];
    for (let i = 0; i < actionMatches.length; i++) {
      const action = actionMatches[i];
      
      // Find the observation that comes after this action
      let correspondingObs = null;
      for (const obs of obsMatches) {
        if (obs.start >= action.end) {
          correspondingObs = obs;
          break;
        }
      }

      // Determine the start of text for this step
      // Text starts after the previous step's observation (or action if no obs), or at the beginning
      let stepStart = 0;
      if (i > 0) {
        const prevStep = steps[i - 1];
        stepStart = prevStep.end;
      }

      // Find where the text before this action starts
      // Look for the last closing tag before this action
      const beforeAction = fullResponse.substring(stepStart, action.start);
      const lastObsPos = beforeAction.lastIndexOf('</obs>');
      const lastActionPos = beforeAction.lastIndexOf('</action>');
      const lastTagPos = Math.max(lastObsPos, lastActionPos);
      
      if (lastTagPos !== -1) {
        const tagLength = lastObsPos > lastActionPos ? '</obs>'.length : '</action>'.length;
        stepStart = stepStart + lastTagPos + tagLength;
        
        // Trim leading whitespace
        const afterTag = fullResponse.substring(stepStart, action.start);
        const firstNonWhitespace = afterTag.search(/\S/);
        if (firstNonWhitespace !== -1) {
          stepStart += firstNonWhitespace;
        }
      }

      // Determine the end of this step
      const stepEnd = correspondingObs ? correspondingObs.end : action.end;

      steps.push({
        start: stepStart,
        end: stepEnd,
        action: action,
        obs: correspondingObs
      });
    }

    // Take the last 3 steps (or all if less than 3)
    const stepsToReturn = steps.slice(-3);
    
    if (stepsToReturn.length === 0) {
      return fullResponse;
    }

    // Extract the combined response from the first step start to the last step end
    const firstStepStart = stepsToReturn[0].start;
    const lastStepEnd = stepsToReturn[stepsToReturn.length - 1].end;
    const trimmed = fullResponse.substring(firstStepStart, lastStepEnd).trim();

    return trimmed || fullResponse;
  }

  /**
   * Process a user message
   * @param {string} userMessage - User's message
   * @param {Function} onChunk - Callback for streaming chunks
   * @param {Function} onEvent - Callback for structured events
   * @param {Array} attachments - Array of file attachments
   * @param {Object} options - Execution options (e.g. { planEnabled: boolean })
   * @returns {Promise<string>} Complete assistant response
   */
  async processMessage(userMessage, onChunk = null, onEvent = null, attachments = [], options = {}) {
    // Save onChunk for use in callAgent
    this.currentOnChunk = onChunk;
    this.currentOnEvent = onEvent;
    const userId = options?.userId || null;
    const userName = options?.userName || null;

    // Inject user name into system prompts if provided
    if (userName) {
      const nameContext = `\n\nUSER IDENTITY:\n- You are talking to: ${userName}\n- Address the user as: ${userName}`;
      this.planner.systemPrompt = this.config.planner.systemPrompt + nameContext;
      this.executor.baseSystemPrompt = this.config.executor.systemPrompt + nameContext;
      // Also update current executor system prompt (it might be overridden by model switching, but ensureProviderReady will handle it)
      this.executor.systemPrompt = this.executor.baseSystemPrompt;
    }

    // Provide per-call usage tracking to both planner & executor (best-effort, fire-and-forget)
    const track = (phase) => ({ usage, cost }) => {
      if (!userId) return;
      const costNum = typeof cost === 'number' ? cost : Number(cost);
      if (!Number.isFinite(costNum) || costNum < 0) return;
      recordCost(userId, {
        costUsd: costNum,
        meta: {
          phase,
          provider: 'openrouter',
          model: usage?.model || undefined,
          prompt_tokens: usage?.prompt_tokens,
          completion_tokens: usage?.completion_tokens,
          total_tokens: usage?.total_tokens
        }
      }).catch(() => {});
    };

    this.planner.onUsage = track('planner');
    this.executor.onUsage = track('executor');

    this.log(`\n${chalk.green.bold('═'.repeat(60))}`, 'system');
    this.log(`${chalk.green.bold('🚀 AGENT PROCESSING STARTED')}`, 'system');
    this.log(`${chalk.green.bold('═'.repeat(60))}`, 'system');
    this.log(`${chalk.yellow('User Message:')} ${chalk.white(userMessage)}`, 'system');

    if (attachments.length > 0) {
      this.log(`${chalk.yellow('Attachments:')} ${attachments.length} file(s)`, 'system');
      attachments.forEach(att => {
        this.log(`  - ${att.name} (${att.type})`, 'system');
      });
    }

    const planEnabled = options && options.planEnabled !== false;

    // Step 1: Planner creates TODO list (or bypass when disabled)
    let planResult;
    if (planEnabled) {
      // Используем отдельную историю для планировщика: только запросы пользователя и ответы планировщика
      planResult = await this.planner.createPlan(
        userMessage,
        this.plannerHistory,
        [this.toolCapabilities, this.agentCapabilities].filter(Boolean).join('\n'),
        attachments
      );
      
      // Сохраняем в историю планировщика запрос пользователя и ответ планировщика
      this.plannerHistory.push({ role: 'user', content: userMessage });
      this.plannerHistory.push({ role: 'assistant', content: planResult.response });
    } else {
      const oneStepTodos = [{
        task: 'Complete the user request (and call todo.completeCurrent() when over)',
        completed: false
      }];
      // Emit plan for UI consistency even when planner is bypassed
      try {
        this.emit('plan:created', oneStepTodos);
      } catch {}
      this.log(chalk.gray('Planning is disabled (planEnabled=false). Using a single-step plan.'), 'system');
      planResult = { todos: oneStepTodos, response: '' };
    }
    
    const todos = planResult.todos;

    // Step 2: Executor executes actions until complete
    let assistantResponse = '';
    let stepOutputs = []; // Array of { index: number, content: string }
    let iteration = 0;
    const maxIterations = 200; // Safety limit

    while (iteration < maxIterations) {
      iteration++;

      // Create temporary history with current response
      const currentHistory = [
        ...this.history,
        { role: 'user', content: userMessage }
      ];

      // Add previous step outputs as separate messages with metadata
      if (stepOutputs.length > 0) {
        stepOutputs.forEach((output, idx) => {
          currentHistory.push({
            role: 'assistant',
            content: output.content,
            _taskIndex: output.index // Metadata for context filtering
          });

          // Add "proceed" prompt between steps if it's not the last one
          // This matches the previous logic but ensures structure
          const nextTask = todos[output.index + 1]; // This is approximate, logic below improves it
          // Actually, the previous logic added a "proceed" message after each assistant response
          // We need to maintain that flow for the model to understand continuity

          // If this is not the last output in our list, we simulate the user saying "proceed"
          if (idx < stepOutputs.length - 1) {
             const nextOutput = stepOutputs[idx + 1];
             const nextTaskIndex = nextOutput.index;
             const nextTask = todos[nextTaskIndex];
             const proceedMsg = nextTask ? `proceed by completing "${nextTask.task}"` : 'proceed';
             currentHistory.push({
               role: 'user',
               content: proceedMsg,
               _taskIndex: nextTaskIndex // Associate prompt with the task it triggers
             });
          }
        });

        // Add the prompt for the *current* pending task
        const currentTask = todos.find(t => !t.completed);
        // Determine the index for the upcoming task
        const nextTaskIndex = todos.findIndex(t => !t.completed);
        const proceedMsg = currentTask ? `proceed by completing "${currentTask.task}"` : 'proceed';
        currentHistory.push({
          role: 'user',
          content: proceedMsg,
          _taskIndex: nextTaskIndex !== -1 ? nextTaskIndex : todos.length
        });
      } else {
         // First step, no outputs yet, just initial user message (already added)
         // But wait, we need the prompt for the first task if it's not just the user message?
         // Standard flow usually relies on system prompt + user message to start.
         // But if we want consistency, we might want a specific prompt for task 0?
         // Existing logic didn't add one for the very first step, just let the user message drive it.
         // We'll stick to that to avoid regressions.
      }

      // Identify current task index for metadata
      const currentTaskIndex = todos.findIndex(t => !t.completed);

      // Create onReasoning callback that emits reasoning events
      const onReasoningCallback = (reasoningChunk) => {
        this.emit('reasoning', { chunk: reasoningChunk });
      };

      const result = await this.executor.executeStep(
          todos,
          currentHistory,
          this.tools,
          this.toolDocs,
          this.agentDocs,
          onChunk,
          onReasoningCallback,
          iteration,
          attachments // Pass attachments to executor
      );

      // Store the result with the task index that was active
      if (currentTaskIndex !== -1) {
          stepOutputs.push({ index: currentTaskIndex, content: result.content });
      } else {
          // If all tasks were complete but loop ran (unlikely), just append
          stepOutputs.push({ index: todos.length, content: result.content });
      }

      assistantResponse += result.content;

      // Only complete if all tasks are done
      // If model didn't call tools but there are incomplete tasks, continue the loop
      if (result.allTasksCompleted) {
        this.log(`${chalk.green.bold('✓ Agent processing complete')}`, 'system');
        this.log(`${chalk.green.bold('═'.repeat(60))}\n`, 'system');
        break;
      }

      // If no action was executed and there are incomplete tasks, continue
      // (the executor already added a warning observation)
      if (!result.hasAction && !result.allTasksCompleted) {
        this.log(`${chalk.yellow('⚠')} No action detected with incomplete tasks, continuing...`, 'system');
        // Continue the loop - executor already added warning observation
      }

      // Continue loop to process next task
      if (iteration >= maxIterations) {
        this.log(`${chalk.yellow('⚠ Maximum iterations reached')}`, 'warning');
        break;
      }
    }

    // Update history with complete interaction
    this.history.push({ role: 'user', content: userMessage });
    this.history.push({ role: 'assistant', content: assistantResponse });

    return assistantResponse;
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    this.history = [];
    this.plannerHistory = [];
  }

  /**
   * Get conversation history
   * @returns {Array} Message history
   */
  getHistory() {
    return this.history;
  }

  /**
   * Set/restore conversation history (for loading saved chats)
   * @param {Array} history - Array of {role: 'user'|'assistant', content: string}
   * @param {Array} plannerHistory - Optional separate planner history
   */
  setHistory(history, plannerHistory = null) {
    if (Array.isArray(history)) {
      this.history = history;
      this.log(`History restored with ${history.length} messages`, 'system');
    }
    // Если передан plannerHistory, используем его, иначе создаем упрощенную версию из основной истории
    if (plannerHistory !== null && Array.isArray(plannerHistory)) {
      this.plannerHistory = plannerHistory;
      this.log(`Planner history restored with ${plannerHistory.length} messages`, 'system');
    } else if (Array.isArray(history)) {
      // Создаем упрощенную историю планировщика из основной истории
      // Берем только пары user-assistant (запрос-ответ планировщика)
      this.plannerHistory = [];
      for (let i = 0; i < history.length; i += 2) {
        if (history[i]?.role === 'user' && history[i + 1]?.role === 'assistant') {
          this.plannerHistory.push(history[i]);
          // Для планировщика берем только текст плана, если он есть в ответе
          // В реальности планировщик возвращает план, но в истории может быть полный ответ исполнителя
          // Поэтому мы просто берем первый ответ как план (это приблизительно)
          this.plannerHistory.push(history[i + 1]);
        }
      }
    }
  }

  /**
   * Clear memory session history (viewed records)
   * Resets the list of viewed memory records for this agent session
   */
  async clearMemorySession() {
    if (this.tools && this.tools.memory && this.tools.memory.clearSession) {
      return await this.tools.memory.clearSession();
    }
    return 'Memory tool not available';
  }

  /**
   * Get memory session statistics
   * @returns {Promise<string>} Session statistics
   */
  async getMemorySessionStats() {
    if (this.tools && this.tools.memory && this.tools.memory.getSessionStats) {
      return await this.tools.memory.getSessionStats();
    }
    return 'Memory tool not available';
  }

  /**
   * Get current session ID
   * @returns {string} Session ID
   */
  getSessionId() {
    return this.sessionId;
  }
}

