/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ШАБЛОН КАСТОМНОГО АГЕНТА ДЛЯ ACN FRAMEWORK
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Этот файл является шаблоном для создания кастомных агентов.
 * Скопируйте его в папку вашего агента и модифицируйте под свои нужды.
 * 
 * СТРУКТУРА ФАЙЛОВ:
 * agents/
 *   my_custom_agent/
 *     config.yaml      - Конфигурация агента
 *     index.js         - Главный файл (этот шаблон)
 *     helpers.js       - Вспомогательные функции (опционально)
 *     prompts/         - Промпты для LLM (опционально)
 *     data/            - Данные агента (опционально)
 * 
 * МИНИМАЛЬНЫЕ ТРЕБОВАНИЯ:
 * - Экспортировать async function process(input, context)
 * - Возвращать строку
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════
// МЕТАДАННЫЕ (опционально)
// ═══════════════════════════════════════════════════════════════════════════
export const metadata = {
  name: 'MyCustomAgent',
  version: '1.0.0',
  author: 'Your Name',
  description: 'Описание вашего агента'
};

// ═══════════════════════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ (опционально)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Вызывается один раз при первом использовании агента
 * 
 * @param {Object} context - Контекст инициализации
 * @param {Function} context.log - Функция логирования
 * @param {Object} context.config - Конфигурация из config.yaml
 * @param {Object} context.utils - Утилиты (chalk, sleep, formatDate)
 * @param {string} context.agentDir - Путь к директории агента
 */
export async function initialize(context) {
  const { log, config, utils, agentDir } = context;
  
  log(`${utils.chalk.blue('🔧')} Initializing agent...`, 'system');
  
  // Пример: загрузка ресурсов
  // const data = await loadData(agentDir + '/data/config.json');
  
  // Пример: проверка окружения
  // if (!process.env.MY_API_KEY) {
  //   throw new Error('MY_API_KEY environment variable is required');
  // }
  
  log(`${utils.chalk.green('✓')} Agent initialized!`, 'system');
}

// ═══════════════════════════════════════════════════════════════════════════
// ОСНОВНАЯ ФУНКЦИЯ ОБРАБОТКИ (ОБЯЗАТЕЛЬНАЯ)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Обрабатывает входящее сообщение и возвращает ответ
 * 
 * @param {string} input - Текстовый ввод от пользователя
 * @param {Object} context - Контекст выполнения
 * 
 * ДОСТУПНЫЕ СВОЙСТВА КОНТЕКСТА:
 * 
 * @param {string} context.agentName - Имя агента
 * @param {string} context.sessionId - Уникальный ID сессии
 * @param {string} context.agentDir - Путь к директории агента
 * @param {string} context.userMessage - Исходное сообщение пользователя
 * 
 * @param {Function} context.log - Логирование: log(message, type)
 *   type: 'info' | 'system' | 'error' | 'warning' | 'custom'
 * 
 * @param {Function} context.emit - События для UI: emit(event, data)
 *   events: 'thinking:start', 'thinking:end', 'action:start', 'action:end', 'error'
 * 
 * @param {Function} context.onChunk - Стриминг: onChunk(text)
 *   Для посимвольного вывода ответа
 * 
 * @param {Array} context.history - История разговора
 *   [{role: 'user'|'assistant', content: string}, ...]
 * 
 * @param {Object} context.config - Конфигурация из config.yaml
 * 
 * @param {Function} context.callAgent - Вызов другого агента
 *   await callAgent(agentName, prompt) => string
 * 
 * @param {Array} context.attachments - Вложения
 *   [{name: string, type: string, content: Buffer|string}, ...]
 * 
 * @param {Object} context.utils - Утилиты
 *   - chalk: цветной вывод
 *   - sleep(ms): задержка
 *   - formatDate(date): форматирование даты
 * 
 * @returns {Promise<string>} - Текстовый ответ агента
 */
export async function process(input, context) {
  const { 
    log, 
    emit, 
    onChunk, 
    history, 
    config, 
    callAgent,
    utils,
    attachments,
    agentDir,
    sessionId
  } = context;
  
  // ─────────────────────────────────────────────────────────────────────────
  // ПРИМЕР: Логирование
  // ─────────────────────────────────────────────────────────────────────────
  log(`${utils.chalk.cyan('📩')} Input: ${input}`, 'custom');
  log(`${utils.chalk.gray('Session:')} ${sessionId}`, 'custom');
  
  // ─────────────────────────────────────────────────────────────────────────
  // ПРИМЕР: События для UI
  // ─────────────────────────────────────────────────────────────────────────
  emit('thinking:start', { task: 'Processing input' });
  
  // ─────────────────────────────────────────────────────────────────────────
  // ПРИМЕР: Использование конфигурации
  // ─────────────────────────────────────────────────────────────────────────
  const maxLength = config.max_response_length || 1000;
  
  // ─────────────────────────────────────────────────────────────────────────
  // ПРИМЕР: Стриминг ответа
  // ─────────────────────────────────────────────────────────────────────────
  // const streamText = async (text) => {
  //   for (const char of text) {
  //     onChunk(char);
  //     await utils.sleep(10);
  //   }
  // };
  // await streamText('Streaming response...');
  
  // ─────────────────────────────────────────────────────────────────────────
  // ПРИМЕР: Вызов другого агента
  // ─────────────────────────────────────────────────────────────────────────
  // try {
  //   const analyzerResponse = await callAgent('Analyzer', 'Проанализируй данные');
  //   log(`Analyzer response: ${analyzerResponse}`, 'custom');
  // } catch (error) {
  //   log(`Error calling agent: ${error.message}`, 'error');
  // }
  
  // ─────────────────────────────────────────────────────────────────────────
  // ПРИМЕР: Работа с историей
  // ─────────────────────────────────────────────────────────────────────────
  const previousMessages = history.length;
  log(`Previous messages: ${previousMessages}`, 'custom');
  
  // ─────────────────────────────────────────────────────────────────────────
  // ПРИМЕР: Работа с вложениями
  // ─────────────────────────────────────────────────────────────────────────
  if (attachments && attachments.length > 0) {
    log(`Attachments: ${attachments.map(a => a.name).join(', ')}`, 'custom');
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // ВАША ЛОГИКА ЗДЕСЬ
  // ─────────────────────────────────────────────────────────────────────────
  
  // Пример: простой эхо-ответ
  const response = `Вы сказали: "${input}"`;
  
  // ─────────────────────────────────────────────────────────────────────────
  // Завершение
  // ─────────────────────────────────────────────────────────────────────────
  emit('action:end', { output: 'Processing complete' });
  log(`${utils.chalk.green('📤')} Response ready`, 'custom');
  
  // ВАЖНО: Всегда возвращаем строку!
  return response;
}

// ═══════════════════════════════════════════════════════════════════════════
// ОЧИСТКА РЕСУРСОВ (опционально)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Вызывается при завершении работы агента
 */
export async function cleanup() {
  // Закрытие соединений, освобождение ресурсов
  console.log('Cleanup completed');
}

// ═══════════════════════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════════════════════════
// Можно добавлять любые вспомогательные функции
// или выносить их в отдельные файлы и импортировать

function formatResponse(data) {
  return JSON.stringify(data, null, 2);
}

async function fetchData(url) {
  const response = await fetch(url);
  return response.json();
}

