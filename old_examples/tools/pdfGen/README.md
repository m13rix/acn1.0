# PDF Generator Tool (pdfGen)

Инструмент для создания высококачественных PDF документов с использованием AI-генерации изображений.

## Возможности

### 1. Генерация изображений (generateImage)

Создает изображения с помощью Google Gemini AI.

```javascript
pdfGen.generateImage(prompt, transparent)
```

**Параметры:**
- `prompt` (string) - Промпт для генерации изображения на английском языке
- `transparent` (boolean, default: true) - Делать ли фон прозрачным

**Возвращает:** Путь к сгенерированному изображению

**Пример:**
```javascript
await pdfGen.generateImage("A modern logo with geometric shapes", true);
// Результат: "Изображение успешно сгенерировано и сохранено в ./images/img1.png"
```

**Как работает прозрачность:**
- Если `transparent = true`, к промпту автоматически добавляется "\nMake the background purely white, no shadows"
- После генерации все чисто белые пиксели заменяются на прозрачные
- Изображение сохраняется в формате PNG с прозрачностью

**Путь сохранения:** `tools/pdfGen/data/images/img{N}.png`

### 2. Генерация HTML страниц (generatePage)

Создает HTML страницы для дальнейшей конвертации в PDF.

```javascript
pdfGen.generatePage(htmlContent, pageIndex, smartPageBreaks = true)
```

**Параметры:**
- `htmlContent` (string) - Полный HTML контент страницы
- `pageIndex` (number) - Индекс страницы (начиная с 0)

**Возвращает:** Сообщение об успешном создании страницы

**Автоматические добавления:**
- `<!DOCTYPE html>` если отсутствует
- Тег `<html>` с основной структурой
- Мета-тег UTF-8 кодировки
- Подключение стилей из `styles.css`
- Умные правила разрыва страниц и вертикального центрирования (можно отключить параметром `smartPageBreaks = false`)

**Пример:**
```javascript
const html = `
<div class="header">
  <h1>Заголовок документа</h1>
</div>
`;
await pdfGen.generatePage(html, 0);
// Результат: "Страница успешно сгенерирована: page0.html"
```

**Путь сохранения:** `tools/pdfGen/data/page{index}.html`

### 3. Генерация стилей (generateStyle)

Создает или заменяет CSS файл со стилями.

```javascript
pdfGen.generateStyle(cssContent)
```

**Параметры:**
- `cssContent` (string) - Полный CSS код всех стилей

**Возвращает:** Сообщение об успешном создании файла стилей

**Пример:**
```javascript
const css = `
body {
  font-family: Arial, sans-serif;
  margin: 0;
  padding: 20px;
}

