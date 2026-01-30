import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// List of disabled tools
const DISABLED_TOOLS = ['pdfGen'];

/**
 * Load all tools from the tools directory
 * @param {string[]} toolNames - Array of tool names to load
 * @returns {Promise<Object>} Object containing all loaded tools
 */
export async function loadTools(toolNames) {
  const tools = {};
  const toolsDir = join(__dirname, '../../tools');

  for (const toolName of toolNames) {
    if (DISABLED_TOOLS.includes(toolName)) {
      console.log(`Tool "${toolName}" is disabled.`);
      continue;
    }
    try {
      const toolPath = join(toolsDir, toolName, 'index.js');
      const module = await import(`file:///${toolPath.replace(/\\/g, '/')}`);

      // Merge all exports from the tool module
      Object.assign(tools, module);
    } catch (error) {
      console.error(`Error loading tool "${toolName}":`, error.message);
    }
  }

  return tools;
}

/**
 * Get documentation for tools
 * @param {string[]} toolNames - Array of tool names
 * @returns {Promise<string>} Documentation string
 */
export async function getToolDocumentation(toolNames) {
  const docs = [];

  // Map tool names to their documentation
  const toolDocs = {
    weather: `weather.getWeather(city: string): string
  Get current weather information for a specified city.
  Parameters:
    - city: City name (e.g., "Krasnodar", "Moscow", "London")
  Returns: Weather description string with temperature and conditions`,

    calendar: `calendar.viewWeek(): Promise<string>
  View all events for the current week.
  Returns: Formatted list of events grouped by day

calendar.viewDay(date: string): Promise<string>
  View events for a specific day.
  Parameters:
    - date: Date in YYYY-MM-DD format
  Returns: Formatted list of events for that day

calendar.add(daysOfWeek: Array<string>|string, summary: string, startTime: string, duration: string, recurring: boolean): Promise<string>
  Add new event(s) to the calendar.
  Parameters:
    - daysOfWeek: Array of days like ['monday', 'friday'] or single day 'monday'
    - summary: Event title/name
    - startTime: Start time in HH:MM format (e.g., "14:30")
    - duration: Duration in HH:MM format (e.g., "01:30" for 1.5 hours)
    - recurring: true to repeat weekly, false for one-time event
  Returns: Success or error message

calendar.update(eventName: string, daysOfWeek?: Array<string>|null, newSummary?: string|null, startTime?: string|null, duration?: string|null, thisWeekOnly?: boolean): Promise<string>
  Update existing event(s) by name.
  Parameters:
    - eventName: Name of the event to update (required)
    - daysOfWeek: Optional filter for specific days
    - newSummary: New event title (optional)
    - startTime: New start time in HH:MM format (optional)
    - duration: New duration in HH:MM format (optional)
    - thisWeekOnly: true to update only this week's events, false for all future (default: true)
  Returns: Success or error message

calendar.delete(eventName: string, daysOfWeek?: Array<string>|null, thisWeekOnly?: boolean): Promise<string>
  Delete event(s) by name.
  Parameters:
    - eventName: Name of the event to delete (required)
    - daysOfWeek: Filter for specific days (ВАЖНО: если null, удалятся ВСЕ события с таким именем!)
    - thisWeekOnly: true to delete only this week's events, false for all future (default: true)
  Returns: Success or error message
  WARNING: Without daysOfWeek filter, ALL matching events will be deleted!`,

    search: `search.getAnswer(query: string): Promise<string>
  Uses answer endpoint to provide fast, grounded answers. Query should be formulated as a question.
  Shows beautiful streaming UI with progress automatically.
  Parameters:
    - query: Search query or question (required)
  Returns: Short answer

search.webSearch(query: string): Promise<string>
  Perform web search using Exa Deep + Gemini.
  Shows beautiful streaming UI with stages and results automatically.
  Parameters:
    - query: Search query (required)
  Returns: String LLM-formatted search results with analysis.`,

    exa: `exa.getAnswer(query: string): Promise<string>
  Uses Exa Answer API to provide fast, grounded answers. Query should be formulated as a question.
  Shows beautiful streaming UI with progress automatically.
  Parameters:
    - query: Search query or question (required)
  Returns: Short answer

exa.webSearch(query: string): Promise<string>
  Perform web search using Exa Search API (deep search).
  Returns formatted string with search results ready for LLM processing.
  Shows beautiful streaming UI with stages and results automatically.
  Parameters:
    - query: Search query (required)
  Returns: Formatted string with search results (title, URL, content, context for each result)
  Format: Search results are formatted as numbered list with title, URL, content snippet, and context for each result`,

    computerUse: `computerUse.completeTask(taskDescription: string): Promise<string>
  Complete a task using Gemini Computer Use demo via browser automation.
  Opens browser, navigates to Gemini Browser demo, inputs task, and retrieves results.
  Parameters:
    - taskDescription: Super detailed description of the task to complete (required)
  Returns: Task execution results
  Note: Task execution can take up to 5 minutes. Browser will open in visible mode.`,

    memory: `memory.add(text: string, clientId?: string): Promise<string>
  Add text to long-term vector memory for later retrieval.
  Uses Gemini embeddings to store information that persists across conversations.
  Example: await memory.add("User loves pizza with pineapples")
  Parameters:
    - text: Text content to store in memory (required)
    - clientId: Optional client identifier for multi-user scenarios (default: "default")
  Returns: Success message with record ID and total records count

memory.search(query: string, clientId?: string): Promise<string>
  Search in long-term vector memory using semantic similarity.
  Searches across all stored memories using cosine similarity on embeddings.
  Automatically tracks viewed records per agent session to avoid duplicates in context.
  Example: await memory.search("What does the user like?")
  Parameters:
    - query: Search query or question (required)
    - clientId: Optional client identifier (default: "default")
  Returns: Formatted list of matching memories with similarity scores, timestamps, and content
  Note: Only returns results with similarity >= 60%. Searches across all users by default.
  Session tracking: Records shown in previous searches within the same agent session are automatically excluded.`,

    conversations: `conversations.search(query: string): Promise<string>
  Search through conversation transcripts from the last 2 days.
  Uses semantic similarity to find relevant conversation fragments.
  Example: await conversations.search("13 говорит своё мнение по поводу демо нового робота")
  Parameters:
    - query: Search query describing the situation (required)
  Returns: Formatted list of matching transcripts with timestamps, similarity scores, and content
  Note: Transcripts may contain inaccuracies, especially in names. Verify information by context.`,

    messenger: `messenger.search(query: string): Promise<string>
  Exact keyword search across all messages in all chats via Beeper Desktop API.
  Not semantic; uses multiple precise attempts (phrase and token variants) to find matches.
  Parameters:
    - query: Exact keywords or phrase to search (required)
  Returns: Formatted list with timestamp, chat, sender, and message preview
  Requirements: Beeper Desktop running with Desktop API enabled on localhost and a token in env (BEEPER_TOKEN).

messenger.searchChats(query: string): Promise<string>
  Find chats by title using Beeper Desktop API v0 HTTP. Falls back to inferring from message search if needed.
  Parameters:
    - query: Chat title or part of it (required)
  Returns: Formatted list of chats with id, title and network

messenger.getRecentMessagesByChatName(chatName: string, limit?: number): Promise<string>
  Get last N messages from a chat by its title (best match) using v0 HTTP.
  Parameters:
    - chatName: Chat title to match (required)
    - limit: Number of messages to return (default 20, max 100)
  Returns: Formatted list of recent messages`,

    notes: `notes.getAll(limit?: number): Promise<string>
  Get list of recent notes from Notion (titles only).
  Returns most recently edited notes sorted by last edit time.
  Parameters:
    - limit: Maximum number of notes to return (default: 10, max: 100)
  Returns: Formatted numbered list of note titles
  Requirements: NOTION_API_KEY and NOTION_DATABASE_ID in environment variables

notes.get(title: string): Promise<string>
  Get full content of a note by title from Notion.
  Searches for notes matching the title (partial match supported) and returns content of first match.
  Parameters:
    - title: Note title or part of title to search for (required)
  Returns: Note title and full text content extracted from all blocks

notes.add(title: string, content: string): Promise<string>
  Create a new note in Notion database with specified title and content.
  Creates a new page in the database and adds text content as paragraph blocks.
  Parameters:
    - title: Note title (required)
    - content: Note text content (optional, can be empty string)
  Returns: Success message with created note ID
  Note: Content is split into paragraphs by double newlines. Each paragraph becomes a separate block.`,

    presentation: `presentation.execute(prompt: string, filename: string): Promise<string>
  Generate high-quality PowerPoint presentations from text descriptions.
  Creates presentations with any design and content using AI-powered PPTXML generation.
  Parameters:
    - prompt: Detailed description of the presentation: topic, style, content, design, special elements (required)
    - filename: Presentation filename without extension (required)
  Returns: Success message with filename or error message
  Output: Creates .pptx file in ./context/ directory and adds it to context
  Note: Uses Gemini Flash Latest model with specialized PPTXML system prompt for professional presentation generation`,

    simulation: `simulation.run(individualId: number, scenarioDescription: string, initialSystemState: string): Promise<string>
  LLM-based simulation and prediction of human behavior.
  Parameters:
    - individualId: Numeric individual identifier (e.g., 13)
    - scenarioDescription: Detailed scenario description
    - initialSystemState: Initial state text
  Returns: Final model answer as string (also streamed to console while generating)

simulation.get(individualId: number): Promise<string>
  Get last assistant message from individual model.
  Loads the JSON model file and returns the content of the most recent message from role 'model' or 'assistant'.
  Parameters:
    - individualId: Numeric individual identifier (e.g., 13)
  Returns: Last assistant message content as string`,

    os: `os.customScript(prompt: string): Promise<string>
  Execute custom AI-generated Python script on the system.
  Runs any custom Python script generated by AI based on prompt description. Useful for creating utility mini-applications or any scripts.
  Parameters:
    - prompt: Detailed description of the script/application to create (required)
  Returns: Script execution result
  Example: await os.customScript("Полноценное приложение с GUI для конвертации jpeg в png")

os.computerUse(task: string): Promise<string>
  Execute computer control task using specialized AI agent.
  Specialized agent that uses the computer like a human - can perform all actions a human can. Very useful for changing system settings, searching YouTube videos, launching applications, and much more.
  Parameters:
    - task: Detailed description of the task to perform in English (required)
  Returns: Task execution result
  Example: await os.computerUse("Change the theme color to nice green")
  Note: Task description must be in English and very detailed.`,

    ui: `ui.setGlobalInstructions(globalInstructions: string): Promise<string>
  Задать глобальные инструкции для ИИ-модуля переписок в мессенджере.
  Эти инструкции становятся частью постоянного системного промпта (аксиомы) и сохраняются в S3 для использования во всех устройствах и сессиях.
  Parameters:
    - globalInstructions: Глобальные инструкции, которые должны быть частью постоянного системного промпта (required)
  Returns: Подтверждение установки инструкций
  Note: Используется для установки базовых правил поведения ИИ-модуля переписок. Эта LLM имеет "самосознание" и знает, где находится. Инструкции сохраняются в облаке S3 и автоматически загружаются при вызове callUser как systemContext.

ui.requestClarification(question: string): Promise<string>
  Запросить уточнение у пользователя через красивое UI окно (Telos style).
  Открывает браузер (Puppeteer) в режиме киоска с черно-белым контрастным интерфейсом для получения ответа от пользователя.
  Parameters:
    - question: Вопрос к пользователю (required)
  Returns: Ответ пользователя

ui.sendCommand(command: string): Promise<string>
  Отправить команду на действие в мессенджер.
  Разовые инструкции для непосредственного начала разговора или передачи сообщения пользователю.
  Parameters:
    - command: Команда/инструкции для ИИ-модуля переписок (required)
      Рекомендуемый формат: "[Ваш центральный модуль передает инструкции, чтобы вы...]" или похожий формат
  Returns: Подтверждение отправки команды
  Note: Используется для отправки конкретных команд, например для начала диалога или передачи сообщения пользователю.

ui.callUser(initialMessage: string, systemContext?: string): Promise<string>
  Выполнить звонок пользователю через MQTT.
  Отправляет сообщение через MQTT брокер для инициации звонка. Автоматически загружает сохраненные глобальные инструкции как systemContext, если он не передан явно.
  Parameters:
    - initialMessage: Изначальное сообщение системы. Форматировать как инструкцию, например: "Поздоровайтесь с 13, спросите, как дела" (required)
    - systemContext: Контекст системы (опционально). Если не передан, автоматически загружается из сохраненных глобальных инструкций через setGlobalInstructions
  Returns: Подтверждение отправки звонка
  Example: await ui.callUser("Поздоровайтесь с 13, спросите, как дела")
  Example: await ui.callUser("Поздоровайтесь с 13", "Сейчас 31 октября 2025 года, вечер. Вы позвонили 13, чтобы просто поговорить")
  Note: Использует MQTT брокер для отправки сообщения. Если systemContext не передан, автоматически загружается из S3 хранилища (установленные через setGlobalInstructions).

ui.setGlobalRecomendationInstructions(globalRecommendationInstructions: string): Promise<string>
  Задать глобальные инструкции для системы рекомендаций (LLM-based рекомендации видео, фильмов, сериалов и т.п.).
  Эти инструкции сохраняются в S3 в отдельном файле для использования на серверах рекомендаций.
  Parameters:
    - globalRecommendationInstructions: Глобальные инструкции для системы рекомендаций (required)
  Returns: Подтверждение сохранения инструкций
  Note: Инструкции сохраняются только в S3 (ключ: ui/global-recommendation-instructions.json) и локально в fallback режиме. Серверы рекомендаций сами загружают и применяют эти инструкции.`,
    pdfGen: `pdfGen.generateImage(prompt: string, transparent?: boolean): Promise<string>
  Generate high-quality images using Google Gemini AI with optional transparent background.
  Uses gemini-2.0-flash-exp model with image generation capabilities.
  Parameters:
    - prompt: English prompt for image generation (required)
    - transparent: Make background transparent by removing white pixels (default: true)
  Returns: Success message with image path
  Output: Saves PNG image to ./tools/pdfGen/data/images/img{N}.png
  Note: Images are auto-numbered. White background is automatically requested when transparency is enabled, then removed.

pdfGen.generatePage(htmlContent: string, pageIndex: number): Promise<string>
  Generate an HTML page for PDF document.
  Automatically adds DOCTYPE, charset UTF-8, and links to styles.css if not present.
  Parameters:
    - htmlContent: Full or partial HTML content of the page (required)
    - pageIndex: Zero-based page index (0, 1, 2...) (required)
  Returns: Success message with page filename
  Output: Creates page{index}.html in ./tools/pdfGen/data/
  Note: If page with same index exists, it will be overwritten. Can reference images as ./images/img1.png

pdfGen.generateStyle(cssContent: string): Promise<string>
  Create or replace CSS stylesheet for all PDF pages.
  Parameters:
    - cssContent: Full CSS code (required)
  Returns: Success message
  Output: Creates/overwrites styles.css in ./tools/pdfGen/data/
  Note: Automatically linked to all generated pages

pdfGen.buildDoc(): Promise<string>
  Convert all HTML pages to a single PDF document.
  Updates smart page-break rules, sorts page*.html files by index, converts each to PDF using Puppeteer,
  automatically centers sections that start on a new page, then merges into one document.
  Parameters: None
  Returns: Success message with page count
  Output: Creates generatedDocument.pdf in ./tools/pdfGen/data/
  Format: A4 landscape (horizontal orientation), no margins (0mm - full page), background printing enabled
  Note: Pages are ordered by index (page0.html first, then page1.html, etc.). Add visual margins via CSS if needed.

pdfGen.applySmartPageBreaks(): Promise<string>
  Apply smart page-break and vertical centering rules to existing page*.html files without generating PDF.
  Useful when HTML content is already generated and needs better pagination before calling buildDoc.
  Parameters: None
  Returns: Success message with number of files updated.`
  };

  for (const toolName of toolNames) {
    if (DISABLED_TOOLS.includes(toolName)) continue;
    if (toolDocs[toolName]) {
      docs.push(toolDocs[toolName]);
    }
  }

  return docs.join('\n\n');
}

