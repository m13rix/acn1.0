import { pathToFileURL } from 'url';
import { resolve, dirname, isAbsolute } from 'path';
import chalk from 'chalk';

/**
 * CustomAgent - Обёртка для пользовательских агентов с кастомной логикой
 * 
 * Позволяет создавать агентов с произвольной JavaScript логикой,
 * сохраняя совместимость с основной архитектурой фреймворка.
 * 
 * Минимальные требования к кастомному модулю:
 * - export async function process(input, context): Promise<string>
 * 
 * Опциональные экспорты:
 * - export async function initialize(context): Promise<void>
 * - export async function cleanup(): Promise<void>
 * - export const metadata = { name, description, version }
 */
export class CustomAgent {
  constructor(config) {
    this.config = config;
    this.name = config.name;
    this.entryPath = config.entryPath;
    this.agentDir = config.agentDir;
    this.callableAgents = config.callableAgents || [];
    this.interAgentDelaySeconds = config.interAgentDelaySeconds ?? 5;
    
    this.logger = null;
    this.module = null;
    this.initialized = false;
    this.history = [];
    
    // Генерируем уникальный sessionId
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // Текущие callbacks для streaming
    this.currentOnChunk = null;
    this.currentOnEvent = null;
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
  }

  /**
   * Создаёт контекст для передачи в кастомный модуль
   */
  createContext() {
    return {
      // Базовая информация
      agentName: this.name,
      sessionId: this.sessionId,
      agentDir: this.agentDir,
      
      // Логирование
      log: this.log.bind(this),
      
      // События для UI
      emit: this.emit.bind(this),
      
      // Streaming
      onChunk: (chunk) => {
        if (this.currentOnChunk) {
          this.currentOnChunk(chunk);
        }
      },
      
      // История разговора
      history: this.history,
      
      // Вызов других агентов
      callAgent: this.createCallAgent(),
      
      // Конфигурация
      config: this.config.customConfig || {},
      
      // Утилиты
      utils: {
        chalk,
        sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
        formatDate: (date = new Date()) => date.toISOString(),
      }
    };
  }

  /**
   * Создаёт функцию callAgent для вызова других агентов
   */
  createCallAgent() {
    const self = this;
    
    return async (agentName, prompt) => {
      const { loadAgents } = await import('./agentLoader.js');
      const { countdown } = await import('../utils/timer.js');
      
      const allAgents = await loadAgents();
      const allowed = new Set(self.callableAgents);
      
      // Находим ключ агента
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
      
      if (!allowed.has(targetKey) && !allowed.has(allAgents[targetKey]?.name)) {
        throw new Error(`Calling agent "${agentName}" is not permitted by this agent's configuration`);
      }
      
      const targetConfig = allAgents[targetKey];
      const delaySec = typeof targetConfig.interAgentDelaySeconds === 'number' 
        ? targetConfig.interAgentDelaySeconds 
        : 5;
        
      if (delaySec > 0) {
        await countdown(delaySec, `Calling agent "${agentName}" (rate limit delay)`);
      }
      
      // Создаём нужный тип агента
      let nested;
      if (targetConfig.isCustom) {
        nested = new CustomAgent(targetConfig);
      } else {
        const { Agent } = await import('./agent.js');
        nested = new Agent(targetConfig);
      }
      
      if (self.logger) {
        nested.setLogger(self.logger);
      }
      
      await nested.initialize();
      
      const calledAgentOnChunk = self.currentOnChunk 
        ? (chunk) => self.currentOnChunk(chunk) 
        : null;
        
      const calledAgentOnEvent = self.currentOnEvent 
        ? (event, data) => self.currentOnEvent(event, data) 
        : null;
      
      const response = await nested.processMessage(
        String(prompt || ''), 
        calledAgentOnChunk, 
        calledAgentOnEvent
      );
      
      // Trim response to only include last 3 steps for non-custom agents
      // Для кастомных агентов просто возвращаем ответ как есть
      const trimmedResponse = targetConfig.isCustom ? response : self.trimToLastAction(response);
      
      return trimmedResponse;
    };
  }

  /**
   * Загрузка кастомного модуля
   */
  async loadModule() {
    if (this.module) {
      return this.module;
    }

    try {
      // Резолвим путь к модулю
      const modulePath = isAbsolute(this.entryPath)
        ? this.entryPath
        : resolve(this.agentDir, this.entryPath);
      
      // Конвертируем в file URL для корректного импорта на Windows
      const moduleUrl = pathToFileURL(modulePath).href;
      
      this.log(`${chalk.blue('📦')} Loading custom module: ${chalk.cyan(modulePath)}`, 'system');
      
      this.module = await import(moduleUrl);
      
      // Проверяем наличие обязательной функции process
      if (typeof this.module.process !== 'function') {
        throw new Error(
          `Custom agent module must export a 'process' function.\n` +
          `Expected: export async function process(input, context) { ... }\n` +
          `Found exports: ${Object.keys(this.module).join(', ') || 'none'}`
        );
      }
      
      // Логируем метаданные если есть
      if (this.module.metadata) {
        const meta = this.module.metadata;
        this.log(`${chalk.green('✓')} Loaded: ${chalk.cyan(meta.name || this.name)}`, 'system');
        if (meta.version) {
          this.log(`  Version: ${chalk.gray(meta.version)}`, 'system');
        }
        if (meta.description) {
          this.log(`  ${chalk.gray(meta.description)}`, 'system');
        }
      }
      
      return this.module;
    } catch (error) {
      this.log(`${chalk.red('✗')} Failed to load custom module: ${error.message}`, 'error');
      throw new Error(`Failed to load custom agent module: ${error.message}`);
    }
  }

