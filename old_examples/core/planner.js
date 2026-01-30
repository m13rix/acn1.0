import { OpenRouterProvider } from '../providers/openrouter.js';
import { GeminiProvider } from '../providers/gemini.js';
import { CerebrasProvider } from '../providers/cerebras.js';
import { createRetryHandler } from '../utils/retry.js';
import chalk from 'chalk';

/**
 * Planner - Creates TODO lists for achieving goals
 */
export class Planner {
  constructor(config, systemPrompt, logger = null) {
    this.config = config;
    this.systemPrompt = systemPrompt;
    this.provider = this.createProvider();
    this.logger = logger;
    this.emit = null; // Will be injected by Agent
    this.onUsage = null; // injected per request by Agent
    this.retry = createRetryHandler();
  }

  log(message, type = 'info') {
    if (this.logger) {
      this.logger(message, type);
    }
  }

  createProvider() {
    // Check for custom API key in config first, then fall back to environment variable
    const apiKey = this.config.apiKey || process.env[`${this.config.provider.toUpperCase()}_API_KEY`];
    
    if (!apiKey) {
      throw new Error(`API key not found for provider: ${this.config.provider}. Set ${this.config.provider.toUpperCase()}_API_KEY environment variable or apiKey in config.`);
    }

    // Get custom parameters from config
    const customParams = this.config.customParams || {};

    switch (this.config.provider.toLowerCase()) {
      case 'openrouter':
        return new OpenRouterProvider(apiKey, this.config.model, this.logger, customParams);
      case 'gemini':
        return new GeminiProvider(apiKey, this.config.model, this.logger, customParams);
      case 'cerebras':
        return new CerebrasProvider(apiKey, this.config.model, this.logger, customParams);
      default:
        throw new Error(`Unknown provider: ${this.config.provider}`);
    }
  }

