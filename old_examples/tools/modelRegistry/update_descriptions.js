#!/usr/bin/env node

import Exa from 'exa-js';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MODELS_JSON_PATH = path.join(PROJECT_ROOT, 'data/models/models.json');

const EXA_API_KEY = process.env.EXA_API_KEY || '3b6f5b88-fe18-492f-9d05-f3c67af51590';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'models/gemini-flash-latest';
const MAX_MODELS_PER_RUN = 250;
const GEMINI_RETRY_DELAY_MS = 60000; // 1 minute

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DESCRIPTION_PROMPT_TEMPLATE = (modelName, exaContent) => `You are an expert AI systems engineer with hands-on experience testing and deploying LLMs in production environments as of November 2025.

Task: Write a comprehensive, experience-based description for this model that will power intelligent model selection in an automated agent system.

Model: "${modelName}"

Write 300-500 words covering these aspects with CONCRETE, ACTIONABLE details:

## REAL-WORLD PERFORMANCE (Critical - 40% of content)

- Actual behavior in production use cases (November 2025)

- Response quality consistency and failure modes you've observed

- Real latency/throughput in practice (not just theoretical specs)

- How it handles edge cases, ambiguous instructions, complex multi-step tasks

- Specific weaknesses discovered through real usage (hallucinations, instruction-following gaps, formatting issues)

## COMPARATIVE ANALYSIS (Critical - 30% of content)

Compare directly to these relevant alternatives:

- For coding: vs Claude Sonnet 4.5, GPT-4o, DeepSeek V3, Gemini 2.0 Flash

- For reasoning: vs o1-preview, Claude Opus, Gemini 2.0 Pro

- For speed/cost: vs Gemini Flash, Llama 3.3 70B, Qwen models

- For agents: vs models with native tool calling

Be specific: "outperforms X at Y but struggles with Z compared to W"

## DECISION TRIGGERS (Critical - 20% of content)

Exact scenarios when to CHOOSE this model:

- "Use when: [specific task type] + [specific constraint]"

- "Avoid when: [specific limitation] or [better alternative exists]"

- "Switch from X to this when: [specific condition]"

## TECHNICAL REALITIES (10% of content)

- Actual context window behavior (does it degrade at max context?)

- Tool calling reliability and structured output quality

- System prompt sensitivity

- Temperature/sampling characteristics

- Rate limits and availability issues

## INTEGRATION NOTES

- Best practices from production deployments

- Common pitfalls and how to work around them

- Prompt engineering patterns that work particularly well/poorly

- Cost efficiency in real workflows (not just per-token math)

REQUIREMENTS:

✓ Write from first-person collective experience ("In testing...", "We've observed...", "Production deployments show...")

✓ Include specific numbers, percentages, benchmark scores where known

✓ Compare to at least 3-5 specific alternative models by name

✓ Focus on November 2025 competitive landscape

✓ Mention recent updates/versions if applicable

✓ Be honest about limitations - this is for technical decision-making, not marketing

✓ Structure as flowing paragraphs but with clear logical sections

✓ Optimize for semantic search - use diverse terminology for same concepts

✓ Include trigger phrases like "best for", "avoid for", "better than X at Y"

AVOID:

✗ Generic marketing language

✗ Theoretical capabilities without real-world validation  

✗ Vague comparisons ("competitive with", "similar to")

✗ Outdated information or speculation

✗ Bullet points or headers - write cohesive prose

Output format: Dense, technical prose optimized for semantic embedding and LLM-based model selection. Every sentence should contain decision-relevant information.

Use this information:

${exaContent}`;

async function fetchExaContent(modelName) {
  try {
    const exa = new Exa(EXA_API_KEY);
    const query = `all of the information about the model "${modelName}" for November 2025`;
    
    const result = await exa.searchAndContents(query, {
      text: true,
      type: 'auto'
    });

    // Extract text content from results
    const contents = [];
    if (result.results && Array.isArray(result.results)) {
      for (const item of result.results) {
        if (item.text) {
          contents.push(item.text);
        }
        if (item.excerpt) {
          contents.push(item.excerpt);
        }
      }
    }

    return contents.join('\n\n');
  } catch (error) {
    console.error(chalk.red(`Exa Search error for "${modelName}":`), error.message);
    return '';
  }
}

