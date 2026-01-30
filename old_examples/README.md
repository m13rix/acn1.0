# ACN Multi-Agent Framework

Мощный фреймворк с архитектурой Планировщик/Исполнитель для создания интеллектуальных агентов на Node.js.

## Особенности

- **Архитектура Планировщик/Исполнитель**: Разделение стратегического планирования и выполнения
- **Выполнение JavaScript кода**: Агенты пишут полноценный код для максимальной гибкости
- **Модульная система инструментов**: Легко добавляйте новые инструменты как обычные API
- **Поддержка нескольких провайдеров**: OpenRouter, Google Gemini и Cerebras из коробки
- **Потоковая передача**: Ответы отображаются в реальном времени
- **TODO система**: Автоматическое отслеживание задач и их выполнения
- **Красивый CLI**: Интерактивный интерфейс командной строки
- **Мультиагентность**: Один агент может вызывать другого как встроенный инструмент

## Установка

```bash
npm install
```

Фреймворк использует:
- **OpenAI SDK** для работы с OpenRouter и Cerebras (OpenAI-совместимый API)
- **Google Generative AI SDK** для работы с Gemini
- **VM2** для безопасного выполнения JavaScript кода

## Настройка

### Глобальные API ключи

Создайте файл `.env` в корне проекта:

```env
OPENROUTER_API_KEY=ваш_ключ_openrouter
GEMINI_API_KEY=ваш_ключ_gemini
CEREBRAS_API_KEY=ваш_ключ_cerebras
CLERK_SECRET_KEY=ваш_clerk_secret_key
```

### Clerk (Auth)

- Frontend (Vite) ожидает `VITE_CLERK_PUBLISHABLE_KEY` (см. `client/env.local.example`)
- Backend (Express) ожидает `CLERK_SECRET_KEY` (см. `env.example`)

Документация Clerk React quickstart: `https://clerk.com/docs/quickstarts/react`

### Кастомные API ключи и параметры для агентов

Каждый агент может использовать собственные API ключи и параметры модели. Добавьте в конфигурацию агента:

```yaml
# agents/my_agent/config.yaml
name: MyAgent
planner:
  provider: gemini
  model: models/gemini-flash-latest
  temperature: 0.8
  # Кастомный API ключ (опционально)
  apiKey: "your-custom-gemini-key"
  # Дополнительные параметры модели
  customParams:
    maxOutputTokens: 8192
    topP: 0.95
    topK: 40

executor:
  provider: openrouter
  model: anthropic/claude-3.5-sonnet
  temperature: 0.7
  # Кастомный API ключ (опционально)
  apiKey: "your-custom-openrouter-key"
  # Дополнительные параметры модели
  customParams:
    max_tokens: 4096
    top_p: 0.9
    frequency_penalty: 0.1
```

**Приоритет API ключей:**
1. `apiKey` в конфигурации агента
2. Переменная окружения `{PROVIDER}_API_KEY`

**Поддерживаемые кастомные параметры:**

**Для Gemini:**
- `maxOutputTokens` - максимальное количество токенов в ответе
- `topP` - nucleus sampling (0.0-1.0)
- `topK` - top-k sampling
- `candidateCount` - количество кандидатов
- `safetySettings` - настройки безопасности

**Для OpenRouter:**
- `max_tokens` - максимальное количество токенов
- `top_p` - nucleus sampling
- `frequency_penalty` - штраф за частоту
- `presence_penalty` - штраф за присутствие
- `extra_body` - дополнительные параметры для конкретной модели

**Для Cerebras:**
- `max_tokens` - максимальное количество токенов
- `top_p` - nucleus sampling
- `frequency_penalty` - штраф за частоту
- `presence_penalty` - штраф за присутствие
- Все стандартные параметры OpenAI-совместимого API

## Запуск

```bash
npm start
```

## Архитектура

### Планировщик (Planner)
- Анализирует запросы пользователя
- Создает TODO списки для достижения целей
- Знает ЧТО могут делать инструменты, но не КАК
- Использует более мощную модель для стратегического мышления

### Исполнитель (Executor)
- Выполняет задачи из TODO списка
- Пишет JavaScript код в тегах `<action></action>`
- Знает синтаксис и API инструментов
- Может использовать более быструю/дешевую модель

