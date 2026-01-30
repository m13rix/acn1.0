import inquirer from 'inquirer';
import chalk from 'chalk';
import { loadAgents } from './core/agentLoader.js';
import { Agent } from './core/agent.js';
import { CustomAgent } from './core/customAgent.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Beautiful CLI for the multi-agent framework
 */
export class CLI {
  constructor() {
    this.agent = null;
    this.agentName = null;
    this.verboseMode = true; // Show detailed logs by default
  }

  /**
   * Display welcome screen
   */
  displayWelcome() {
    console.clear();
    console.log(chalk.cyan.bold('\n╔════════════════════════════════════════════════╗'));
    console.log(chalk.cyan.bold('║                                                ║'));
    console.log(chalk.cyan.bold('║        ACN Multi-Agent Framework v1.0          ║'));
    console.log(chalk.cyan.bold('║                                                ║'));
    console.log(chalk.cyan.bold('╚════════════════════════════════════════════════╝\n'));
    console.log(chalk.gray('  A powerful framework with Planner/Executor architecture\n'));
  }

  /**
   * Select an agent from available agents
   */
  async selectAgent() {
    const agents = await loadAgents();
    
    // Разделяем агентов на стандартных и кастомных для удобного отображения
    const agentChoices = Object.keys(agents).map(key => {
      const agent = agents[key];
      const typeLabel = agent.isCustom ? chalk.magenta('[CUSTOM]') : chalk.blue('[STANDARD]');
      return {
        name: `${typeLabel} ${agent.name} (${key})`,
        value: key
      };
    });

    if (agentChoices.length === 0) {
      console.log(chalk.red('No agents found! Please create an agent in the agents/ directory.'));
      process.exit(1);
    }

    const { selectedAgent } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedAgent',
        message: 'Select an agent to interact with:',
        choices: agentChoices
      }
    ]);

    this.agentName = selectedAgent;
    const agentConfig = agents[selectedAgent];

    console.log(chalk.green(`\n✓ Initializing ${agentConfig.name}...\n`));

    // Создаём нужный тип агента
    if (agentConfig.isCustom) {
      this.agent = new CustomAgent(agentConfig);
      this.isCustomAgent = true;
    } else {
      this.agent = new Agent(agentConfig);
      this.isCustomAgent = false;
    }

    // Set up logger
    this.agent.setLogger((message, type) => {
      // Log to console based on type and verbose mode
      if (this.verboseMode) {
        console.log(message);
      }
    });

    await this.agent.initialize();

    console.log(chalk.green('✓ Agent ready!\n'));
    
    // Выводим информацию в зависимости от типа агента
    if (agentConfig.isCustom) {
      console.log(chalk.magenta.bold('═══ CUSTOM AGENT ═══'));
      console.log(chalk.gray(`Entry: ${agentConfig.entryPath}`));
      if (agentConfig.description) {
        console.log(chalk.gray(`Description: ${agentConfig.description}`));
      }
    } else {
      console.log(chalk.gray(`Provider: ${agentConfig.planner.provider} | Planner: ${agentConfig.planner.model}`));
      
      const executorSwitching = agentConfig.executor.modelSwitching;
      const executorLabel = executorSwitching
        ? `${agentConfig.executor.model} (switching: ${executorSwitching.mode}, registry: ${executorSwitching.registryPath})`
        : agentConfig.executor.model;

      console.log(chalk.gray(`Executor: ${executorLabel} | Tools: ${(agentConfig.tools || []).join(', ')}`));
    }
    
    if (agentConfig.callableAgents && agentConfig.callableAgents.length) {
      console.log(chalk.gray(`Callable agents: ${agentConfig.callableAgents.join(', ')}`));
    }
    console.log(chalk.gray(`Verbose logging: ${this.verboseMode ? chalk.green('ON') : chalk.red('OFF')}\n`));
    console.log(chalk.yellow('Commands:'));
    console.log(chalk.yellow('  • "exit" - quit'));
    console.log(chalk.yellow('  • "clear" - clear history'));
    console.log(chalk.yellow('  • "switch" - change agent'));
    console.log(chalk.yellow('  • "verbose" - toggle detailed logging\n'));
  }

  /**
   * Format and display assistant response with colored tags
   */
  displayResponse(content) {
    // Split content by tags and colorize
    let formatted = content;

    // Color action tags
    formatted = formatted.replace(/<action>/g, chalk.blue('<action>'));
    formatted = formatted.replace(/<\/action>/g, chalk.blue('</action>'));

    // Color observation tags
    formatted = formatted.replace(/<obs>/g, chalk.green('<obs>'));
    formatted = formatted.replace(/<\/obs>/g, chalk.green('</obs>'));

    // Extract and highlight observations
    const obsRegex = /<obs>([\s\S]*?)<\/obs>/g;
    formatted = formatted.replace(obsRegex, (match, obs) => {
      return chalk.green('<obs>') + chalk.greenBright(obs) + chalk.green('</obs>');
    });

    console.log(formatted);
  }

  /**
   * Chat loop
   */
  async chatLoop() {
    while (true) {
      const { message } = await inquirer.prompt([
        {
          type: 'input',
          name: 'message',
          message: chalk.cyan('You:'),
          prefix: ''
        }
      ]);

      const trimmedMessage = message.trim();

      if (trimmedMessage.toLowerCase() === 'exit') {
        console.log(chalk.yellow('\nGoodbye!\n'));
        process.exit(0);
      }

      if (trimmedMessage.toLowerCase() === 'clear') {
        this.agent.clearHistory();
        console.log(chalk.green('\n✓ Conversation history cleared\n'));
        continue;
      }

      if (trimmedMessage.toLowerCase() === 'switch') {
        console.log('\n');
        await this.selectAgent();
        continue;
      }

      if (trimmedMessage.toLowerCase() === 'verbose') {
        this.verboseMode = !this.verboseMode;
        console.log(chalk.green(`\n✓ Verbose logging ${this.verboseMode ? 'enabled' : 'disabled'}\n`));
        continue;
      }

      if (!trimmedMessage) {
        continue;
      }

      // Process message with streaming
      console.log('');

      try {
        let responseBuffer = '';
        let isFirstChunk = true;

        await this.agent.processMessage(trimmedMessage, (chunk) => {
          // Print header before first chunk
          if (isFirstChunk) {
            console.log(chalk.magenta('\n💬 Assistant Response:'));
            console.log(chalk.gray('─'.repeat(60)));
            isFirstChunk = false;
          }
          // Stream chunks in real-time
          process.stdout.write(chunk);
          responseBuffer += chunk;
        });

        console.log('');
        console.log(chalk.gray('─'.repeat(60)));
        console.log('');
      } catch (error) {
        console.log(chalk.red(`\nError: ${error.message}\n`));

        if (error.message.includes('API key')) {
          console.log(chalk.yellow('Make sure to set the required environment variables:'));
          console.log(chalk.yellow('- OPENROUTER_API_KEY for OpenRouter'));
          console.log(chalk.yellow('- GEMINI_API_KEY for Google Gemini\n'));
        }
      }
    }
  }

  /**
   * Start the CLI
   */
  async start() {
    this.displayWelcome();
    await this.selectAgent();
    await this.chatLoop();
  }
}

