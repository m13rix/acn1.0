// UI tool - для управления интерфейсом (мессенджер, звонки и т.д.)
import axios from 'axios';
import mqtt from 'mqtt';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.UI_API_BASE_URL || 'https://telos-text.up.railway.app';
const DEFAULT_CHAT = "13";

// S3 конфигурация точь-в-точь как в memory/index.js
const bucketName = process.env.S3_BUCKET_NAME;
const s3Client = bucketName ? new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
}) : null;

function toBuffer(streamOrBuffer) {
    if (Buffer.isBuffer(streamOrBuffer)) return Promise.resolve(streamOrBuffer);
    if (streamOrBuffer instanceof Readable) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            streamOrBuffer.on('data', (d) => chunks.push(d));
            streamOrBuffer.on('end', () => resolve(Buffer.concat(chunks)));
            streamOrBuffer.on('error', reject);
        });
    }
    return Promise.resolve(Buffer.from(String(streamOrBuffer || '')));
}

// S3 ключ для глобальных инструкций
const INSTRUCTIONS_S3_KEY = 'ui/global-instructions.json';
const RECOMMENDATION_INSTRUCTIONS_S3_KEY = 'ui/global-recommendation-instructions.json';
const DATA_DIR = path.join(__dirname, '../../data');
const INSTRUCTIONS_LOCAL_PATH = path.join(DATA_DIR, 'global-instructions.json');
const RECOMMENDATION_INSTRUCTIONS_LOCAL_PATH = path.join(DATA_DIR, 'global-recommendation-instructions.json');

async function ensureDataDir() {
    try { 
        await fs.access(DATA_DIR); 
    } catch { 
        await fs.mkdir(DATA_DIR, { recursive: true }); 
    }
}

// Загрузка глобальных инструкций из S3 или локального файла
async function loadGlobalInstructions() {
    if (!bucketName || !s3Client) {
        // Fallback на локальный файл
        try {
            const txt = await fs.readFile(INSTRUCTIONS_LOCAL_PATH, 'utf-8');
            const data = JSON.parse(txt);
            return data.instructions || '';
        } catch {
            return '';
        }
    }

    // Try S3 first
    try {
        const head = new HeadObjectCommand({ Bucket: bucketName, Key: INSTRUCTIONS_S3_KEY });
        await s3Client.send(head);
        const get = new GetObjectCommand({ Bucket: bucketName, Key: INSTRUCTIONS_S3_KEY });
        const res = await s3Client.send(get);
        const buf = await toBuffer(res.Body);
        const data = JSON.parse(buf.toString('utf-8'));
        return data.instructions || '';
    } catch {
        // Fallback local
        try {
            await ensureDataDir();
            const txt = await fs.readFile(INSTRUCTIONS_LOCAL_PATH, 'utf-8');
            const data = JSON.parse(txt);
            return data.instructions || '';
        } catch {
            return '';
        }
    }
}

// Сохранение глобальных инструкций в S3 или локальный файл
async function saveGlobalInstructions(instructions) {
    const data = { instructions, updatedAt: new Date().toISOString() };
    const body = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');

    if (bucketName && s3Client) {
        try {
            const put = new PutObjectCommand({ 
                Bucket: bucketName, 
                Key: INSTRUCTIONS_S3_KEY, 
                Body: body, 
                ContentType: 'application/json', 
                CacheControl: 'no-cache' 
            });
            await s3Client.send(put);
            return;
        } catch (e) {
            console.log(chalk.yellow('⚠️  Ошибка сохранения в S3, используем локальный fallback'));
        }
    }

    // Fallback local
    await ensureDataDir();
    await fs.writeFile(INSTRUCTIONS_LOCAL_PATH, body);
}

// Сохранение глобальных инструкций для рекомендаций в S3 или локальный файл
async function saveGlobalRecommendationInstructions(instructions) {
    const data = { instructions, updatedAt: new Date().toISOString() };
    const body = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');

    if (bucketName && s3Client) {
        try {
            const put = new PutObjectCommand({ 
                Bucket: bucketName, 
                Key: RECOMMENDATION_INSTRUCTIONS_S3_KEY, 
                Body: body, 
                ContentType: 'application/json', 
                CacheControl: 'no-cache' 
            });
            await s3Client.send(put);
            return;
        } catch (e) {
            console.log(chalk.yellow('⚠️  Ошибка сохранения в S3, используем локальный fallback'));
        }
    }

    // Fallback local
    await ensureDataDir();
    await fs.writeFile(RECOMMENDATION_INSTRUCTIONS_LOCAL_PATH, body);
}