### Система выполнения действий

1. Планировщик создает TODO список задач
2. Исполнитель видит текущую задачу (отмечена `← Current`)
3. Исполнитель пишет код в `<action>` тегах для выполнения текущей задачи
4. Код выполняется в изолированной среде с доступом к инструментам
5. Вывод `console.log()` захватывается как результат
6. **ВАЖНО**: После выполнения задачи нужно вызвать `todo.completeCurrent()`
7. Результат автоматически добавляется в `<obs>` тегах
8. Цикл продолжается до завершения всех задач

## Доступные инструменты

### computerUse
Автоматизация браузера с использованием Gemini Browser demo для выполнения сложных задач.

```javascript
await computerUse.completeTask("Detailed task description");
```

Использует [Gemini Browser](https://gemini.browserbase.com/) через Puppeteer для AI-управляемого браузинга.

### search
Веб-поиск с двумя режимами:
- `search.getAnswer(query)` - прямые ответы через Exa Answer API
- `search.webSearch(query)` - поиск через Gemini с Google Search

### calendar
Интеграция с Google Calendar:
- Просмотр событий (`viewWeek`, `viewDay`)
- Добавление событий (`add`)
- Обновление событий (`update`)
- Удаление событий (`delete`)

### weather
Получение информации о погоде для городов (мок-данные).

## Добавление новых инструментов

Создайте папку в `tools/` с файлом `index.js`:

```javascript
// tools/my_tool/index.js
export const myTool = {
  doSomething(param) {
    // Ваша логика
    return "результат";
  }
};
```

Добавьте инструмент в конфиг агента:
```yaml
tools:
  - weather
  - computerUse
  - my_tool
```

## Добавление новых агентов

1. Создайте папку в `agents/[agent_name]/`
2. Создайте `config.yaml`:
```yaml
name: My Agent
planner:
  provider: openrouter
  model: anthropic/claude-3.5-sonnet
  system_prompt_file: planner_system.txt
  temperature: 0.7
executor:
  provider: gemini
  model: gemini-1.5-flash
  system_prompt_file: executor_system.txt
  temperature: 0.3
tools:
  - weather
# Разрешенные вызываемые агенты (по имени или ключу папки)
agents:
  - ActionAgent
# Опциональная задержка (сек) перед стартом, если этого агента вызывает другой
inter_agent_delay_seconds: 5
```

3. Создайте файлы `planner_system.txt` и `executor_system.txt` с промптами

### Мультиагентная делегация (callAgent)

Любой агент может делегировать часть работы другому агенту. Для этого в конфиге вызывающего укажите список `agents`, а у вызываемого можно настроить `inter_agent_delay_seconds` (по умолчанию 5 секунд), чтобы избегать лимитов провайдера.

В Исполнителе доступна встроенная функция:

```javascript
const result = await callAgent("ExternalDataAnalyser", `
  Задача: Суммируй инсайты из последних разговоров по теме «демо робота».
  Контекст: ... (вставь весь необходимый контекст)
  Требования: краткий бриф, тезисы, ссылки на источники.
`);
console.log(result);
```

Правила:
- Разрешены только агенты из списка `agents` вызывающего.
- Можно передавать отображаемое имя (`config.yaml:name`) или ключ папки агента.
- Вызываемый агент работает так, как будто к нему обратился пользователь: со своим планировщиком, исполнителем, инструментами и промптами.
- Перед стартом вызываемый агент может подождать `inter_agent_delay_seconds`.

## Структура проекта

```
acn/
├── agents/           # Конфигурации агентов
│   └── test_agent/
├── tools/            # Инструменты как обычные API
│   └── weather/
├── src/
│   ├── core/         # Ядро фреймворка
│   │   ├── agent.js
│   │   ├── planner.js
│   │   ├── executor.js
│   │   ├── toolLoader.js
│   │   └── agentLoader.js
│   ├── providers/    # Провайдеры LLM
│   │   ├── base.js
│   │   ├── openrouter.js
│   │   ├── gemini.js
│   │   └── cerebras.js
│   └── cli.js        # CLI интерфейс
└── index.js          # Точка входа
```

## Лицензия

ISC
