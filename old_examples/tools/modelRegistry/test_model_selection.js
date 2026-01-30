#!/usr/bin/env node

import inquirer from 'inquirer';
import chalk from 'chalk';
import { loadAgents } from '../../src/core/agentLoader.js';
import { selectModel } from '../../src/modelSwitching/modelSelector.js';
import { loadModelRegistry, loadEmbeddingIndex, attachEmbeddings } from '../../src/modelSwitching/modelRegistry.js';
import { rankBySimilarity } from '../../src/modelSwitching/vectorSearch.js';
import { embedQuery } from '../../src/utils/embeddingService.js';
import { createProviderInstance } from '../../src/providers/factory.js';

async function displayModelSwitchingConfig(config) {
  console.log(chalk.cyan('\n📋 Конфигурация Model Switching:'));
  console.log(chalk.gray('━'.repeat(60)));
  console.log(chalk.yellow('Режим:'), chalk.white(config.mode || 'whitelist'));
  if (config.whitelist && config.whitelist.length > 0) {
    console.log(chalk.yellow('Whitelist:'), chalk.white(config.whitelist.join(', ')));
  }
  if (config.blacklist && config.blacklist.length > 0) {
    console.log(chalk.yellow('Blacklist:'), chalk.white(config.blacklist.join(', ')));
  }
  console.log(chalk.yellow('TopK:'), chalk.white(config.topK || 10));
  console.log(chalk.yellow('Реестр моделей:'), chalk.white(config.registryPath));
  console.log(chalk.yellow('Индекс эмбеддингов:'), chalk.white(config.embeddingIndexPath || 'нет'));
  if (config.selector) {
    console.log(chalk.yellow('Selector LLM:'), chalk.white(`${config.selector.provider}/${config.selector.model}`));
  }
  console.log(chalk.gray('━'.repeat(60)));
}