.header {
  background: linear-gradient(to right, #667eea, #764ba2);
  color: white;
  padding: 40px;
  text-align: center;
}
`;
await pdfGen.generateStyle(css);
// Результат: "Файл стилей успешно создан: styles.css"
```

**Путь сохранения:** `tools/pdfGen/data/styles.css`

### 4. Сборка PDF документа (buildDoc)

Конвертирует все HTML страницы в единый PDF документ.

```javascript
pdfGen.buildDoc()
```

**Параметры:** Нет

**Возвращает:** Сообщение об успешном создании PDF документа с количеством страниц

**Как работает:**
1. Находит все файлы `page{N}.html` в папке `data`
2. Автоматически добавляет (или обновляет) умные правила разрыва страниц и вертикального центрирования, чтобы секции не разрывались некрасиво
3. Сортирует файлы по индексу (от меньшего к большему)
4. Конвертирует каждую страницу в PDF, используя Puppeteer, и центрирует секции, если они начинаются на новой странице
5. Объединяет страницы в единый PDF документ
6. Сохраняет результат

**Пример:**
```javascript
await pdfGen.buildDoc();
// Результат: "PDF документ успешно создан: cheap_setup.pdf (3 страниц)"
```

**Путь сохранения:** `tools/pdfGen/data/generatedDocument.pdf`

**Параметры PDF:**
- Формат: A4
- Ориентация: Альбомная (горизонтальная)
- Поля: 0 (без полей - контент занимает всю страницу)
- Печать фона: включена
- Если нужны визуальные отступы, добавьте их через CSS в HTML (padding/margin)

### 5. Умные разрывы страниц (applySmartPageBreaks)

Применяет алгоритм предотвращения некрасивых разрывов и вертикально центрирует секции, которые переходят на новую страницу.

```javascript
pdfGen.applySmartPageBreaks()
```

**Возвращает:** Сообщение о количестве обновлённых HTML файлов

**Когда использовать:**
- Если HTML страницы уже созданы, и нужно просто перераспределить контент перед сборкой PDF
- Чтобы быстро обновить правила разрыва страниц без повторной генерации контента

**Пример:**
```javascript
await pdfGen.applySmartPageBreaks();
await pdfGen.buildDoc();
```

## Типичный процесс работы

```javascript
// 1. Создаем стили
await pdfGen.generateStyle(`
  body {
    font-family: 'Arial', sans-serif;
    line-height: 1.6;
  }
  .page {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
  }
`);

// 2. Генерируем изображение для обложки
await pdfGen.generateImage("Professional business logo with blue gradient", true);

// 3. Создаем страницы
await pdfGen.generatePage(`
  <div class="page">
    <img src="./images/img1.png" alt="Logo">
    <h1>Бизнес-презентация</h1>
  </div>
`, 0);

await pdfGen.generatePage(`
  <div class="page">
    <h2>О компании</h2>
    <p>Текст о компании...</p>
  </div>
`, 1);

// 4. Собираем PDF
await pdfGen.buildDoc();
```

## Структура файлов

```
tools/pdfGen/
├── index.js              # Основной модуль
├── README.md            # Документация
└── data/                # Рабочая директория
    ├── images/          # Сгенерированные изображения
    │   ├── img1.png
    │   ├── img2.png
    │   └── ...
    ├── page0.html       # HTML страницы
    ├── page1.html
    ├── styles.css       # Общие стили
    └── generatedDocument.pdf  # Итоговый PDF
```

## Требования

- Node.js
- Зависимости:
  - `@google/generative-ai` - для генерации изображений
  - `sharp` - для обработки изображений
  - `puppeteer` - для конвертации HTML в PDF
  - `pdf-lib` - для объединения PDF страниц
  - `chalk` - для цветного вывода в консоль

## API Key

Инструмент использует Google Generative AI API с ключом, встроенным в код. Для генерации изображений используется модель `gemini-2.5-flash-image`.

## Тестовые скрипты

Для тестирования функционала без перезапуска всего агента предусмотрены специальные скрипты:

### Быстрая сборка PDF (test_buildDoc.js)

Простой скрипт для сборки PDF из существующих HTML страниц:

```bash
cd tools/pdfGen
node test_buildDoc.js
```

### Полный тестовый набор (test.js)

Универсальный скрипт с различными командами:

```bash
cd tools/pdfGen

# Собрать PDF из существующих страниц (по умолчанию)
node test.js
# или
node test.js build

# Тест генерации изображения
node test.js image

# Тест генерации стилей
node test.js style

# Тест генерации страницы
node test.js page

# Применить умные разрывы страниц к существующим HTML
node test.js breaks

# Запустить все тесты подряд
node test.js all
```

**Примеры использования:**

```bash
# Создали страницы через агента, теперь хотим пересобрать PDF
node test.js build

# Обновить правила разрыва страниц без генерации нового HTML
node test.js breaks

# Проверить работу всех функций
node test.js all
```

## Устранение проблем

### Timeout при создании PDF

Если возникает ошибка "Navigation timeout", убедитесь что:
- Все пути к изображениям в HTML относительные (`./images/img1.png`)
- Изображения действительно существуют в папке `data/images/`
- CSS файл существует, если на него есть ссылки

Инструмент автоматически:
- Увеличивает timeout до 60 секунд
- Использует `file://` протокол для корректной загрузки локальных ресурсов
- Пытается продолжить генерацию даже если какие-то ресурсы не загрузились

## Примечания

- Индексация страниц начинается с 0
- При создании страницы с существующим индексом, старая страница перезаписывается
- Изображения нумеруются автоматически (инкрементально)
- Все пути к изображениям в HTML должны быть относительными: `./images/img1.png`
- CSS файл подключается автоматически ко всем страницам
- PDF генерируется с форматом A4, без полей (0mm) и включённой печатью фона
- Если нужны поля, их можно добавить через CSS в HTML страницах (например, `padding` или `margin` в body)