  /**
   * Create a TODO list for achieving the user's goal
   * @param {string} userMessage - User's request
   * @param {Array} history - Conversation history
   * @param {string} toolCapabilities - High-level tool descriptions
   * @param {Array} attachments - File attachments
   * @returns {Promise<Array>} Array of TODO items
   */
  async createPlan(userMessage, history, toolCapabilities, attachments = []) {
    this.log(`\n${chalk.cyan.bold('━'.repeat(60))}`, 'system');
    this.log(`${chalk.cyan.bold('📋 PLANNER')} ${chalk.gray(`(${this.config.model})`)}`, 'system');
    this.log(`${chalk.cyan.bold('━'.repeat(60))}`, 'system');
    this.log(`${chalk.yellow('→')} Creating action plan for user request...`, 'planner');

    const date = new Date();
    const dateString = `Today is ${date.getDate()} of ${date.toLocaleString('en-US', { month: 'long' })}, the year ${date.getFullYear()}`;

    let promptContext = '';
    if (attachments && attachments.length > 0) {
      const textAttachments = attachments.filter(att => 
        att.type.startsWith('text/') || 
        att.type === 'application/json' || 
        att.type === 'application/javascript' ||
        att.type === 'text/javascript' ||
        att.type === 'text/typescript' ||
        att.name.endsWith('.js') ||
        att.name.endsWith('.ts') ||
        att.name.endsWith('.py') ||
        att.name.endsWith('.md') ||
        att.name.endsWith('.txt')
      );

      if (textAttachments.length > 0) {
        promptContext += '\n\nAttached Files:\n';
        textAttachments.forEach(att => {
          try {
            const base64 = att.dataUrl.split(',')[1];
            const content = Buffer.from(base64, 'base64').toString('utf-8');
            promptContext += `\n--- File: ${att.name} ---\n${content}\n--- End of File ---\n`;
          } catch (e) {
            this.log(`Failed to decode text attachment ${att.name}: ${e.message}`, 'error');
          }
        });
      }
      
      const otherAttachments = attachments.filter(att => !textAttachments.includes(att));
      if (otherAttachments.length > 0) {
        promptContext += '\n\nOther Attachments (Binary/Image):\n';
        otherAttachments.forEach(att => {
          promptContext += `- ${att.name} (${att.type})\n`;
        });
      }
    }

    const plannerPrompt = `${this.systemPrompt}
${dateString}

Available Tools:
${toolCapabilities}

${promptContext}

Create a TODO list to accomplish the user's goal. Format each task on a new line starting with "- ".
You can specifically execute system commands using <action> tags at the end of a task line.
Available System Tools (execute these directly in the plan step using <action> tags):
- switchModel(description): Switch the underlying model for better performance or cost. This executes AUTOMATICALLY before the step begins.
  Example: "- Analyze complex data <action>await switchModel('high-reasoning')</action>"
- context.whitelist(indices: number[]): Restrict context to only results from specified plan item indices.
  Example: "- Summarize previous findings <action>context.whitelist([0, 1])</action>"
- context.blacklist(indices: number[]): Exclude results from specified plan item indices.
- context.includeAttachments(bool): Include/exclude file attachments for this step.
- context.includeAll(): Reset context to include everything (default).`;

    const messages = [
      ...history,
      { role: 'user', content: userMessage }
    ];

    try {
      const response = await this.retry.executeWithRetry(
        () => this.provider.chat(messages, {
          temperature: this.config.temperature,
          systemPrompt: plannerPrompt,
          onUsage: this.onUsage || null
        }),
        'Planner chat'
      );

      this.log(`${chalk.green('✓')} Planner response received`, 'planner');
      this.log(`\n${chalk.gray('Raw planner output:')}`, 'planner');
      this.log(`${chalk.gray(response)}`, 'planner');

      // Check if response is valid
      if (!response || typeof response !== 'string') {
        throw new Error(`Invalid planner response: ${typeof response}`);
      }

      // Parse TODO list from response
      const todos = this.parseTodoList(response);
      
      if (this.emit) {
        this.emit('plan:created', todos);
      }
      
      this.log(`\n${chalk.green.bold('📝 TODO List Created:')}`, 'planner');
      todos.forEach((todo, idx) => {
        this.log(`  ${chalk.blue(`${idx + 1}.`)} ${todo.task}`, 'planner');
      });
      this.log(`${chalk.cyan('━'.repeat(60))}\n`, 'system');

      // Возвращаем объект с todos и исходным ответом планировщика
      return { todos, response };
    } catch (error) {
      this.log(`${chalk.red('✗')} Planner error: ${error.message}`, 'error');
      // Never hard-crash the whole run because planning failed.
      // Provide a minimal fallback plan so the executor can still attempt the task.
      const fallbackTodos = [{
        task: 'Выполнить запрос пользователя (планировщик временно недоступен, продолжаем без подробного плана)',
        completed: false
      }];
      if (this.emit) {
        this.emit('plan:created', fallbackTodos);
      }
      this.log(`${chalk.yellow('⚠')} Using fallback plan due to planner error`, 'warning');
      // Возвращаем объект с fallback планом и пустым ответом
      return { todos: fallbackTodos, response: '' };
    }
  }

  parseTodoList(response) {
    const lines = response.split('\n');
    const todos = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\./.test(trimmed)) {
        let fullLine = trimmed.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim();
        
        // Extract action if present
        let action = null;
        const actionMatch = fullLine.match(/<action>([\s\S]*?)<\/action>/);
        if (actionMatch) {
          action = actionMatch[1].trim();
          fullLine = fullLine.replace(/<action>[\s\S]*?<\/action>/, '').trim();
        }

        if (fullLine) {
          todos.push({
            task: fullLine,
            action, // code to execute before step
            planActionExecuted: false, // execution state tracking
            completed: false
          });
        }
      }
    }

    // If no todos found, create a simple one
    if (todos.length === 0) {
      todos.push({
        task: 'Complete the user request',
        completed: false
      });
    }

    return todos;
  }

  formatTodoList(todos) {
    return todos.map((todo, idx) => {
      const status = todo.completed ? '✓' : ' ';
      return `[${status}] ${idx + 1}. ${todo.task}`;
    }).join('\n');
  }
}

