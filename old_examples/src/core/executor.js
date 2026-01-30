import { VM } from 'vm2';
import chalk from 'chalk';
import { createProviderInstance } from '../providers/factory.js';
import { ModelSwitchingManager } from '../modelSwitching/modelSwitchingManager.js';
import { createToolUIManager } from './toolUI.js';
import { createRetryHandler } from '../utils/retry.js';

/**
 * Executor - Executes actions using JavaScript code
 */
export class Executor {
  constructor(config, systemPrompt, logger = null) {
    this.logger = logger;
    this.builtIns = {};
    this.emit = null; // Will be injected by Agent
    this.onUsage = null; // injected per request by Agent

    this.baseSystemPrompt = systemPrompt;
    this.systemPrompt = systemPrompt;

    this.baseTemperature = typeof config.temperature === 'number' ? config.temperature : 1;
    this.currentTemperature = this.baseTemperature;

    this.config = {
      ...config,
      customParams: config.customParams || {}
    };

    this.baseApiKey = config.apiKey || (config.provider ? process.env[`${config.provider.toUpperCase()}_API_KEY`] : undefined);
    this.provider = null;
    this.currentModelConfig = null;
    
    // Experimental: File Search Store names (устанавливается Agent при инициализации)
    this.fileSearchStoreNames = null;

    this.modelSwitchingManager = null;
    if (config.modelSwitching && config.modelSwitching.enabled !== false) {
      this.modelSwitchingManager = new ModelSwitchingManager(
        {
          provider: config.provider,
          model: config.model,
          systemPrompt: systemPrompt,
          temperature: this.baseTemperature,
          customParams: config.customParams || {},
          apiKey: this.baseApiKey
        },
        {
          ...config.modelSwitching,
          topK: config.modelSwitching.topK ?? 10
        },
        logger
      );
    }

    this.retry = createRetryHandler();

    // How long we will wait for "fire-and-forget" tool promises started inside <action>
    // (e.g. when the model forgets to await).
    this.toolWaitTimeoutMs =
      typeof config.toolWaitTimeoutMs === 'number' ? config.toolWaitTimeoutMs : 2 * 60 * 1000; // 2 min
  }

  log(message, type = 'info') {
    if (this.logger) {
      this.logger(message, type);
    }
  }

  setBuiltIns(builtIns) {
    this.builtIns = builtIns || {};
  }

  async ensureProviderReady() {
    if (this.modelSwitchingManager) {
      await this.modelSwitchingManager.ensureInitialised();
      const activeConfig = this.modelSwitchingManager.getActiveModelConfig();
      if (!activeConfig) {
        throw new Error('Model switching is enabled, но активная модель не определена.');
      }
      if (!this.currentModelConfig || this.currentModelConfig.id !== activeConfig.id) {
        this.applyModelConfig(activeConfig);
      }
    } else if (!this.provider) {
      const baseModelConfig = {
        id: this.config.model,
        name: this.config.model,
        provider: this.config.provider,
        model: this.config.model,
        systemPrompt: this.baseSystemPrompt,
        temperature: this.baseTemperature,
        customParams: this.config.customParams,
        apiKey: this.baseApiKey
      };
      this.applyModelConfig(baseModelConfig);
    }
  }

  applyModelConfig(modelConfig) {
    const providerName = modelConfig.provider || this.config.provider;
    if (!providerName) {
      throw new Error('Provider is required for executor model configuration.');
    }

    const apiKey =
      modelConfig.apiKey ||
      process.env[`${providerName.toUpperCase()}_API_KEY`] ||
      this.baseApiKey;
    
    if (!apiKey) {
      throw new Error(`API key not found for provider: ${providerName}.`);
    }

    const customParams = {
      ...(this.config.customParams || {}),
      ...(modelConfig.customParams || {})
    };

    this.provider = createProviderInstance(
      providerName,
      apiKey,
      modelConfig.model || modelConfig.id,
      this.logger,
      customParams
    );

    // Experimental: Передаём File Search Store names для gemini провайдера
    if (this.fileSearchStoreNames && 
        this.fileSearchStoreNames.length > 0 && 
        providerName.toLowerCase() === 'gemini' &&
        this.provider.setFileSearchStoreNames) {
      this.provider.setFileSearchStoreNames(this.fileSearchStoreNames);
    }

    this.currentModelConfig = {
      ...modelConfig,
      provider: providerName,
      apiKey,
      customParams
    };

    this.systemPrompt = modelConfig.systemPrompt || this.baseSystemPrompt;
    this.currentTemperature =
      typeof modelConfig.temperature === 'number' ? modelConfig.temperature : this.baseTemperature;
  }