  /**
   * Инициализация агента
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    this.log(`\n${chalk.cyan.bold('═'.repeat(60))}`, 'system');
    this.log(`${chalk.cyan.bold('🔧 INITIALIZING CUSTOM AGENT:')} ${chalk.yellow(this.name)}`, 'system');
    this.log(`${chalk.cyan.bold('═'.repeat(60))}`, 'system');

    // Загружаем модуль
    await this.loadModule();

    // Вызываем initialize если определён
    if (typeof this.module.initialize === 'function') {
      this.log(`${chalk.blue('⚙️')} Running custom initialization...`, 'system');
      
      const context = this.createContext();
      await this.module.initialize(context);
      
      this.log(`${chalk.green('✓')} Custom initialization complete`, 'system');
    }

    this.initialized = true;
    this.log(`${chalk.green('✓')} Custom agent ready!`, 'system');
    this.log(`${chalk.cyan('═'.repeat(60))}\n`, 'system');
  }

  /**
   * Обработка сообщения
   * @param {string} userMessage - Входное сообщение
   * @param {Function} onChunk - Callback для streaming
   * @param {Function} onEvent - Callback для событий
   * @param {Array} attachments - Вложения (передаются в контекст)
   * @returns {Promise<string>} Ответ агента
   */
  async processMessage(userMessage, onChunk = null, onEvent = null, attachments = []) {
    // Сохраняем callbacks
    this.currentOnChunk = onChunk;
    this.currentOnEvent = onEvent;

    this.log(`\n${chalk.green.bold('═'.repeat(60))}`, 'system');
    this.log(`${chalk.green.bold('🚀 CUSTOM AGENT PROCESSING:')} ${chalk.yellow(this.name)}`, 'system');
    this.log(`${chalk.green.bold('═'.repeat(60))}`, 'system');
    this.log(`${chalk.yellow('User Message:')} ${chalk.white(userMessage)}`, 'system');
    
    if (attachments.length > 0) {
      this.log(`${chalk.yellow('Attachments:')} ${attachments.length} file(s)`, 'system');
    }

    try {
      // Emit thinking event
      if (this.emit) {
        this.emit('thinking:start', { task: 'Processing custom logic' });
      }

      // Создаём расширенный контекст с вложениями
      const context = {
        ...this.createContext(),
        attachments,
        userMessage
      };

      // Вызываем функцию process
      this.log(`${chalk.blue('⚡')} Executing custom logic...`, 'system');
      
      const startTime = Date.now();
      const response = await this.module.process(userMessage, context);
      const duration = Date.now() - startTime;

      // Валидация ответа
      if (typeof response !== 'string') {
        throw new Error(
          `Custom agent process() must return a string.\n` +
          `Received: ${typeof response}`
        );
      }

      this.log(`${chalk.green('✓')} Custom logic executed in ${chalk.cyan(`${duration}ms`)}`, 'system');

      // Обновляем историю
      this.history.push({ role: 'user', content: userMessage });
      this.history.push({ role: 'assistant', content: response });

      // Emit completion
      if (this.emit) {
        this.emit('action:end', { output: response, duration });
      }

      this.log(`${chalk.green.bold('✓ Custom agent processing complete')}`, 'system');
      this.log(`${chalk.green.bold('═'.repeat(60))}\n`, 'system');

      return response;
    } catch (error) {
      this.log(`${chalk.red('✗')} Custom agent error: ${error.message}`, 'error');
      
      if (this.emit) {
        this.emit('error', { message: error.message });
      }
      
      throw error;
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
   * Очистка истории разговора
   */
  clearHistory() {
    this.history = [];
  }

  /**
   * Получение истории разговора
   */
  getHistory() {
    return this.history;
  }

  /**
   * Получение ID сессии
   */
  getSessionId() {
    return this.sessionId;
  }

  /**
   * Очистка ресурсов при завершении
   */
  async cleanup() {
    if (this.module && typeof this.module.cleanup === 'function') {
      this.log(`${chalk.blue('🧹')} Running cleanup...`, 'system');
      await this.module.cleanup();
      this.log(`${chalk.green('✓')} Cleanup complete`, 'system');
    }
  }
}

