# Computer Use Tool

Инструмент для автоматизации задач с использованием Exa Research Pro API.

## Описание

Этот инструмент использует [Exa Research Pro API](https://exa.ai/) для выполнения исследовательских задач. Он позволяет создавать глубокие исследования по заданным темам с использованием продвинутой модели `exa-research-pro`.

## API

### `computerUse.completeTask(taskDescription)`

Выполняет задачу с использованием Exa Research Pro API.

**Параметры:**
- `taskDescription` (string) - Супер подробное описание задачи, которую нужно выполнить

**Возвращает:**
- `Promise<string>` - Результат выполнения задачи

**Пример использования:**

```javascript
const result = await computerUse.completeTask("Conduct a comprehensive review of three precise psychological concepts critical for non-verbal rapport building");
console.log(result);
```

## Как это работает

1. Инициализируется клиент Exa с API ключом
2. Создается исследовательская задача через `exa.research.create()` с моделью `exa-research-pro`
3. Получается стрим результатов через `exa.research.get()` с опцией `stream: true`
4. Собираются все события из стрима (контент, результаты)
5. Результат возвращается в виде текста

## Требования

- Установленный `exa-js`: `npm install exa-js`
- Валидный API ключ Exa
- Интернет-соединение

## Ограничения

- Зависит от доступности Exa Research Pro API
- Требует валидный API ключ
- Может занимать время в зависимости от сложности задачи

## Примеры задач

- "Conduct a comprehensive review of psychological concepts for rapport building"
- "Research the latest developments in quantum computing"
- "Find and analyze recent studies on climate change mitigation strategies"
- "Investigate the history and impact of specific technological innovations"