async function generateDescriptionWithGemini(modelName, exaContent) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const prompt = DESCRIPTION_PROMPT_TEMPLATE(modelName, exaContent);

  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Format similar to GeminiProvider - use contents array and systemInstruction
      const contents = [{ role: 'user', parts: [{ text: prompt }] }];
      
      const response = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: contents,
      });

      // Extract text similar to GeminiProvider
      const text = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      if (!text) {
        console.error('Gemini response:', JSON.stringify(response, null, 2));
        throw new Error('Gemini API returned empty response');
      }

      return text.trim();
    } catch (error) {
      lastError = error;
      console.error(chalk.yellow(`Gemini attempt ${attempt}/${maxRetries} failed for "${modelName}":`), error.message);
      
      if (attempt < maxRetries) {
        console.log(chalk.gray(`Waiting ${GEMINI_RETRY_DELAY_MS / 1000} seconds before retry...`));
        await delay(GEMINI_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`Failed to generate description after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
}

async function updateModelDescriptions(mode = 'none-only') {
  console.log(chalk.cyan('📝 Обновление описаний моделей...'));
  console.log(chalk.gray(`Режим: ${mode === 'none-only' ? 'Только модели с description="None"' : 'Все модели'}`));

  if (!GEMINI_API_KEY) {
    console.error(chalk.red('Ошибка: GEMINI_API_KEY не установлен'));
    process.exit(1);
  }

  // Load models
  let models;
  try {
    const raw = await fs.readFile(MODELS_JSON_PATH, 'utf8');
    models = JSON.parse(raw);
  } catch (error) {
    console.error(chalk.red('Не удалось прочитать models.json:'), error.message);
    process.exit(1);
  }

  if (!Array.isArray(models)) {
    console.error(chalk.red('models.json имеет неожиданный формат (ожидался массив).'));
    process.exit(1);
  }

  // Filter models based on mode
  let modelsToProcess = models;
  if (mode === 'none-only') {
    modelsToProcess = models.filter(m => m.description === 'None' || !m.description);
  }

  // Sort by popularity (ascending - most popular first)
  modelsToProcess = modelsToProcess
    .filter(m => m.popularity != null)
    .sort((a, b) => (a.popularity || 999999) - (b.popularity || 999999));

  // Limit to MAX_MODELS_PER_RUN
  const limitedModels = modelsToProcess.slice(0, MAX_MODELS_PER_RUN);
  
  console.log(chalk.gray(`Всего моделей к обработке: ${limitedModels.length}`));

  // Create a map for quick lookup
  const modelsMap = new Map();
  for (const model of models) {
    modelsMap.set(model.id, model);
  }

  let updatedCount = 0;
  let errorCount = 0;

  // Process each model
  for (let i = 0; i < limitedModels.length; i++) {
    const model = limitedModels[i];
    const index = i + 1;
    
    console.log(chalk.blue(`\n[${index}/${limitedModels.length}] Обработка: ${model.name} (ID: ${model.id})`));

    try {
      // Fetch Exa content
      console.log(chalk.gray('  → Запрос к Exa Search...'));
      const exaContent = await fetchExaContent(model.name);
      
      if (!exaContent || exaContent.trim().length === 0) {
        console.log(chalk.yellow('  ⚠ Exa Search не вернул контент, пропускаем...'));
        errorCount++;
        continue;
      }

      // Generate description with Gemini
      console.log(chalk.gray('  → Генерация описания через Gemini...'));
      const description = await generateDescriptionWithGemini(model.name, exaContent);
      
      if (!description || description.trim().length === 0) {
        console.log(chalk.yellow('  ⚠ Gemini не вернул описание, пропускаем...'));
        errorCount++;
        continue;
      }

      // Update model in map
      const existingModel = modelsMap.get(model.id);
      if (existingModel) {
        existingModel.description = description;
        console.log(chalk.green(`  ✅ Описание обновлено (${description.length} символов)`));
        updatedCount++;
      } else {
        console.log(chalk.yellow('  ⚠ Модель не найдена в основной базе, пропускаем...'));
        errorCount++;
      }

      // Save intermediate results every 10 models
      if (updatedCount > 0 && updatedCount % 10 === 0) {
        console.log(chalk.gray(`  💾 Промежуточное сохранение (${updatedCount} обновлено)...`));
        const updatedArray = Array.from(modelsMap.values());
        await fs.writeFile(MODELS_JSON_PATH, JSON.stringify(updatedArray, null, 2), 'utf8');
      }

      // Small delay to avoid rate limits
      if (i < limitedModels.length - 1) {
        await delay(2000); // 2 seconds between models
      }

    } catch (error) {
      console.error(chalk.red(`  ❌ Ошибка при обработке "${model.name}":`), error.message);
      errorCount++;
    }
  }

  // Final save
  console.log(chalk.cyan('\n💾 Сохранение результатов...'));
  const updatedArray = Array.from(modelsMap.values());
  await fs.writeFile(MODELS_JSON_PATH, JSON.stringify(updatedArray, null, 2), 'utf8');

  console.log(chalk.green(`\n✅ Готово!`));
  console.log(chalk.green(`   Обновлено: ${updatedCount} моделей`));
  console.log(chalk.yellow(`   Ошибок: ${errorCount} моделей`));
  console.log(chalk.gray(`   Всего обработано: ${limitedModels.length} моделей`));
}

// Parse command line arguments
const mode = process.argv[2] === '--all' ? 'all' : 'none-only';

updateModelDescriptions(mode).catch((error) => {
  console.error(chalk.red('Необработанная ошибка:'), error);
  process.exit(1);
});