export const ui = {
  /**
   * Задать глобальные инструкции для ИИ-модуля переписок
   * Эти инструкции становятся частью постоянного системного промпта и сохраняются в S3
   * @param {string} globalInstructions - Глобальные инструкции (аксиомы)
   * @returns {Promise<string>} Подтверждение установки
   */
  setGlobalInstructions: async (globalInstructions) => {
    console.log('\n=== UI.setGlobalInstructions ===');
    console.log('📋 Глобальные инструкции:');
    console.log(globalInstructions);
    console.log('========================================\n');

    if (typeof globalInstructions !== 'string') {
      return '❌ Ошибка: параметр globalInstructions должен быть строкой';
    }

    try {
      // Сохраняем инструкции в S3
      await saveGlobalInstructions(globalInstructions);
      console.log(chalk.green('✅ Инструкции сохранены в S3/локальное хранилище'));

      // Также отправляем на API (для обратной совместимости)
      const url = `${BASE_URL}/api/instructions/permanent`;
      const { data } = await axios.post(url, { instructions: globalInstructions }, {
        headers: { 'Content-Type': 'application/json' }
      });

      if (data?.success) {
        return '✅ Постоянные инструкции успешно обновлены и сохранены в облаке';
      }

      // Сервер вернул success: false, но инструкции сохранены в S3
      return `⚠️  Инструкции сохранены в облаке, но ошибка API: ${data?.error || 'Неизвестная ошибка'}`;
    } catch (error) {
      // Пытаемся сохранить хотя бы в S3
      try {
        await saveGlobalInstructions(globalInstructions);
        console.log(chalk.yellow('⚠️  Ошибка API, но инструкции сохранены в S3'));
        const message = error?.response?.data?.error || error?.message || 'Неизвестная ошибка';
        const status = error?.response?.status;
        return `⚠️  Инструкции сохранены в облаке, но ошибка запроса API${status ? ` (${status})` : ''}: ${message}`;
      } catch (s3Error) {
        const message = error?.response?.data?.error || error?.message || 'Неизвестная ошибка';
        const status = error?.response?.status;
        return `❌ Ошибка сохранения${status ? ` (${status})` : ''}: ${message}`;
      }
    }
  },

  /**
   * Запросить уточнение у пользователя через консоль (ЗАГЛУШКА - puppeteer удален)
   * @param {string} question - Вопрос к пользователю
   * @returns {Promise<string>} Ответ пользователя
   */
  requestClarification: async (question) => {
    console.log('\n' + '='.repeat(40));
    console.log(chalk.bold.yellow('❓ ВХОДЯЩИЙ ЗАПРОС УТОЧНЕНИЯ'));
    console.log('='.repeat(40));
    console.log(`${chalk.cyan('Вопрос:')} ${question}`);
    console.log('='.repeat(40));

    if (!question) {
      throw new Error('Question is required');
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question(chalk.green('\nВаш ответ: '), (answer) => {
        rl.close();
        console.log(`${chalk.green('✓')} Ответ получен: ${answer}`);
        resolve(answer);
      });
    });
  },

  /**
   * Отправить команду на действие в мессенджер
   * Разовые инструкции для непосредственного начала разговора или передачи сообщения пользователю
   * @param {string} command - Команда/инструкции для ИИ-модуля переписок
   * @returns {Promise<string>} Подтверждение отправки
   */
  sendCommand: async (command) => {
    console.log('\n=== UI.sendCommand ===');
    console.log('💬 Команда/Инструкции:');
    console.log(command);
    console.log('============================\n');

    // Поддержка двух форматов: строка (инструкция) или объект { chatName, instruction }
    let chatName;
    let instruction;

    if (typeof command === 'string') {
      instruction = command;
      chatName = DEFAULT_CHAT;
      if (!chatName) {
        return '❌ Ошибка: для строкового параметра требуется задать UI_DEFAULT_CHAT в env или передавать объект { chatName, instruction }';
      }
    } else if (command && typeof command === 'object') {
      chatName = command.chatName;
      instruction = command.instruction;
    }

    if (typeof chatName !== 'string' || !chatName.trim()) {
      return '❌ Ошибка: поле "chatName" обязательно и должно быть непустой строкой';
    }
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return '❌ Ошибка: поле "instruction" обязательно и должно быть непустой строкой';
    }

    try {
      const url = `${BASE_URL}/api/instructions/chat`;
      const { data } = await axios.post(url, { chatName, instruction }, {
        headers: { 'Content-Type': 'application/json' }
      });

      if (data?.success) {
        return data?.message || `✅ Инструкция успешно добавлена для чата "${chatName}"`;
      }

      return `❌ Ошибка сервера: ${data?.error || 'Неизвестная ошибка'}`;
    } catch (error) {
      const message = error?.response?.data?.error || error?.message || 'Неизвестная ошибка';
      const status = error?.response?.status;
      return `❌ Ошибка запроса${status ? ` (${status})` : ''}: ${message}`;
    }
  },

  /**
   * Выполнить звонок пользователю через MQTT
   * Отправляет сообщение через MQTT брокер для инициации звонка
   * @param {string} initialMessage - Изначальное сообщение системы. Форматировать как инструкцию, например: "Поздоровайтесь с 13, спросите, как дела"
   * @param {string} systemContext - Контекст системы (опционально, по умолчанию загружается из сохраненных глобальных инструкций)
   * @returns {Promise<string>} Подтверждение отправки звонка
   */
  callUser: async (initialMessage, systemContext = null) => {
    console.log('\n=== UI.callUser ===');
    console.log('📞 Инициируем звонок...');
    console.log(chalk.gray(`Initial Message: ${initialMessage}`));

    if (typeof initialMessage !== 'string' || !initialMessage.trim()) {
      return '❌ Ошибка: параметр initialMessage обязателен и должен быть непустой строкой';
    }

    // Загружаем сохраненные инструкции как systemContext, если не передан явно
    let finalSystemContext = systemContext;
    if (!finalSystemContext) {
      try {
        finalSystemContext = await loadGlobalInstructions();
        if (finalSystemContext) {
          console.log(chalk.gray(`Загружены сохраненные инструкции как systemContext (${finalSystemContext.length} символов)`));
        }
      } catch (error) {
        console.log(chalk.yellow('⚠️  Не удалось загрузить сохраненные инструкции, используем пустой systemContext'));
        finalSystemContext = '';
      }
    }

    console.log(chalk.gray(`System Context: ${finalSystemContext || '(пусто)'}`));
    console.log('========================================\n');

    return new Promise((resolve) => {
      const brokerUrl = process.env.MQTT_URL ?? 'wss://telos-mqtt-broker.up.railway.app';
      const topic = 'call';

      const options = {
        clientId: process.env.MQTT_CLIENT_ID ?? `json-publisher-${Math.random().toString(16).slice(2)}`,
        clean: true,
        reconnectPeriod: 2000,
        keepalive: 60,
        connectTimeout: 30_000
      };

      if (process.env.MQTT_USERNAME) {
        options.username = process.env.MQTT_USERNAME;
      }

      if (process.env.MQTT_PASSWORD) {
        options.password = process.env.MQTT_PASSWORD;
      }

      const client = mqtt.connect(brokerUrl, options);

      const log = (message, meta) => {
        const timestamp = new Date().toISOString();
        const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
        console.log(chalk.gray(`[${timestamp}] [MQTT] ${message}${suffix}`));
      };

      let resolved = false;

      const publishMessage = () => {
        const payload = {
          initialMessage: initialMessage.trim(),
          systemContext: finalSystemContext || ''
        };

        const json = JSON.stringify(payload);
        client.publish(topic, json, { qos: 1, retain: false }, (error) => {
          if (error) {
            log('Ошибка публикации сообщения', { error: error.message });
            client.end(true, () => {
              log('Клиент остановлен из-за ошибки');
              if (!resolved) {
                resolved = true;
                resolve(`❌ Ошибка публикации MQTT сообщения: ${error.message}`);
              }
            });
            return;
          }
          log('Сообщение опубликовано', { topic, payload });
          client.end(true, () => {
            log('Клиент остановлен');
            if (!resolved) {
              resolved = true;
              resolve('✅ Звонок успешно инициирован через MQTT');
            }
          });
        });
      };

      client.on('connect', () => {
        log('Соединение с брокером установлено', { brokerUrl });
        publishMessage();
      });

      client.on('reconnect', () => {
        log('Повторная попытка подключения к брокеру');
      });

      client.on('close', () => {
        log('Соединение закрыто');
      });

      client.on('error', (error) => {
        log('Ошибка клиента', { error: error.message });
        if (!resolved) {
          resolved = true;
          client.end(true);
          resolve(`❌ Ошибка MQTT клиента: ${error.message}`);
        }
      });

      // Таймаут на случай если что-то пойдет не так
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.end(true);
          resolve('❌ Таймаут при отправке MQTT сообщения');
        }
      }, 60000); // 60 секунд
    });
  },

  /**
   * Задать глобальные инструкции для системы рекомендаций (LLM-based рекомендации видео, фильмов, сериалов и т.п.)
   * Эти инструкции сохраняются в S3 в отдельном файле для использования на серверах рекомендаций
   * @param {string} globalRecommendationInstructions - Глобальные инструкции для системы рекомендаций
   * @returns {Promise<string>} Подтверждение установки
   */
  setGlobalRecomendationInstructions: async (globalRecommendationInstructions) => {
    console.log('\n=== UI.setGlobalRecomendationInstructions ===');
    console.log('📋 Глобальные инструкции для рекомендаций:');
    console.log(globalRecommendationInstructions);
    console.log('========================================\n');

    if (typeof globalRecommendationInstructions !== 'string') {
      return '❌ Ошибка: параметр globalRecommendationInstructions должен быть строкой';
    }

    try {
      // Сохраняем инструкции в S3
      await saveGlobalRecommendationInstructions(globalRecommendationInstructions);
      console.log(chalk.green('✅ Инструкции для рекомендаций сохранены в S3/локальное хранилище'));
      return '✅ Глобальные инструкции для системы рекомендаций успешно сохранены в облаке';
    } catch (error) {
      const message = error?.message || 'Неизвестная ошибка';
      return `❌ Ошибка сохранения: ${message}`;
    }
  }
};