  async switchModel(description) {
    if (!this.modelSwitchingManager) {
      throw new Error('Model switching is not enabled for this executor.');
    }
    if (!description || !description.trim()) {
      throw new Error('switchModel(description) требует непустое описание или имя модели.');
    }

    const modelConfig = await this.modelSwitchingManager.switchModel(description, {
      onUsage: this.onUsage || null
    });
    this.applyModelConfig(modelConfig);
    return this.currentModelConfig;
  }

  getActiveModelConfig() {
    if (this.currentModelConfig) {
      return this.currentModelConfig;
    }
    return {
      provider: this.config.provider,
      model: this.config.model,
      systemPrompt: this.baseSystemPrompt,
      temperature: this.baseTemperature,
      customParams: this.config.customParams,
      apiKey: this.baseApiKey
    };
  }

  /**
   * Execute the next step in the plan
   * @param {Array} todos - TODO list
   * @param {Array} history - Conversation history
   * @param {Object} tools - Loaded tools
   * @param {string} toolDocs - Tool documentation
   * @param {Function} onChunk - Callback for streaming
   * @param {Function} onReasoning - Callback for chain-of-thought streaming
   * @param {number} iteration - Current iteration number
   * @param {Array} attachments - Attachments for the current step
   * @returns {Promise<Object>} Result with content and whether actions were executed
   */
  async executeStep(todos, history, tools, toolDocs, agentDocs, onChunk = null, onReasoning = null, iteration = 1, attachments = []) {
    // Initialize/Reset context settings for this step
    this.currentContextSettings = {
      mode: 'all',
      list: [],
      includeAttachments: true
    };

    const currentTask = todos.find(t => !t.completed);

    // Check for plan-level action (e.g. switchModel) and execute it BEFORE the step
    if (currentTask && currentTask.action && !currentTask.planActionExecuted) {
      this.log(`\n${chalk.blue('⚡')} Plan action detected, executing before step...`, 'executor');
      
      // Note: We DO NOT emit generic 'action:start' here for plan actions
      // because we want to show specific 'model:switch' or 'context:switch' events in the UI
      // without the generic "Executing action..." wrapper.
      
      const startTime = Date.now();
      const observation = await this.executeCode(currentTask.action, tools, todos);
      const duration = Date.now() - startTime;

      // Similarly, no generic 'action:end'
      
      currentTask.planActionExecuted = true;
      this.log(`${chalk.green('✓')} Plan action executed`, 'executor');
    }

    await this.ensureProviderReady();

    const activeModel = this.currentModelConfig || {
      model: this.config.model,
      provider: this.config.provider
    };
    const modelLabel = `${activeModel.provider || 'unknown'}/${activeModel.model || 'unknown'}`;

    const todoList = this.formatTodoList(todos);
    // const currentTask = todos.find(t => !t.completed); // Already found above

    this.log(`\n${chalk.magenta.bold('━'.repeat(60))}`, 'system');
    this.log(`${chalk.magenta.bold('⚙️  EXECUTOR')} ${chalk.gray(`(${modelLabel}) - Iteration ${iteration}`)}`, 'system');
    this.log(`${chalk.magenta.bold('━'.repeat(60))}`, 'system');
    
    this.log(`\n${chalk.yellow('Current TODO List:')}`, 'executor');
    todos.forEach((todo, idx) => {
      const status = todo.completed ? chalk.green('✓') : chalk.gray('○');
      const taskText = todo.completed ? chalk.gray(todo.task) : chalk.white(todo.task);
      const current = !todo.completed && todo === currentTask ? chalk.yellow(' ← Current') : '';
      this.log(`  ${status} ${chalk.blue(`${idx + 1}.`)} ${taskText}${current}`, 'executor');
    });

    if (currentTask) {
      this.log(`\n${chalk.yellow('→')} Executing task: ${chalk.cyan(currentTask.task)}`, 'executor');
    } else {
      this.log(`\n${chalk.green('✓')} All tasks completed`, 'executor');
    }

    if (this.emit) {
      // Emit "Thinking" state before calling LLM
      this.emit('thinking:start', { iteration, task: currentTask ? currentTask.task : 'Finalizing' });
    }

    const builtInLines = [
      '- todo.completeCurrent(): Mark the current task as complete and move to the next one',
      '  * REQUIRED: You MUST call this after completing each task',
      '  * Without this call, the system will stay on the same task'
    ];

    if (this.modelSwitchingManager) {
      builtInLines.push('- switchModel(description: string): Request a different executor model by natural language description or exact model id');
      builtInLines.push('  * Use for tasks that benefit from other models (e.g., "fast, cheap summarisation", "gpt-5")');
    }

    const builtInDocs = builtInLines.join('\n');

    const date = new Date();
    const dateString = `Today is ${date.getDate()} of ${date.toLocaleString('en-US', { month: 'long' })}, the year ${date.getFullYear()}`;

    const executorPrompt = `${this.systemPrompt}
${dateString}

TODO List:
${todoList}

${currentTask ? `Current Task: ${currentTask.task}` : 'All tasks completed'}

Available Tools API:
${toolDocs}

Available Agents API:
${agentDocs}

Built-in API:
${builtInDocs}

Instructions:
- ALWAYS follow the current task from the TODO list
- Write JavaScript code inside <action></action> tags to complete the current task
- You can use async/await syntax - the code is automatically wrapped in an async function
- Use console.log() to output results
- MANDATORY: After completing the current task, you MUST call todo.completeCurrent()
- The output will be returned as an observation
- You can write regular text outside the tags
- Focus on one task at a time - call todo.completeCurrent() to move to the next`;

    // Apply Context Filtering
    let filteredHistory = history;
    let filteredAttachments = attachments;

    if (this.currentContextSettings.mode !== 'all') {
      // Instead of removing messages, replace assistant outputs with summary placeholders
      // This helps the model understand that previous steps were completed
      // User "proceed" messages are kept as-is to maintain proper message alternation
      filteredHistory = history.map(msg => {
        // Always keep messages without _taskIndex (like the initial system/user prompt)
        if (msg._taskIndex === undefined) return msg;
        
        // Keep user messages as-is to ensure proper user/assistant alternation
        // They are short anyway ("proceed by completing X")
        if (msg.role === 'user') return msg;

        const index = msg._taskIndex;
        let shouldKeepFull;
        if (this.currentContextSettings.mode === 'whitelist') {
          shouldKeepFull = this.currentContextSettings.list.includes(index);
        } else if (this.currentContextSettings.mode === 'blacklist') {
          shouldKeepFull = !this.currentContextSettings.list.includes(index);
        } else {
          shouldKeepFull = true;
        }
        
        // If this assistant message should not be kept in full, replace with a summary
        if (!shouldKeepFull && msg.role === 'assistant') {
          return {
            ...msg,
            content: `<...>Context reduced. You have successfully completed step ${index + 1}.<...>`
          };
        }
        
        return msg;
      });
      
      this.log(`${chalk.gray(`Context filtering applied (mode: ${this.currentContextSettings.mode}, list: [${this.currentContextSettings.list.join(', ')}])`)}`, 'executor');
    }

    // Clean up metadata before sending to provider
    const finalHistory = filteredHistory.map(msg => {
      const { _taskIndex, ...rest } = msg;
      return rest;
    });

    if (!this.currentContextSettings.includeAttachments) {
       filteredAttachments = [];
       this.log(`${chalk.gray(`Context filtering: Attachments excluded`)}`, 'executor');
    }

    try {
      let fullResponse = '';
      
      this.log(`${chalk.yellow('→')} Waiting for executor response...`, 'executor');
      
      const response = await this.retry.executeWithRetry(
        () => this.provider.chat(finalHistory, {
          temperature: this.currentTemperature,
          systemPrompt: executorPrompt,
          stopSequences: ['</action>'],
          attachments: filteredAttachments, // Pass filtered attachments
          onChunk: onChunk ? (chunk) => {
            fullResponse += chunk;
            onChunk(chunk);
          } : null,
          onReasoning: onReasoning || null,
          onUsage: this.onUsage || null
        }),
        'Executor chat'
      );

      if (!onChunk) {
        fullResponse = response;
      }

      // Check if response contains action tag
      if (fullResponse.includes('<action>')) {
        this.log(`\n${chalk.blue('⚡')} Action detected, executing...`, 'executor');
        
        // Auto-close unclosed action tag (prevents infinite loops when models omit </action>)
        if (!fullResponse.includes('</action>')) {
          fullResponse += '</action>';
          this.log(`${chalk.gray('  Auto-closed action tag')}`, 'executor');
        }

        this.log(`\n${chalk.blue('⚡')} Action detected, executing...`, 'executor');

        // Execute action and append observation
        if (this.emit) {
          this.emit('action:start', { code: fullResponse }); // We might parse the code here if needed
        }

        const startTime = Date.now();
        const observation = await this.executeAction(fullResponse, tools, todos);
        const duration = Date.now() - startTime;

        if (this.emit) {
           this.emit('action:end', { output: observation, duration });
           // Also check for completed tasks to emit plan updates
           if (todos.some(t => t.completed)) {
             this.emit('plan:update', todos);
           }
        }

        fullResponse += `\n<obs>${observation}</obs>`;

        this.log(`${chalk.green('✓')} Action executed`, 'executor');
        
        // Check if there are more tasks to do
        const remainingTasks = todos.filter(t => !t.completed);
        if (remainingTasks.length > 0) {
          this.log(`${chalk.yellow('→')} ${remainingTasks.length} task(s) remaining`, 'executor');
        } else {
          this.log(`${chalk.green('✓')} All tasks completed!`, 'executor');
        }
        
        this.log(`${chalk.magenta('━'.repeat(60))}\n`, 'system');
        
        return {
          content: fullResponse,
          hasAction: true,
          allTasksCompleted: remainingTasks.length === 0
        };
      }

      // Check if there are incomplete tasks
      const remainingTasks = todos.filter(t => !t.completed);
      const hasIncompleteTasks = remainingTasks.length > 0;

      if (hasIncompleteTasks) {
        // Model didn't call any tools but there are incomplete tasks
        // Add a warning observation to prevent premature completion
        const warningMessage = `Для завершения выполнения задачи вы должны выполнить все пункты в TODO списке. Осталось невыполненных задач: ${remainingTasks.length}. Пожалуйста, выполните текущую задачу "${remainingTasks[0].task}" используя инструменты в тегах <action></action>.`;
        fullResponse += `\n<obs>${warningMessage}</obs>`;
        
        this.log(`${chalk.yellow('⚠')} No action detected, but ${remainingTasks.length} task(s) remaining`, 'executor');
        this.log(`${chalk.yellow('→')} Adding warning observation to prevent premature completion`, 'executor');
        this.log(`${chalk.magenta('━'.repeat(60))}\n`, 'system');

        return {
          content: fullResponse,
          hasAction: false,
          allTasksCompleted: false
        };
      }

      this.log(`${chalk.green('✓')} No action needed, response complete`, 'executor');
      this.log(`${chalk.magenta('━'.repeat(60))}\n`, 'system');

      return {
        content: fullResponse,
        hasAction: false,
        allTasksCompleted: true
      };
    } catch (error) {
      this.log(`${chalk.red('✗')} Executor error: ${error.message}`, 'error');
      // Never break the whole agent loop due to an LLM/provider error.
      // Provide an observation and let the agent try again / proceed.
      const msg = `Ошибка LLM/провайдера в executor: ${error.message}. Продолжаю выполнение (ошибка не фатальна).`;
      const content = `<obs>${msg}</obs>`;
      return {
        content,
        hasAction: false,
        allTasksCompleted: false
      };
    }
  }

