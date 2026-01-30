import { GoogleGenAI } from '@google/genai';
import { readdir, readFile, stat } from 'fs/promises';
import { join, basename, extname, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '../..');

// Поддерживаемые расширения файлов для File Search
const SUPPORTED_EXTENSIONS = [
  '.txt', '.md', '.pdf', '.html', '.css', '.js', '.ts', '.jsx', '.tsx',
  '.json', '.xml', '.csv', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.r', '.sql',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.sh', '.bat',
  '.ps1', '.dockerfile', '.gitignore', '.env'
];

/**
 * Менеджер Gemini File Search
 * Загружает файлы из ./context в File Search Store
 */
export class GeminiFileSearchManager {
  constructor(apiKey, logger = null) {
    this.apiKey = apiKey;
    this.logger = logger;
    this.client = new GoogleGenAI({ apiKey });
    this.fileSearchStore = null;
    this.fileSearchStoreName = null;
    this.initialized = false;
    this.uploadedFiles = [];
  }

  log(message, type = 'info') {
    if (this.logger) {
      this.logger(`[GeminiFileSearch] ${message}`, type);
    } else {
      console.log(`[GeminiFileSearch] ${message}`);
    }
  }

  /**
   * Инициализирует File Search Store и загружает файлы из ./context
   * @param {Object} config - Конфигурация
   * @returns {Promise<string|null>} - Имя созданного store или null
   */
  async initialize(config = {}) {
    if (this.initialized) {
      this.log('Already initialized, skipping');
      return this.fileSearchStoreName;
    }

    const contextPath = config.contextPath || join(projectRoot, 'context');
    const storeName = config.storeName || `acn-context-${Date.now()}`;

    this.log(`Initializing File Search...`);
    this.log(`Context path: ${contextPath}`);
    this.log(`Store name: ${storeName}`);

    try {
      // Проверяем, есть ли файлы в папке context
      const files = await this.getFilesFromDirectory(contextPath);
      
      if (files.length === 0) {
        this.log('No files found in context directory, skipping File Search initialization');
        return null;
      }

      this.log(`Found ${files.length} file(s) in context directory`);
      files.forEach(f => this.log(`  - ${f}`));

      // Создаём File Search Store
      this.log(`Creating File Search Store: ${storeName}`);
      this.fileSearchStore = await this.client.fileSearchStores.create({
        config: { displayName: storeName }
      });
      this.fileSearchStoreName = this.fileSearchStore.name;
      this.log(`File Search Store created: ${this.fileSearchStoreName}`);

      // Загружаем файлы
      for (const filePath of files) {
        await this.uploadFile(filePath);
      }

      this.initialized = true;
      this.log(`File Search initialization complete. Store: ${this.fileSearchStoreName}`);
      
      return this.fileSearchStoreName;
    } catch (error) {
      this.log(`Error initializing File Search: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Получает список файлов из директории (рекурсивно)
   * @param {string} dirPath - Путь к директории
   * @returns {Promise<string[]>} - Массив путей к файлам
   */
  async getFilesFromDirectory(dirPath) {
    const files = [];

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          // Рекурсивно обрабатываем поддиректории
          const subFiles = await this.getFilesFromDirectory(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          
          // Проверяем, поддерживается ли расширение
          if (SUPPORTED_EXTENSIONS.includes(ext) || ext === '') {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log(`Error reading directory ${dirPath}: ${error.message}`, 'error');
      }
    }

    return files;
  }

  /**
   * Загружает файл в File Search Store
   * @param {string} filePath - Путь к файлу
   */
  async uploadFile(filePath) {
    const fileName = basename(filePath);
    
    try {
      this.log(`Uploading file: ${fileName}`);

      // Загружаем и импортируем файл в File Search Store
      let operation = await this.client.fileSearchStores.uploadToFileSearchStore({
        file: filePath,
        fileSearchStoreName: this.fileSearchStoreName,
        config: {
          displayName: fileName,
          // Настройка чанкинга (опционально)
          chunkingConfig: {
            whiteSpaceConfig: {
              maxTokensPerChunk: 512,
              maxOverlapTokens: 50
            }
          }
        }
      });

      // Ждём завершения импорта
      let waitTime = 0;
      const maxWait = 120000; // 2 минуты макс
      
      while (!operation.done && waitTime < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        waitTime += 2000;
        operation = await this.client.operations.get({ operation });
      }

      if (operation.done) {
        this.uploadedFiles.push({ path: filePath, name: fileName });
        this.log(`Successfully uploaded: ${fileName}`);
      } else {
        this.log(`Timeout waiting for file upload: ${fileName}`, 'warning');
      }
    } catch (error) {
      this.log(`Error uploading file ${fileName}: ${error.message}`, 'error');
      // Продолжаем с другими файлами
    }
  }

  /**
   * Возвращает имя File Search Store
   * @returns {string|null}
   */
  getStoreName() {
    return this.fileSearchStoreName;
  }

  /**
   * Возвращает список загруженных файлов
   * @returns {Array}
   */
  getUploadedFiles() {
    return this.uploadedFiles;
  }

  /**
   * Проверяет, инициализирован ли менеджер
   * @returns {boolean}
   */
  isInitialized() {
    return this.initialized && this.fileSearchStoreName !== null;
  }

  /**
   * Создаёт конфигурацию tools для передачи в generateContent
   * @returns {Object|null}
   */
  getToolConfig() {
    if (!this.isInitialized()) {
      return null;
    }

    return {
      fileSearch: {
        fileSearchStoreNames: [this.fileSearchStoreName]
      }
    };
  }
}

/**
 * Создаёт и инициализирует менеджер File Search
 * @param {string} apiKey - API ключ Gemini
 * @param {Object} config - Конфигурация
 * @param {Function} logger - Логгер
 * @returns {Promise<GeminiFileSearchManager|null>}
 */
export async function createGeminiFileSearchManager(apiKey, config = {}, logger = null) {
  const log = (msg, type = 'info') => {
    if (logger) logger(msg, type);
    else console.log(msg);
  };

  if (!apiKey) {
    log('[GeminiFileSearch] No API key provided, skipping', 'warning');
    return null;
  }

  log('[GeminiFileSearch] Creating manager...');
  const manager = new GeminiFileSearchManager(apiKey, logger);
  
  try {
    await manager.initialize(config);
    
    if (manager.isInitialized()) {
      log(`[GeminiFileSearch] Manager initialized successfully`);
      return manager;
    } else {
      log('[GeminiFileSearch] Manager not initialized (no files found)', 'warning');
      return null;
    }
  } catch (error) {
    log(`[GeminiFileSearch] Failed to initialize: ${error.message}`, 'error');
    log(`[GeminiFileSearch] Stack: ${error.stack}`, 'error');
    return null;
  }
}

