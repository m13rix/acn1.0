# ACN (Agentic Cognitive Network) - Полный технический обзор и документация проекта

**Версия:** 1.0.0  
**Дата создания:** 2025-01-XX  
**Статус:** Активная разработка

---

## Оглавление

1. [Введение и обзор](#введение-и-обзор)
2. [Архитектура фреймворка](#архитектура-фреймворка)
3. [Компоненты ядра](#компоненты-ядра)
4. [Система провайдеров LLM](#система-провайдеров-llm)
5. [Инструменты (Tools)](#инструменты-tools)
6. [Мультиагентная система](#мультиагентная-система)
7. [Система памяти и контекста](#система-памяти-и-контекста)
8. [CLI интерфейс](#cli-интерфейс)
9. [Конфигурация агентов](#конфигурация-агентов)
10. [Технические детали реализации](#технические-детали-реализации)
11. [Безопасность и изоляция](#безопасность-и-изоляция)
12. [Метрики и производительность](#метрики-и-производительность)
13. [Примеры использования](#примеры-использования)
14. [Дорожная карта развития](#дорожная-карта-развития)
15. [Научная ценность и вклад](#научная-ценность-и-вклад)

---

## Введение и обзор

### Что такое ACN?

**ACN (Agentic Cognitive Network)** — это исследовательский мультиагентный фреймворк с иерархической организацией агентов, разработанный на Node.js. Фреймворк реализует архитектуру **Планировщик/Исполнитель** (Planner/Executor), где каждый агент разделён на два компонента: стратегический планировщик и тактический исполнитель.

### Ключевые особенности

1. **Иерархическая архитектура**: Агенты организованы в слои с центральным оркестратором
2. **Разделение планирования и выполнения**: Планировщик создаёт TODO-списки, исполнитель выполняет шаги
3. **Мультиагентность**: Агенты могут вызывать друг друга как инструменты
4. **Модульная система инструментов**: Легко расширяемая библиотека инструментов
5. **Поддержка множества LLM провайдеров**: OpenRouter, Google Gemini, Cerebras
6. **Векторная память**: Долгосрочное хранение контекста с семантическим поиском
7. **Безопасное выполнение кода**: Изоляция через VM2
8. **Потоковая передача ответов**: Реальное время генерации

### Целевые применения

- Исследовательские задачи в области мультиагентных систем
- Сложные многошаговые задачи, требующие планирования
- Персональные ассистенты с долгосрочной памятью
- Автоматизация сложных рабочих процессов
- Эксперименты с иерархической координацией агентов

---

## Архитектура фреймворка

### Общая структура

```
ACN Framework
├── Core Components (Ядро)
│   ├── Agent (Оркестратор)
│   ├── Planner (Планировщик)
│   ├── Executor (Исполнитель)
│   ├── AgentLoader (Загрузчик агентов)
│   └── ToolLoader (Загрузчик инструментов)
│
├── Providers (Провайдеры LLM)
│   ├── BaseProvider (Базовый класс)
│   ├── OpenRouterProvider
│   ├── GeminiProvider
│   └── CerebrasProvider
│
├── Tools (Инструменты)
│   ├── memory (Векторная память)
│   ├── search (Веб-поиск)
│   ├── calendar (Google Calendar)
│   ├── presentation (Генерация презентаций)
│   ├── simulation (Симуляция поведения)
│   ├── os (Управление ОС)
│   ├── ui (Управление интерфейсом)
│   └── ... (другие инструменты)
│
├── Agents (Конфигурации агентов)
│   ├── main (Главный агент)
│   ├── analyzer (Анализатор)
│   ├── action_agent (Агент действий)
│   └── ... (другие агенты)
│
└── Utilities (Утилиты)
    ├── retry (Повторные попытки)
    └── timer (Таймеры)
```

### Поток выполнения задачи

```
1. Пользователь → CLI → Agent.processMessage()
   │
2. Agent → Planner.createPlan()
   │       └─> Создаёт TODO-список
   │
3. Agent → Executor.executeStep() (цикл)
   │       ├─> Получает текущую задачу из TODO
   │       ├─> Генерирует код в <action> тегах
   │       ├─> Выполняет код в VM2
   │       ├─> Получает результат (observation)
   │       └─> Вызывает todo.completeCurrent()
   │
4. Повтор шага 3 до завершения всех задач
   │
5. Agent → Возвращает полный ответ пользователю
```

### Принципы дизайна

1. **Последовательное выполнение**: Задачи выполняются последовательно (кроме последнего слоя)
2. **TODO-ориентированность**: Планировщик создаёт список задач, исполнитель их выполняет
3. **Изоляция выполнения**: Код выполняется в изолированной VM2 среде
4. **Модульность**: Каждый компонент независим и заменяем
5. **Расширяемость**: Легко добавлять новые провайдеры, инструменты и агенты

---

## Компоненты ядра

### 1. Agent (src/core/agent.js)

**Роль**: Центральный оркестратор, координирует работу Planner и Executor.

#### Основные методы:

- `constructor(config)`: Инициализирует агента с конфигурацией
- `initialize()`: Загружает инструменты, настраивает агентов для вызова
- `processMessage(userMessage, onChunk)`: Основной метод обработки сообщений
- `clearHistory()`: Очищает историю разговора
- `getHistory()`: Возвращает историю разговора
- `clearMemorySession()`: Очищает сессию памяти
- `getSessionId()`: Возвращает уникальный ID сессии

#### Ключевые особенности:

- **Уникальный sessionId**: Генерируется для каждого экземпляра агента (`session_${timestamp}_${random}`)
- **Автоматическая передача sessionId**: Инструмент `memory` автоматически получает sessionId текущего агента
- **Мультиагентная делегация**: Поддержка `callAgent()` для вызова других агентов
- **Наследование логгера**: Вложенные агенты наследуют логгер родителя

#### Поток processMessage:

```javascript
1. Planner создаёт TODO-список из userMessage
2. Цикл выполнения (до 200 итераций):
   a. Executor получает текущую задачу
   b. Executor генерирует ответ с возможным <action> кодом
   c. Если есть <action>, код выполняется
   d. Результат добавляется как <obs>
   e. Если все задачи завершены → выход
3. История обновляется
4. Возвращается полный ответ
```

### 2. Planner (src/core/planner.js)

**Роль**: Стратегический планировщик, создаёт TODO-списки для достижения целей.

#### Основные методы:

- `createPlan(userMessage, history, toolCapabilities)`: Создаёт план действий
- `parseTodoList(response)`: Парсит TODO-список из ответа LLM
- `formatTodoList(todos)`: Форматирует TODO-список для отображения

#### Особенности:

- **Мощная модель**: Использует более мощную модель для стратегического мышления
- **Гибкий парсинг**: Поддерживает форматы `- `, `* `, `1. ` для задач
- **Fallback**: Если парсинг не удался, создаётся простая задача "Complete the user request"
- **Контекст инструментов**: Получает описания доступных инструментов и агентов

#### Формат промпта:

```
[System Prompt из файла]

Available Tools:
[Описания инструментов]

Create a TODO list to accomplish the user's goal. 
Format each task on a new line starting with "- ".
```

### 3. Executor (src/core/executor.js)

**Роль**: Тактический исполнитель, выполняет задачи из TODO-списка.

#### Основные методы:

- `executeStep(todos, history, tools, toolDocs, agentDocs, onChunk, iteration)`: Выполняет один шаг
- `executeAction(response, tools, todos)`: Выполняет код из `<action>` тегов
- `setBuiltIns(builtIns)`: Устанавливает встроенные функции (например, callAgent)

#### Особенности:

- **Легкая модель**: Может использовать более быструю/дешёвую модель
- **Автозакрытие тегов**: Автоматически закрывает незакрытые `<action>` теги
- **Изоляция выполнения**: Код выполняется в VM2 с таймаутом 10 секунд
- **Захват console.log**: Вывод `console.log()` становится observation
- **Обязательный вызов todo.completeCurrent()**: Исполнитель должен явно отметить задачу выполненной

#### Формат промпта:

```
[System Prompt из файла]

TODO List:
[✓] 1. Task 1
[ ] 2. Task 2 ← Current

Current Task: Task 2

Available Tools API:
[Документация инструментов]

Available Agents API:
[Документация агентов]

Built-in API:
- todo.completeCurrent(): Mark the current task as complete

Instructions:
- Write JavaScript code inside <action></action> tags
- Use console.log() to output results
- MANDATORY: Call todo.completeCurrent() after completing task
```

#### Выполнение кода:

```javascript
// Код оборачивается в async IIFE
const wrappedCode = `
(async () => {
${code}
})();
`;

// VM2 создаётся с:
- tools (все доступные инструменты)
- builtIns (callAgent и др.)
- todo.completeCurrent() (функция для завершения задачи)
- console.log (захватывает вывод)
```

### 4. AgentLoader (src/core/agentLoader.js)

**Роль**: Загружает конфигурации агентов из директории `agents/`.

#### Функции:

- `loadAgents()`: Загружает все агенты из `agents/`
- `getAgent(agentName)`: Получает конкретного агента по имени

#### Формат конфигурации:

Каждый агент находится в `agents/[name]/` и содержит:
- `config.yaml`: Конфигурация агента
- `planner_system.txt`: Системный промпт планировщика
- `executor_system.txt`: Системный промпт исполнителя

#### Структура config.yaml:

```yaml
name: AgentName
planner:
  provider: openrouter|gemini|cerebras
  model: model-name
  system_prompt_file: planner_system.txt
  temperature: 0.7
  apiKey: optional-custom-key
  customParams: {}
executor:
  provider: openrouter|gemini|cerebras
  model: model-name
  system_prompt_file: executor_system.txt
  temperature: 0.3
  apiKey: optional-custom-key
  customParams: {}
tools:
  - tool1
  - tool2
agents:
  - OtherAgent1
  - OtherAgent2
inter_agent_delay_seconds: 5
```

### 5. ToolLoader (src/core/toolLoader.js)

**Роль**: Загружает инструменты и генерирует документацию.

#### Функции:

- `loadTools(toolNames)`: Загружает инструменты по списку имён
- `getToolDocumentation(toolNames)`: Генерирует документацию для промптов
- `getToolCapabilities(toolNames)`: Генерирует краткие описания для планировщика

#### Механизм загрузки:

```javascript
// Для каждого toolName:
const toolPath = `tools/${toolName}/index.js`;
const module = await import(toolPath);
Object.assign(tools, module); // Мержит все экспорты
```

#### Документация инструментов:

Документация хранится в `toolLoader.js` в объекте `toolDocs`. Каждый инструмент имеет:
- Описание функций
- Параметры
- Возвращаемые значения
- Примеры использования

---

## Система провайдеров LLM

### Архитектура провайдеров

Все провайдеры наследуются от `BaseProvider` и реализуют метод `chat()`.

### BaseProvider (src/providers/base.js)

**Базовый класс** для всех провайдеров.

#### Методы:

- `isRetryableError(error)`: Проверяет, можно ли повторить запрос
- `chat(messages, options)`: Абстрактный метод (должен быть реализован)
- `formatMessages(messages, systemPrompt)`: Форматирует сообщения

### OpenRouterProvider (src/providers/openrouter.js)

**Провайдер для OpenRouter API** (поддерживает множество моделей через единый API).

#### Особенности:

- Использует OpenAI SDK с `baseURL: 'https://openrouter.ai/api/v1'`
- Поддерживает streaming и non-streaming режимы
- Обработка stop sequences в streaming режиме
- Retry логика для 503 ошибок

#### Поддерживаемые модели:

- `anthropic/claude-3.5-sonnet`
- `moonshotai/kimi-k2-thinking`
- И любые другие модели OpenRouter

#### Кастомные параметры:

```javascript
customParams: {
  max_tokens: 4096,
  top_p: 0.9,
  frequency_penalty: 0.1,
  presence_penalty: 0.1,
  extra_body: {} // Дополнительные параметры для конкретной модели
}
```

### GeminiProvider (src/providers/gemini.js)

**Провайдер для Google Gemini API**.

#### Особенности:

- Использует новый `@google/genai` SDK
- Конвертирует сообщения в формат Gemini (`contents` + `systemInstruction`)
- Поддерживает streaming с ручной обработкой stop sequences
- Использует `gemini-embedding-001` для векторных операций (в инструменте memory)

#### Поддерживаемые модели:

- `models/gemini-flash-latest`
- `models/gemini-2.5-pro`
- `gemini-1.5-flash`

#### Кастомные параметры:

```javascript
customParams: {
  maxOutputTokens: 8192,
  topP: 0.95,
  topK: 40,
  candidateCount: 1,
  safetySettings: []
}
```

### CerebrasProvider (src/providers/cerebras.js)

**Провайдер для Cerebras API** (OpenAI-совместимый).

#### Особенности:

- Использует OpenAI SDK с `baseURL: 'https://api.cerebras.ai/v1'`
- Полная совместимость с OpenAI API
- Поддерживает streaming

#### Поддерживаемые модели:

- `qwen-3-235b-a22b-instruct-2507`
- И другие модели Cerebras

### Retry механизм (src/utils/retry.js)

**Обработка временных сбоев** (503, rate limits и т.д.).

#### Параметры:

- `maxRetries`: 3 попытки
- `retryDelay`: 60 секунд между попытками

#### Retryable ошибки:

- HTTP 503 (Service Unavailable)
- Сообщения: "service unavailable", "rate limit exceeded", "too many requests"

---

## Инструменты (Tools)

### Общая архитектура инструментов

Каждый инструмент находится в `tools/[name]/index.js` и экспортирует объект с методами.

### 1. memory (tools/memory/index.js)

**Векторная память с семантическим поиском**.

#### Возможности:

- Добавление текста с автоматической векторизацией (Gemini embeddings)
- Семантический поиск по косинусному сходству
- Мультипользовательская поддержка (clientId)
- Отслеживание просмотренных записей по сессиям
- Хранение в S3 с локальным fallback

#### Методы:

- `memory.add(text, clientId)`: Добавляет текст в память
- `memory.search(query, clientId, sessionId)`: Ищет в памяти
- `memory.clearSession(sessionId)`: Очищает историю просмотров сессии
- `memory.getSessionStats(sessionId)`: Статистика сессии

#### Технические детали:

- **Embedding модель**: `gemini-embedding-001`
- **Task type**: `RETRIEVAL_DOCUMENT` для добавления, `RETRIEVAL_QUERY` для поиска
- **Минимальное сходство**: 0.6 (60%)
- **Максимум результатов**: 5 топ-результатов
- **Хранение**: S3 (`memory/{clientId}.json`) или локально (`data/memory.{clientId}.json`)
- **Индексация**: In-memory VectorIndex с brute-force cosine similarity

#### Структура записи:

```javascript
{
  id: "timestamp",
  text: "cleaned text",
  embedding: [768 numbers],
  timestamp: "ISO string",
  meta: null
}
```

#### Session tracking:

- Каждая сессия агента имеет уникальный `sessionId`
- Просмотренные записи хранятся в `viewedRecordsBySession`
- При поиске автоматически исключаются ранее просмотренные записи
- Можно очистить историю через `clearSession()`

### 2. search (tools/search/index.js)

**Веб-поиск с двумя режимами**.

#### Методы:

- `search.getAnswer(query)`: Прямые ответы через Exa Answer API
- `search.webSearch(query)`: Поиск через Gemini с Google Search

#### Особенности:

- `getAnswer`: Формулировать запрос как вопрос
- `webSearch`: Использует Gemini Flash Lite Latest с Google Search

### 3. calendar (tools/calendar/index.js)

**Интеграция с Google Calendar**.

#### Методы:

- `calendar.viewWeek()`: Просмотр событий недели
- `calendar.viewDay(date)`: Просмотр событий дня (YYYY-MM-DD)
- `calendar.add(daysOfWeek, summary, startTime, duration, recurring)`: Добавление события
- `calendar.update(eventName, ...)`: Обновление события
- `calendar.delete(eventName, daysOfWeek, thisWeekOnly)`: Удаление события

#### Особенности:

- Поддержка повторяющихся событий
- Фильтрация по дням недели
- Обновление/удаление только текущей недели или всех будущих

### 4. presentation (tools/presentation/index.js)

**Генерация PowerPoint презентаций через AI**.

#### Методы:

- `presentation.execute(prompt, filename)`: Создаёт презентацию

#### Процесс:

1. Читает системный промпт из `system_prompt.txt`
2. Генерирует PPTXML через Gemini Flash Latest
3. Конвертирует PPTXML в .pptx через `pptxmlConverter.js`
4. Сохраняет в `./context/`

#### Особенности:

- Использует специализированный системный промпт для PPTXML
- Поддержка любого дизайна и содержания
- Потоковая генерация XML

### 5. simulation (tools/simulation/index.js)

**LLM-based симуляция поведения индивидов**.

#### Методы:

- `simulation.run(individualId, scenarioDescription, initialSystemState)`: Запускает симуляцию
- `simulation.get(individualId)`: Получает последнее сообщение модели индивида

#### Процесс:

1. Загружает системный промпт из `system_prompt.txt`
2. Загружает модель индивида из `models/{individualId}.json`
3. Воспроизводит историю разговора
4. Добавляет новый сценарий
5. Генерирует ответ через Gemini 2.5 Pro

#### Структура модели индивида:

```json
{
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "model", "content": "..." }
  ]
}
```

### 6. os (tools/os/index.js)

**Управление операционной системой через AI**.

#### Методы:

- `os.customScript(prompt)`: Выполняет AI-генерированный Python скрипт
- `os.computerUse(task)`: Управление компьютером через специализированного агента

#### Особенности:

- Вызывает внешние Python скрипты
- Поддержка Windows 11
- `computerUse`: Задача должна быть на английском языке

### 7. ui (tools/ui/index.js)

**Управление интерфейсом (мессенджер, звонки)**.

#### Методы:

- `ui.setGlobalInstructions(instructions)`: Устанавливает постоянные инструкции для UI агентов
- `ui.sendCommand(command)`: Отправляет разовую команду в мессенджер
- `ui.callUser(initialMessage, systemContext)`: Инициирует звонок через MQTT
- `ui.setGlobalRecomendationInstructions(instructions)`: Инструкции для системы рекомендаций

#### Особенности:

- Глобальные инструкции сохраняются в S3 (`ui/global-instructions.json`)
- `callUser` автоматически загружает сохранённые инструкции как `systemContext`
- Использует MQTT брокер для звонков
- Поддержка Railway deployment

### 8. computerUse (tools/computerUse/index.js)

**Автоматизация браузера через Gemini Browser demo**.

#### Методы:

- `computerUse.completeTask(taskDescription)`: Выполняет задачу через браузер

#### Особенности:

- Использует Puppeteer для управления браузером
- Открывает Gemini Browser demo
- Видимый браузер (для отладки)
- Таймаут до 5 минут

### 9. conversations (tools/conversations/index.js)

**Поиск по транскриптам разговоров**.

#### Методы:

- `conversations.search(query)`: Семантический поиск по транскриптам последних 2 дней

#### Особенности:

- Семантический поиск (не точное совпадение)
- Может содержать неточности в именах
- Требует верификации по контексту

### 10. messenger (tools/messenger/index.js)

**Точный поиск по сообщениям через Beeper Desktop API**.

#### Методы:

- `messenger.search(query)`: Точный поиск по всем сообщениям
- `messenger.searchChats(query)`: Поиск чатов по названию
- `messenger.getRecentMessagesByChatName(chatName, limit)`: Последние сообщения чата

#### Особенности:

- Использует Beeper Desktop API v0 HTTP
- Точный поиск (не семантический)
- Требует запущенного Beeper Desktop

### 11. notes (tools/notes/index.js)

**Интеграция с Notion**.

#### Методы:

- `notes.getAll(limit)`: Список последних заметок (только заголовки)
- `notes.get(title)`: Получить полное содержимое заметки
- `notes.add(title, content)`: Создать новую заметку

#### Особенности:

- Требует `NOTION_API_KEY` и `NOTION_DATABASE_ID`
- Поддержка частичного совпадения заголовков
- Контент разбивается на параграфы

### 12. weather (tools/weather/index.js)

**Получение информации о погоде** (мок-данные).

---

## Мультиагентная система

### Архитектура вызова агентов

Агенты могут вызывать друг друга через функцию `callAgent()`.

### Механизм callAgent

#### Реализация:

```javascript
// В Agent.initialize():
this.executor.setBuiltIns({
  callAgent: async (agentName, prompt) => {
    // 1. Разрешение имени агента
    // 2. Проверка разрешений (callableAgents)
    // 3. Задержка (inter_agent_delay_seconds)
    // 4. Создание нового экземпляра Agent
    // 5. Инициализация и выполнение
    // 6. Возврат результата
  }
});
```

#### Правила:

1. **Разрешения**: Только агенты из `config.agents` могут быть вызваны
2. **Разрешение имён**: Поддерживается как имя из `config.name`, так и ключ папки
3. **Задержка**: Вызываемый агент может иметь `inter_agent_delay_seconds` (по умолчанию 5 сек)
4. **Изоляция**: Каждый вызов создаёт новый экземпляр Agent
5. **Наследование логгера**: Вложенные агенты наследуют логгер родителя

#### Пример использования:

```javascript
<action>
const result = await callAgent("Analyzer", `
  Задача: Проанализируй ситуацию с демо робота.
  Контекст: ${context}
`);
console.log(result);
todo.completeCurrent();
</action>
```

### Иерархия агентов в проекте

#### MainAgent (agents/main/)

**Роль**: Главный оркестратор системы Telos.

- **Планировщик**: Gemini Flash Latest
- **Исполнитель**: Gemini Flash Latest
- **Инструменты**: memory
- **Может вызывать**: Analyzer, Simulator, ValuesCheck, Manipulator, ActionAgent
- **Задержка**: 60 секунд

**Специфика**: Реализует Life Script Optimization Cycle (LSOC) из 10 фаз.

#### Analyzer (agents/analyzer/)

**Роль**: Глубокий анализ и выявление корневых причин.

- **Планировщик**: Moonshot Kimi K2 Thinking
- **Исполнитель**: Moonshot Kimi K2 Thinking
- **Инструменты**: memory, search, computerUse
- **Может вызывать**: ExternalDataAnalyzer
- **Задержка**: 60 секунд

#### ActionAgent (agents/action_agent/)

**Роль**: Слой выполнения действий в реальном мире.

- **Планировщик**: Cerebras Qwen 3 235B
- **Исполнитель**: Cerebras Qwen 3 235B
- **Инструменты**: calendar, search, os, notes, ui
- **Может вызывать**: нет

**Особенность**: Единственный агент с доступом к инструментам реального мира (OS, UI, Calendar).

#### Simulator (agents/simulator/)

**Роль**: Предиктивное моделирование поведения.

- Использует инструмент `simulation` для симуляции индивидов

#### ValuesCheck (agents/values_check/)

**Роль**: Этическая оценка сценариев (RWE-ACEV framework).

#### Manipulator (agents/manipulator/)

**Роль**: Дизайн стратегий влияния (Omnipresent Influence Field - OIF).

#### ExternalDataAnalyzer (agents/external_data_analyzer/)

**Роль**: Анализ внешних данных.

#### Academic (agents/academic/)

**Роль**: Академические задачи.

---

## Система памяти и контекста

### Архитектура памяти

#### Хранение:

1. **S3 (основное)**: `memory/{clientId}.json`
2. **Локальное (fallback)**: `data/memory.{clientId}.json`

#### Структура данных:

```json
[
  {
    "id": "timestamp",
    "text": "cleaned text",
    "embedding": [768 numbers],
    "timestamp": "ISO string",
    "meta": null
  }
]
```

### Векторизация

- **Модель**: `gemini-embedding-001`
- **Task type**: 
  - `RETRIEVAL_DOCUMENT` для добавления
  - `RETRIEVAL_QUERY` для поиска
- **Размерность**: 768 (Gemini embeddings)

### Поиск

#### Алгоритм:

1. Векторизация запроса
2. Обнаружение всех clientId (из S3 и in-memory)
3. Поиск по всем клиентам (brute-force cosine similarity)
4. Фильтрация по минимальному сходству (0.6)
5. Исключение просмотренных записей (session tracking)
6. Сортировка и выбор топ-5 результатов

#### Session Tracking:

- Каждая сессия агента имеет уникальный `sessionId`
- Просмотренные записи хранятся в `viewedRecordsBySession`
- При поиске автоматически исключаются
- Можно очистить через `memory.clearSession(sessionId)`

### Контекстное хранилище

#### Директория `context/`:

- Хранит артефакты (презентации, файлы)
- Доступна всем агентам
- Используется инструментом `presentation`

---

## CLI интерфейс

### Компонент CLI (src/cli.js)

**Интерактивный интерфейс командной строки**.

#### Функции:

- `displayWelcome()`: Приветственный экран
- `selectAgent()`: Выбор агента из списка
- `chatLoop()`: Основной цикл чата
- `displayResponse(content)`: Форматирование ответа

#### Команды:

- `exit`: Выход из программы
- `clear`: Очистка истории разговора
- `switch`: Смена агента
- `verbose`: Переключение детального логирования

#### Особенности:

- Цветной вывод (chalk)
- Потоковая передача ответов
- Подсветка тегов (`<action>`, `<obs>`)
- Отображение статуса агента

---

## Конфигурация агентов

### Структура конфигурации

Каждый агент находится в `agents/[name]/`:

```
agents/
├── [agent_name]/
│   ├── config.yaml
│   ├── planner_system.txt
│   └── executor_system.txt
```

### Формат config.yaml

```yaml
name: AgentName                    # Отображаемое имя
planner:
  provider: openrouter|gemini|cerebras
  model: model-name
  system_prompt_file: planner_system.txt
  temperature: 0.7
  apiKey: optional-custom-key     # Опционально
  customParams: {}                 # Опционально
executor:
  provider: openrouter|gemini|cerebras
  model: model-name
  system_prompt_file: executor_system.txt
  temperature: 0.3
  apiKey: optional-custom-key     # Опционально
  customParams: {}                 # Опционально
tools:
  - tool1
  - tool2
agents:                            # Список вызываемых агентов
  - OtherAgent1
  - OtherAgent2
inter_agent_delay_seconds: 5       # Задержка перед вызовом (сек)
```

### Приоритет API ключей

1. `apiKey` в конфигурации агента
2. Переменная окружения `{PROVIDER}_API_KEY`

### Кастомные параметры

#### Для Gemini:

```yaml
customParams:
  maxOutputTokens: 8192
  topP: 0.95
  topK: 40
  candidateCount: 1
  safetySettings: []
```

#### Для OpenRouter:

```yaml
customParams:
  max_tokens: 4096
  top_p: 0.9
  frequency_penalty: 0.1
  presence_penalty: 0.1
  extra_body: {}
```

#### Для Cerebras:

```yaml
customParams:
  max_tokens: 4096
  top_p: 0.9
  frequency_penalty: 0.1
  presence_penalty: 0.1
```

### Системные промпты

#### planner_system.txt:

Содержит инструкции для планировщика:
- Роль агента
- Доступные ресурсы
- Формат вывода (TODO-список)

#### executor_system.txt:

Содержит инструкции для исполнителя:
- Роль агента
- Как выполнять задачи
- Формат кода (`<action>` теги)
- Обязательность `todo.completeCurrent()`

---

## Технические детали реализации

### Выполнение кода (VM2)

#### Изоляция:

```javascript
const vm = new VM({
  timeout: 10000,  // 10 секунд таймаут
  sandbox: {
    ...tools,       // Все инструменты
    ...builtIns,    // callAgent и др.
    todo: {
      completeCurrent: () => { /* ... */ }
    },
    console: {
      log: (...args) => { /* захват вывода */ }
    }
  }
});
```

#### Обёртка кода:

```javascript
const wrappedCode = `
(async () => {
${code}
})();
`;

const result = vm.run(wrappedCode);
if (result && typeof result.then === 'function') {
  await result;  // Ожидание промисов
}
```

### Потоковая передача (Streaming)

#### OpenRouter:

```javascript
const stream = await this.client.chat.completions.create({
  model: this.model,
  messages: formattedMessages,
  stream: true
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) {
    fullContent += content;
    onChunk(content);  // Отправка чанка
  }
}
```

#### Gemini:

```javascript
const stream = await this.client.models.generateContentStream({
  model: this.model,
  contents: geminiMessages.contents,
  config: { ... }
});

for await (const chunk of stream) {
  const text = chunk.text || '';
  if (text) {
    fullContent += text;
    onChunk(text);
  }
}
```

### Обработка stop sequences

#### В streaming режиме:

```javascript
// Клиентская обработка
if (fullContent.includes(stopSeq)) {
  const cutIndex = fullContent.indexOf(stopSeq) + stopSeq.length;
  const toSend = fullContent.substring(sentLength, cutIndex);
  onChunk(toSend);
  stopped = true;
  fullContent = fullContent.substring(0, cutIndex);
}
```

#### В non-streaming режиме:

```javascript
// Серверная обработка
stop: stopSequences  // Передаётся в API
```

### Retry механизм

```javascript
class RetryHandler {
  constructor() {
    this.maxRetries = 3;
    this.retryDelay = 60;  // секунд
  }

  async executeWithRetry(fn, operation) {
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (this.isRetryableError(error) && attempt <= this.maxRetries) {
          await countdown(this.retryDelay, `Retrying ${operation}`);
          continue;
        }
        throw error;
      }
    }
  }
}
```

### Загрузка модулей

#### Динамический импорт:

```javascript
// Загрузка инструмента
const toolPath = `tools/${toolName}/index.js`;
const module = await import(`file:///${toolPath.replace(/\\/g, '/')}`);
Object.assign(tools, module);
```

#### Загрузка агента:

```javascript
// В callAgent:
const { Agent } = await import('./agent.js');
const nested = new Agent(targetConfig);
```

---

## Безопасность и изоляция

### Изоляция выполнения кода

#### VM2:

- **Таймаут**: 10 секунд на выполнение
- **Sandbox**: Только разрешённые объекты
- **Нет доступа к**: `require`, `process`, `fs`, `child_process` и т.д.
- **Доступ к**: Инструментам, builtIns, todo, console.log

### Ограничения вызова агентов

- Только агенты из `config.agents` могут быть вызваны
- Проверка разрешений перед вызовом
- Изоляция экземпляров (каждый вызов = новый Agent)

### API ключи

- Поддержка кастомных ключей на уровне агента
- Fallback на переменные окружения
- Не логируются в консоль

### Хранение данных

- S3 с fallback на локальное хранилище
- Векторные данные не содержат чувствительной информации в открытом виде
- Session tracking изолирован по сессиям

---

## Метрики и производительность

### Ограничения

- **Максимум итераций**: 200 на один запрос
- **Таймаут выполнения кода**: 10 секунд
- **Retry**: 3 попытки с задержкой 60 секунд
- **Задержка между агентами**: Настраиваемая (по умолчанию 5 сек)

### Производительность

#### Планировщик:

- Один вызов LLM для создания TODO-списка
- Зависит от модели и размера контекста

#### Исполнитель:

- Множественные вызовы LLM (по одному на задачу)
- Зависит от количества задач и сложности

#### Инструменты:

- `memory.search`: O(n) где n = количество записей (brute-force)
- `simulation.run`: Зависит от размера модели индивида
- `presentation.execute`: Зависит от сложности презентации

### Оптимизации

- **Session tracking**: Избегает повторного показа одних и тех же записей
- **Кэширование индексов**: In-memory индексы для памяти
- **Потоковая передача**: Улучшает восприятие задержки пользователем

---

## Примеры использования

### Пример 1: Простой запрос

```
Пользователь: "Какая погода в Москве?"

Планировщик создаёт:
- [ ] Получить погоду в Москве

Исполнитель:
<action>
const weather = await weather.getWeather("Moscow");
console.log(weather);
todo.completeCurrent();
</action>

<obs>Погода в Москве: +15°C, облачно</obs>
```

### Пример 2: Мультиагентный запрос

```
Пользователь: "Проанализируй ситуацию с демо робота"

Планировщик создаёт:
- [ ] Получить контекст из памяти
- [ ] Вызвать Analyzer для анализа
- [ ] Представить результаты

Исполнитель:
<action>
const context = await memory.search("демо робота");
console.log(context);
todo.completeCurrent();
</action>

<obs>Найдено 5 записей...</obs>

<action>
const analysis = await callAgent("Analyzer", `
  Задача: Проанализируй ситуацию с демо робота.
  Контекст: ${context}
`);
console.log(analysis);
todo.completeCurrent();
</action>

<obs>Анализ: ...</obs>
```

### Пример 3: Создание презентации

```
Пользователь: "Создай презентацию про мультиагентные системы"

Планировщик создаёт:
- [ ] Создать презентацию про мультиагентные системы

Исполнитель:
<action>
const result = await presentation.execute(
  "Презентация про мультиагентные системы: архитектура, принципы, примеры",
  "multiagent_systems"
);
console.log(result);
todo.completeCurrent();
</action>

<obs>✅ Презентация "multiagent_systems.pptx" успешно создана</obs>
```

---

## Дорожная карта развития

### Реализовано (v1.0.0)

- ✅ Базовая архитектура Planner/Executor
- ✅ Поддержка 3 провайдеров (OpenRouter, Gemini, Cerebras)
- ✅ 12+ инструментов
- ✅ Мультиагентная система
- ✅ Векторная память с S3
- ✅ CLI интерфейс
- ✅ Потоковая передача
- ✅ Retry механизм
- ✅ Session tracking

### Планируется

#### Краткосрочные цели:

- [ ] Система автоматического подбора моделей (раздел 6 из framework.md)
- [ ] Детектор значимых изменений (раздел 5 из framework.md)
- [ ] Улучшенная система метрик
- [ ] Web интерфейс
- [ ] Docker контейнеризация

#### Среднесрочные цели:

- [ ] Параллельное выполнение агентов последнего слоя
- [ ] Общий публичный контекст для агентов
- [ ] Улучшенная система бюджетирования
- [ ] Гранулярный контроль доступа

#### Долгосрочные цели:

- [ ] Полная реализация концепции из framework.md
- [ ] Исследовательские эксперименты
- [ ] Публикация научной работы
- [ ] Оптимизация производительности

---

## Научная ценность и вклад

### Уникальные аспекты ACN

1. **Иерархическая мультиагентная архитектура**: В отличие от плоских систем, ACN использует иерархию с центральным оркестратором
2. **Разделение планирования и выполнения**: Чёткое разделение стратегического и тактического мышления
3. **TODO-ориентированное выполнение**: Механизм TODO-списков для детерминированного выполнения
4. **Session-aware память**: Отслеживание просмотренных записей для избежания дублирования
5. **Гибкая система провайдеров**: Единый интерфейс для множества LLM провайдеров

### Исследовательские вопросы

1. **Эффективность иерархии vs плоской архитектуры**: Как иерархия влияет на качество и стоимость?
2. **Планировщик+Исполнитель vs монолитный агент**: Преимущества разделения ролей
3. **Автоматический подбор моделей**: Влияние на качество и стоимость
4. **Session tracking**: Влияние на качество контекста и избежание дублирования

### Метрики для исследования

- **Task Success Rate**: Процент успешно выполненных задач
- **Latency**: Время до решения (вторичный показатель)
- **Cost**: Стоимость в USD на задачу
- **Reliability**: Устойчивость к сбоям
- **User Satisfaction**: Удовлетворённость пользователя

### Потенциальные публикации

1. **Архитектурная работа**: Описание иерархической мультиагентной системы
2. **Экспериментальная работа**: Сравнение иерархии vs плоской архитектуры
3. **Системная работа**: Описание системы автоматического подбора моделей

---

## Заключение

ACN представляет собой полнофункциональный мультиагентный фреймворк с уникальной архитектурой Planner/Executor и иерархической организацией агентов. Фреймворк реализует большинство концепций из концептуальной спецификации и готов к использованию как для практических задач, так и для исследовательской работы.

### Ключевые достижения:

- ✅ Полная реализация архитектуры Planner/Executor
- ✅ Мультиагентная система с делегацией
- ✅ Векторная память с session tracking
- ✅ Поддержка множества LLM провайдеров
- ✅ Безопасное выполнение кода
- ✅ Расширяемая система инструментов

### Следующие шаги:

1. Реализация системы автоматического подбора моделей
2. Добавление детектора значимых изменений
3. Проведение экспериментов для научной работы
4. Оптимизация производительности и стоимости

---

**Конец документа**