  /**
   * Execute raw JavaScript code
   * @param {string} code - Code to execute
   * @param {Object} tools - Available tools
   * @param {Array} todos - TODO list
   * @returns {Promise<string>} Observation result
   */
  async executeCode(code, tools, todos) {
    this.log(`\n${chalk.blue.bold('📄 Code to Execute:')}`, 'executor');
    this.log(chalk.gray('  ┌─────────────────────────────────────────────'), 'executor');
    code.split('\n').forEach(line => {
      this.log(chalk.gray(`  │ ${line}`), 'executor');
    });
    this.log(chalk.gray('  └─────────────────────────────────────────────'), 'executor');
    
    let output = '';

    // Create ToolUI manager for this execution
    const toolUIManager = this.emit ? createToolUIManager(this.emit) : null;

    // Track all promises returned by tool calls (including ones the model forgot to await).
    const pendingToolPromises = new Set();

    const waitForPendingTools = async () => {
      if (pendingToolPromises.size === 0) return;
      const pendingCount = pendingToolPromises.size;
      this.log(chalk.gray(`Waiting for ${pendingCount} pending tool call(s) to settle...`), 'executor');

      const settleAll = Promise.allSettled(Array.from(pendingToolPromises));
      const timeoutMs = this.toolWaitTimeoutMs;

      if (timeoutMs > 0) {
        const timed = await Promise.race([
          settleAll,
          new Promise(resolve => setTimeout(() => resolve('timeout'), timeoutMs))
        ]);
        if (timed === 'timeout') {
          this.log(chalk.yellow(`⚠ Pending tool calls did not finish within ${timeoutMs}ms; continuing to avoid deadlock.`), 'warning');
        }
      } else {
        await settleAll;
      }
    };

    try {
      // Wrap code in async IIFE to support await
      const wrappedCode = `
(async () => {
${code}
})();
`;

      // Wrap tools to inject toolUI automatically
      const wrappedTools = {};
      for (const [toolName, toolObj] of Object.entries(tools)) {
        if (typeof toolObj === 'object' && toolObj !== null) {
          // Check if tool has _initUI method for auto-UI support
          if (typeof toolObj._initUI === 'function') {
            wrappedTools[toolName] = toolObj._initUI(toolUIManager);
          } else {
            wrappedTools[toolName] = toolObj;
          }
        } else {
          wrappedTools[toolName] = toolObj;
        }
      }

      const wrapFunctionForTracking = (fn, label) => {
        if (typeof fn !== 'function') return fn;
        return (...args) => {
          let ret;
          try {
            ret = fn(...args);
          } catch (err) {
            // Sync throw is handled by VM try/catch and becomes observation error.
            throw err;
          }

          // Track async results so we can await them before finishing the action.
          if (ret && typeof ret.then === 'function') {
            const p = Promise.resolve(ret);
            pendingToolPromises.add(p);
            // Attach a handler so "fire-and-forget" rejections don't crash the process.
            p.catch(() => {}).finally(() => pendingToolPromises.delete(p));
          }

          return ret;
        };
      };

      const wrapObjectDeep = (obj, prefix = '') => {
        if (!obj || typeof obj !== 'object') return obj;
        const out = Array.isArray(obj) ? [] : {};
        for (const [k, v] of Object.entries(obj)) {
          const name = prefix ? `${prefix}.${k}` : k;
          if (typeof v === 'function') {
            out[k] = wrapFunctionForTracking(v, name);
          } else if (v && typeof v === 'object') {
            out[k] = wrapObjectDeep(v, name);
          } else {
            out[k] = v;
          }
        }
        return out;
      };

      const trackedTools = wrapObjectDeep(wrappedTools);

      // Create VM with tools and capture console.log
      const vm = new VM({
        timeout: 10000,
        sandbox: {
          ...trackedTools,
          ...this.builtIns,
          // Expose toolUI API for manual use
          toolUI: toolUIManager ? {
            create: (config) => toolUIManager.create(config)
          } : null,
          todo: {
            completeCurrent: () => {
              const currentTask = todos.find(t => !t.completed);
              if (currentTask) {
                currentTask.completed = true;
                this.log(`${chalk.green('✓')} Task marked complete: ${chalk.cyan(currentTask.task)}`, 'executor');
                return `Task completed: ${currentTask.task}`;
              }
              return 'No current task to complete';
            }
          },
          context: {
            whitelist: (indices) => {
              if (!Array.isArray(indices)) throw new Error('whitelist expects an array of numbers');
              this.currentContextSettings = { mode: 'whitelist', list: indices, includeAttachments: this.currentContextSettings?.includeAttachments ?? true };
              this.log(`${chalk.blue('👁')} Context switched to WHITELIST: [${indices.join(', ')}]`, 'executor');
              if (this.emit) this.emit('context:switch', { mode: 'whitelist', indices });
            },
            blacklist: (indices) => {
              if (!Array.isArray(indices)) throw new Error('blacklist expects an array of numbers');
              this.currentContextSettings = { mode: 'blacklist', list: indices, includeAttachments: this.currentContextSettings?.includeAttachments ?? true };
              this.log(`${chalk.blue('👁')} Context switched to BLACKLIST: [${indices.join(', ')}]`, 'executor');
              if (this.emit) this.emit('context:switch', { mode: 'blacklist', indices });
            },
            includeAttachments: (bool) => {
              this.currentContextSettings = { ...this.currentContextSettings, includeAttachments: !!bool };
              this.log(`${chalk.blue('📎')} Context attachments: ${bool}`, 'executor');
              if (this.emit) this.emit('context:switch', { mode: 'attachments', value: !!bool });
            },
            includeAll: () => {
              this.currentContextSettings = { mode: 'all', list: [], includeAttachments: true };
              this.log(`${chalk.blue('👁')} Context reset to ALL`, 'executor');
              if (this.emit) this.emit('context:switch', { mode: 'reset' });
            }
          },
          switchModel: async (description) => {
            if (!this.modelSwitchingManager) {
              throw new Error('Model switching is not enabled for this executor.');
            }
            
            if (this.emit) {
               this.emit('model:switch:start', { description });
            }

            this.log(`${chalk.blue('🔄')} Switching model: ${chalk.cyan(description)}`, 'executor');
            const result = await this.switchModel(description);
            
            if (this.emit) {
               this.emit('model:switch:end', { 
                   from: description, // User description
                   to: result.name || result.model // Actual model name
               });
            }

            this.log(`${chalk.green('✓')} Switched to: ${chalk.cyan(result.id)} (${result.provider})`, 'executor');
            return result;
          },
          console: {
            log: (...args) => {
              output += args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
              ).join(' ') + '\n';
            }
          }
        }
      });

      // Run the wrapped code and await if it returns a promise
      const result = vm.run(wrappedCode);
      
      // If the result is a promise, wait for it
      if (result && typeof result.then === 'function') {
        await result;
      }
      await waitForPendingTools();
      
      const finalOutput = output.trim() || 'Action executed successfully (no output)';
      
      this.log(`\n${chalk.green.bold('📤 Observation:')}`, 'executor');
      this.log(chalk.greenBright(`  ${finalOutput.split('\n').join('\n  ')}`), 'executor');
      
      return finalOutput;
    } catch (error) {
      this.log(`${chalk.red('✗')} Code execution error: ${error.message}`, 'error');
      return `Error executing action: ${error.message}`;
    } finally {
      // Best-effort cleanup: close UIs and wait for any leftover tool promises,
      // even if the action code itself failed.
      try {
        await waitForPendingTools();
      } catch {}
      try {
        if (toolUIManager) toolUIManager.finishAll();
      } catch {}
    }
  }

  /**
   * Execute JavaScript code from action tag
   * @param {string} response - Response containing action tag
   * @param {Object} tools - Available tools
   * @param {Array} todos - TODO list for todo.complete()
   * @returns {Promise<string>} Observation result
   */
  async executeAction(response, tools, todos) {
    // Extract code from action tag
    const actionMatch = response.match(/<action>([\s\S]*?)<\/action>/);
    if (!actionMatch) {
      this.log(`${chalk.red('✗')} No action code found in response`, 'error');
      return 'Error: No action code found';
    }

    const code = actionMatch[1].trim();
    return this.executeCode(code, tools, todos);
  }

  formatTodoList(todos) {
    return todos.map((todo, idx) => {
      const status = todo.completed ? '✓' : ' ';
      return `[${status}] ${idx + 1}. ${todo.task}`;
    }).join('\n');
  }
}

