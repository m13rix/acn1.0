// Simulation tool - LLM-based human behavior simulation and prediction
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function loadSystemPrompt() {
  const path = join(__dirname, 'system_prompt.txt');
  return await readFile(path, 'utf8');
}

async function loadIndividualModel(individualId) {
  const path = join(__dirname, 'models', `${individualId}.json`);
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

function buildUserPrompt(individualId, scenarioDescription, initialSystemState) {
  return (
    `Simulate response for ${individualId} using the following parameters:\n` +
    `Scenario: "${scenarioDescription}"\n` +
    `Initial SystemState:\n${initialSystemState}\n`
  );
}

async function runSimulation(individualId, scenarioDescription, initialSystemState) {
  try {
    if (typeof individualId !== 'number') {
      throw new Error('Параметр individualId должен быть числом');
    }
    if (!scenarioDescription || !initialSystemState) {
      throw new Error('Требуются параметры scenarioDescription и initialSystemState');
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Необходимо установить переменную окружения GEMINI_API_KEY');
    }

    const systemPrompt = await loadSystemPrompt();
    const conversation = await loadIndividualModel(individualId);

    const ai = new GoogleGenAI({ apiKey });
    const model = 'models/gemini-2.5-pro';

    const userPrompt = buildUserPrompt(individualId, scenarioDescription, initialSystemState);

    // Prepare contents: replay the stored conversation, then add the new user prompt
    const contents = [];
    if (Array.isArray(conversation?.messages)) {
      for (const msg of conversation.messages) {
        if (!msg?.role || !msg?.content) continue;
        contents.push({ role: msg.role, parts: [{ text: msg.content }] });
      }
    }
    contents.push({ role: 'user', parts: [{ text: userPrompt }] });

    console.log(chalk.blue(`\n🧠 Simulation.run для индивида ${individualId}`));
    console.log(chalk.gray('— Модель:'), chalk.white(model));
    console.log(chalk.gray('— Файл промпта:'), chalk.white('system_prompt.txt'));
    console.log(chalk.gray('— Модель индивида:'), chalk.white(`${individualId}.json`));
    console.log(chalk.gray('\n▶ Входной запрос:'));
    console.log(chalk.white(userPrompt));
    console.log(chalk.gray('\n⌛ Генерация ответа (streaming)...'));

    const responseStream = await ai.models.generateContentStream({
      model,
      contents,
      config: {
        systemInstruction: systemPrompt
      }
    });

    let fullText = '';
    for await (const chunk of responseStream) {
      const text = chunk.text || '';
      if (text) {
        fullText += text;
        process.stdout.write(chalk.green(text));
      }
    }

    console.log(chalk.green('\n✅ Симуляция завершена'));
    return fullText.trim();
  } catch (error) {
    console.error(chalk.red('❌ Ошибка simulation.run:'), error.message);
    return `Ошибка: ${error.message}`;
  }
}

async function getIndividualModel(individualId) {
  try {
    if (typeof individualId !== 'number') {
      throw new Error('Параметр individualId должен быть числом');
    }

    const conversation = await loadIndividualModel(individualId);
    
    if (!Array.isArray(conversation?.messages)) {
      throw new Error(`Модель индивида ${individualId} не содержит сообщений`);
    }

    // Найти последнее сообщение от роли assistant/model
    const lastAssistantMessage = conversation.messages
      .filter(msg => msg.role === 'model' || msg.role === 'assistant')
      .pop();

    if (!lastAssistantMessage) {
      throw new Error(`В модели индивида ${individualId} нет сообщений от assistant`);
    }

    console.log(chalk.blue(`\n📖 Получение модели индивида ${individualId}`));
    console.log(chalk.gray('— Файл модели:'), chalk.white(`${individualId}.json`));
    console.log(chalk.gray('— Последнее сообщение assistant:'));
    console.log(chalk.white(lastAssistantMessage.content));
    console.log(chalk.green('\n✅ Модель получена'));

    return lastAssistantMessage.content;
  } catch (error) {
    console.error(chalk.red('❌ Ошибка simulation.get:'), error.message);
    return `Ошибка: ${error.message}`;
  }
}

export const simulation = {
  /**
   * Run simulation for specific individual
   * @param {number} individualId - Individual identifier (e.g., 13)
   * @param {string} scenarioDescription - Detailed scenario description
   * @param {string} initialSystemState - Initial state text
   * @returns {Promise<string>} Model output
   */
  run: runSimulation,

  /**
   * Get last assistant message from individual model
   * @param {number} individualId - Individual identifier (e.g., 13)
   * @returns {Promise<string>} Last assistant message content
   */
  get: getIndividualModel
};