async function testModelSelection() {
  console.clear();
  console.log(chalk.cyan.bold('\n╔════════════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║                                                ║'));
  console.log(chalk.cyan.bold('║     🧪 Тестирование выбора модели              ║'));
  console.log(chalk.cyan.bold('║                                                ║'));
  console.log(chalk.cyan.bold('╚════════════════════════════════════════════════╝\n'));

  // Step 1: Select agent
  const agents = await loadAgents();
  const agentChoices = Object.keys(agents).map(key => ({
    name: `${agents[key].name} (${key})`,
    value: key
  }));

  if (agentChoices.length === 0) {
    console.log(chalk.red('Агенты не найдены! Создайте агента в директории agents/'));
    process.exit(1);
  }

  const { selectedAgent } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedAgent',
      message: 'Выберите агента:',
      choices: agentChoices
    }
  ]);

  const agentConfig = agents[selectedAgent];
  console.log(chalk.green(`\n✓ Выбран агент: ${agentConfig.name}\n`));

  // Check if model switching is enabled
  const modelSwitchingConfig = agentConfig.executor?.modelSwitching;
  if (!modelSwitchingConfig || !modelSwitchingConfig.enabled) {
    console.log(chalk.red('❌ У этого агента не включен model switching!'));
    process.exit(1);
  }

  await displayModelSwitchingConfig(modelSwitchingConfig);

  // Step 2: Get description from user
  const { description } = await inquirer.prompt([
    {
      type: 'input',
      name: 'description',
      message: 'Введите описание модели (например: "fast, cheap summarisation" или "gpt-5"):',
      validate: (input) => {
        if (!input || !input.trim()) {
          return 'Описание не может быть пустым';
        }
        return true;
      }
    }
  ]);

  console.log(chalk.cyan(`\n🔍 Запрос: "${description}"\n`));
  console.log(chalk.gray('━'.repeat(60)));

  // Step 3: Detailed selection process
  const detailedLogger = (message) => {
    console.log(chalk.gray(message));
  };

  try {
    // Load models
    console.log(chalk.blue('\n[1/6] Загрузка реестра моделей...'));
    const models = await loadModelRegistry(modelSwitchingConfig.registryPath);
    console.log(chalk.green(`✓ Загружено моделей: ${models.length}`));

    // Prepare candidates
    console.log(chalk.blue('\n[2/6] Фильтрация моделей...'));
    let candidates = models.map(model => ({
      ...model,
      id: model.id || model.name
    }));

    const mode = modelSwitchingConfig.mode || 'whitelist';
    const whitelist = modelSwitchingConfig.whitelist || [];
    const blacklist = modelSwitchingConfig.blacklist || [];

    if (mode === 'whitelist') {
      if (whitelist.length === 0) {
        throw new Error('Режим whitelist требует указания списка моделей.');
      }
      const before = candidates.length;
      candidates = candidates.filter(candidate => {
        const id = String(candidate.id || '').toLowerCase();
        return whitelist.some(item => item.toLowerCase() === id);
      });
      console.log(chalk.green(`✓ Отфильтровано по whitelist: ${before} → ${candidates.length}`));
      if (whitelist.length <= 10) {
        console.log(chalk.gray(`  Whitelist: ${whitelist.join(', ')}`));
      }
    } else if (mode === 'blacklist') {
      if (blacklist.length > 0) {
        const before = candidates.length;
        const blacklistSet = new Set(blacklist.map(item => item.toLowerCase()));
        candidates = candidates.filter(candidate => !blacklistSet.has(String(candidate.id || '').toLowerCase()));
        console.log(chalk.green(`✓ Отфильтровано по blacklist: ${before} → ${candidates.length}`));
        if (blacklist.length <= 10) {
          console.log(chalk.gray(`  Blacklist: ${blacklist.join(', ')}`));
        }
      } else {
        console.log(chalk.yellow('⚠ Blacklist пуст, используются все модели'));
      }
    }

    // Direct match check
    console.log(chalk.blue('\n[3/6] Проверка прямого совпадения...'));
    const normalizedQuery = String(description).trim().toLowerCase();
    const directMatch = candidates.find(candidate => {
      const id = String(candidate.id ?? '').toLowerCase();
      const name = String(candidate.name ?? '').toLowerCase();
      return id === normalizedQuery || name === normalizedQuery;
    });

    if (directMatch) {
      console.log(chalk.green(`✓ Найдено прямое совпадение: ${directMatch.id}`));
      console.log(chalk.cyan('\n✅ ИТОГОВЫЙ ВЫБОР:'));
      console.log(chalk.white(`   ID: ${directMatch.id}`));
      console.log(chalk.white(`   Название: ${directMatch.name}`));
      console.log(chalk.white(`   Провайдер: ${directMatch.provider || 'не указан'}`));
      if (directMatch.description && directMatch.description !== 'None') {
        console.log(chalk.gray(`   Описание: ${directMatch.description.substring(0, 100)}...`));
      }
      return;
    } else {
      console.log(chalk.yellow('⚠ Прямого совпадения не найдено, переходим к семантическому поиску'));
    }

    // Semantic search
    let reducedCandidates = candidates;
    if (mode !== 'whitelist') {
      console.log(chalk.blue('\n[4/6] Семантический поиск...'));
      
      try {
        const embeddingIndex = await loadEmbeddingIndex(modelSwitchingConfig.embeddingIndexPath);
        console.log(chalk.gray(`   Загружено эмбеддингов: ${embeddingIndex.size}`));
        
        const withEmbeddings = attachEmbeddings(candidates, embeddingIndex);
        const candidatesWithEmbeddings = withEmbeddings.filter(m => m.embedding);
        console.log(chalk.gray(`   Модели с эмбеддингами: ${candidatesWithEmbeddings.length}`));

        if (candidatesWithEmbeddings.length > 0) {
          const queryEmbedding = await embedQuery(description, modelSwitchingConfig.embedding);
          console.log(chalk.green('✓ Эмбеддинг запроса вычислен'));

          const topK = modelSwitchingConfig.topK || 10;
          const ranked = rankBySimilarity(candidatesWithEmbeddings, queryEmbedding, topK, 0.4);
          
          if (ranked.length > 0) {
            reducedCandidates = ranked;
            console.log(chalk.green(`✓ Отобрано ${ranked.length} кандидатов по схожести:`));
            ranked.slice(0, 10).forEach((candidate, idx) => {
              const similarity = ((candidate.similarity || 0) * 100).toFixed(1);
              console.log(chalk.gray(`   ${idx + 1}. ${candidate.id} (${similarity}%)`));
            });
          } else {
            console.log(chalk.yellow('⚠ По семантическому поиску ничего не найдено, используем все кандидаты'));
          }
        } else {
          console.log(chalk.yellow('⚠ Эмбеддинги не найдены, используем все кандидаты'));
        }
      } catch (error) {
        console.log(chalk.red(`✗ Ошибка при семантическом поиске: ${error.message}`));
        console.log(chalk.yellow('⚠ Продолжаем с полным списком кандидатов'));
      }
    } else {
      console.log(chalk.yellow('⚠ Режим whitelist, семантический поиск пропущен'));
    }

    // Limit candidates
    const topK = modelSwitchingConfig.topK || 10;
    reducedCandidates = reducedCandidates.slice(0, topK);

    if (reducedCandidates.length === 1) {
      console.log(chalk.blue('\n[5/6] Единственный кандидат'));
      console.log(chalk.green(`✓ Выбран: ${reducedCandidates[0].id}`));
      const selected = reducedCandidates[0];
      console.log(chalk.cyan('\n✅ ИТОГОВЫЙ ВЫБОР:'));
      console.log(chalk.white(`   ID: ${selected.id}`));
      console.log(chalk.white(`   Название: ${selected.name}`));
      console.log(chalk.white(`   Провайдер: ${selected.provider || 'не указан'}`));
      if (selected.description && selected.description !== 'None') {
        console.log(chalk.gray(`   Описание: ${selected.description.substring(0, 100)}...`));
      }
      return;
    }

    // LLM Selection
    console.log(chalk.blue('\n[5/6] Подготовка кандидатов для LLM-селектора...'));
    console.log(chalk.gray(`   Кандидатов для выбора: ${reducedCandidates.length}`));
    
    // Show candidates
    console.log(chalk.yellow('\n📝 Кандидаты для выбора:'));
    reducedCandidates.forEach((candidate, idx) => {
      console.log(chalk.gray(`   ${idx + 1}. ${candidate.id} (${candidate.provider || 'unknown'})`));
      if (candidate.description && candidate.description !== 'None') {
        const descPreview = candidate.description.substring(0, 80);
        console.log(chalk.gray(`      ${descPreview}...`));
      }
    });

    if (!modelSwitchingConfig.selector) {
      throw new Error('Не указана конфигурация selector, необходимая для выбора модели.');
    }

    console.log(chalk.blue('\n[6/6] Запрос к LLM-селектору...'));
    console.log(chalk.gray(`   Provider: ${modelSwitchingConfig.selector.provider}`));
    console.log(chalk.gray(`   Model: ${modelSwitchingConfig.selector.model}`));

    // Show the prompt that will be sent to LLM
    const prepareSelectorPrompt = (desc, candidates) => {
      const list = candidates.map((candidate, index) => {
        const provider = candidate.provider || 'unknown';
        const desc = candidate.description || 'No description provided.';
        return `${index + 1}. ${candidate.id} (provider: ${provider})\n   ${desc}`;
      }).join('\n\n');

      return `Request locale: en-US
Requested capabilities/description: ${desc}

Candidate models:
${list}

Rules:
- Select exactly one model id from the candidate list that best matches the request.
- Answer with the model id only, no additional words or formatting.
- If multiple models fit equally well, prefer the one specialising in reasoning or accuracy.
- If nothing matches, pick the closest candidate anyway.`;
    };

    const selectorPrompt = prepareSelectorPrompt(description, reducedCandidates);
    if (modelSwitchingConfig.selector.systemPrompt) {
      console.log(chalk.yellow('\n📋 System Prompt для селектора:'));
      console.log(chalk.gray(modelSwitchingConfig.selector.systemPrompt));
    }
    console.log(chalk.yellow('\n📝 Промпт для LLM-селектора:'));
    console.log(chalk.gray(selectorPrompt));

    // Call LLM directly to show its response
    console.log(chalk.gray('\n   Отправка запроса к LLM...'));
    const selectorConfig = modelSwitchingConfig.selector;
    const providerInstance = createProviderInstance(
      selectorConfig.provider,
      selectorConfig.apiKey || process.env[`${selectorConfig.provider.toUpperCase()}_API_KEY`],
      selectorConfig.model,
      null,
      selectorConfig.customParams || {}
    );

    const llmResponse = await providerInstance.chat(
      [{ role: 'user', content: selectorPrompt }],
      {
        temperature: selectorConfig.temperature || 0,
        systemPrompt: selectorConfig.systemPrompt || ''
      }
    );

    const llmAnswer = String(llmResponse || '').trim();
    console.log(chalk.yellow('\n💬 Ответ LLM-селектора:'));
    console.log(chalk.white(`   "${llmAnswer}"`));

    // Now use selectModel to get the final result
    const selectorLogger = (message) => {
      console.log(chalk.gray(`   ${message}`));
    };

    const selectedModel = await selectModel(description, modelSwitchingConfig, {
      logger: detailedLogger,
      selectorLogger
    });

    console.log(chalk.green(`✓ LLM выбрал модель: ${selectedModel.id}`));

    // Display final result
    console.log(chalk.cyan('\n✅ ИТОГОВЫЙ ВЫБОР:'));
    console.log(chalk.gray('━'.repeat(60)));
    console.log(chalk.white(`   ID: ${selectedModel.id}`));
    console.log(chalk.white(`   Model: ${selectedModel.model || selectedModel.id}`));
    console.log(chalk.white(`   Название: ${selectedModel.name || selectedModel.id}`));
    console.log(chalk.white(`   Провайдер: ${selectedModel.provider || 'не указан'}`));
    if (selectedModel.description && selectedModel.description !== 'None') {
      const descLines = selectedModel.description.split('\n').slice(0, 3);
      console.log(chalk.gray(`   Описание:`));
      descLines.forEach(line => {
        console.log(chalk.gray(`      ${line.substring(0, 80)}`));
      });
    }
    if (selectedModel.cost_input != null) {
      console.log(chalk.white(`   Стоимость вход: $${selectedModel.cost_input}/M tokens`));
    }
    if (selectedModel.cost_output != null) {
      console.log(chalk.white(`   Стоимость выход: $${selectedModel.cost_output}/M tokens`));
    }
    if (selectedModel.popularity != null) {
      console.log(chalk.white(`   Популярность: #${selectedModel.popularity}`));
    }
    console.log(chalk.gray('━'.repeat(60)));

  } catch (error) {
    console.error(chalk.red('\n❌ Ошибка при выборе модели:'), error.message);
    if (error.stack) {
      console.error(chalk.gray(error.stack));
    }
    process.exit(1);
  }
}

// Run the test
testModelSelection().catch((error) => {
  console.error(chalk.red('Критическая ошибка:'), error);
  process.exit(1);
});