/**
 * Get tool capabilities (high-level descriptions for planner)
 * @param {string[]} toolNames - Array of tool names
 * @returns {string} Capabilities description
 */
export function getToolCapabilities(toolNames) {
  const capabilities = {
    weather: 'Weather Tool: Can retrieve current weather information for any city, including temperature, conditions, and wind speed.',
    calendar: 'Calendar Tool: Full Google Calendar integration - view events (week/day), add new events (one-time or recurring), update existing events by name, and delete events. Supports filtering by days of week and time ranges.',
    search: 'Search Tool: Web search capabilities with two modes - (1) getAnswer: uses Exa Answer API for direct, comprehensive answers to questions (formulate as questions); (2) webSearch: uses Exa Deep Search + TOON format optimization + Gemini Flash Lite Latest for comprehensive web search with analysis and synthesis.',
    exa: 'Exa Tool: Web search capabilities with two modes - (1) getAnswer: uses Exa Answer API for direct, comprehensive answers to questions (formulate as questions); (2) webSearch: uses Exa Search API (deep search) and returns formatted string with search results (title, URL, content, context) ready for LLM processing, without additional LLM layer.',
    computerUse: 'Computer Use Tool: Uses Gemini Browser demo to complete complex tasks through AI-driven browser automation. Can perform web browsing, data extraction, research, and other browser-based tasks. Task execution visible in real browser window.',
    memory: 'Memory Tool: Long-term vector memory with semantic search. Automatically tracks viewed records per session to avoid showing the same information multiple times in the same conversation.',
    conversations: 'Conversations Tool: Search through conversation transcripts from the last 2 days using semantic similarity. Finds relevant conversation fragments based on situation descriptions. Note: transcripts may contain inaccuracies, especially in names.',
    messenger: 'Messenger Tool: Exact, non-semantic search across chats and messages via Beeper Desktop API v0 HTTP. Supports message search, chat discovery, and recent messages by chat.',
    notes: 'Notes Tool: Notion integration for managing personal notes. Can list recent notes (titles only), retrieve full content of specific notes by title, and create new notes with title and content. Searches support partial matching. Requires Notion API key and database ID.',
    presentation: 'Presentation Tool: AI-powered PowerPoint presentation generator. Creates professional presentations from text descriptions using PPTXML markup language. Generates .pptx files with custom designs, layouts, and content. Perfect for educational, business, or creative presentations.',
    simulation: 'Simulation Tool: LLM-based simulation of individuals.',
    os: 'OS Tool: AI-based system control tools. (1) customScript: Execute any custom AI-generated Python script - useful for creating utility mini-applications or any scripts. (2) computerUse: Specialized agent that uses the computer like a human - can perform all actions a human can, very useful for changing system settings, searching YouTube videos, launching applications, and much more. Task descriptions for computerUse must be in English.',
    ui: 'UI Tool: Управление интерфейсом (мессенджер, звонки и т.д.). Позволяет управлять ИИ-модулем переписок в мессенджере: задавать глобальные инструкции (аксиомы) для постоянного системного промпта (сохраняются в S3), отправлять разовые команды для непосредственных действий (начало разговора, передача сообщений пользователю), запрашивать уточнение у пользователя через красивое UI окно (Telos style) и инициировать звонки пользователю через MQTT (callUser автоматически использует сохраненные глобальные инструкции как systemContext). Также позволяет задавать отдельные глобальные инструкции для системы рекомендаций (LLM-based рекомендации видео, фильмов, сериалов), которые сохраняются в S3 для использования на серверах рекомендаций.',
    pdfGen: 'PDF Generator Tool: Complete PDF document creation system with AI-powered image generation. Can generate high-quality images with transparent backgrounds using Gemini, create styled HTML pages, manage CSS stylesheets, and convert everything into professional PDF documents with Puppeteer. Perfect for reports, brochures, catalogs, and any document requiring custom design and AI-generated visuals.'
  };

  const descriptions = toolNames
    .filter(name => capabilities[name] && !DISABLED_TOOLS.includes(name))
    .map(name => `- ${capabilities[name]}`);

  return descriptions.join('\n');
}

