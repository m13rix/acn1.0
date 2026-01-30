// Calendar tool - Google Calendar integration
import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import open from 'open';
import http from 'http';
import { URL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREDENTIALS_PATH = path.join(__dirname, './credentials.json');
const TOKEN_PATH = path.join(__dirname, './calendar_token.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// OAuth2 client initialization
let oauth2Client = null;

/**
 * Загружает credentials.json и инициализирует OAuth2 клиент
 */
async function loadCredentials() {
    try {
        const content = await fs.readFile(CREDENTIALS_PATH, 'utf-8');
        const credentials = JSON.parse(content);
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
        return true;
    } catch (error) {
        console.error(chalk.red('❌ Ошибка загрузки credentials.json:'), error.message);
        console.log(chalk.yellow('💡 Убедитесь, что файл credentials.json находится в папке tools/calendar'));
        return false;
    }
}

/**
 * Загружает сохранённый токен или запрашивает новую авторизацию
 */
async function authorize() {
    if (!oauth2Client) {
        const loaded = await loadCredentials();
        if (!loaded) throw new Error('Не удалось загрузить credentials.json');
    }

    // Пытаемся загрузить сохранённый токен
    try {
        const token = await fs.readFile(TOKEN_PATH, 'utf-8');
        oauth2Client.setCredentials(JSON.parse(token));
        console.log(chalk.green('✅ Токен авторизации загружен'));
        return oauth2Client;
    } catch (error) {
        // Токен не найден, запускаем новую авторизацию
        return await getNewToken();
    }
}

/**
 * Получает новый токен через OAuth2 flow
 */
async function getNewToken() {
    return new Promise((resolve, reject) => {
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
        });

        console.log(chalk.yellow('🔐 Требуется авторизация в Google Calendar'));
        console.log(chalk.cyan('Открываю браузер для входа...'));

        // Создаём временный сервер для получения кода авторизации
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, `http://localhost:${server.address().port}`);
                if (url.pathname === '/oauth2callback') {
                    const code = url.searchParams.get('code');

                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="utf-8">
                            <title>Авторизация успешна</title>
                            <style>
                                body {
                                    font-family: Arial, sans-serif;
                                    display: flex;
                                    justify-content: center;
                                    align-items: center;
                                    height: 100vh;
                                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                    margin: 0;
                                }
                                .container {
                                    background: white;
                                    padding: 40px;
                                    border-radius: 10px;
                                    box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                                    text-align: center;
                                }
                                h1 { color: #667eea; margin-bottom: 10px; }
                                p { color: #666; }
                            </style>
                        </head>
                        <body>
                            <div class="container">
                                <h1>✅ Авторизация успешна!</h1>
                                <p>Вы можете закрыть это окно и вернуться к приложению.</p>
                            </div>
                        </body>
                        </html>
                    `);

                    server.close();

                    // Получаем токен
                    const { tokens } = await oauth2Client.getToken(code);
                    oauth2Client.setCredentials(tokens);

                    // Сохраняем токен
                    await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
                    console.log(chalk.green('✅ Токен сохранён в'), TOKEN_PATH);

                    resolve(oauth2Client);
                }
            } catch (error) {
                reject(error);
            }
        });

        server.listen(0, () => {
            const port = server.address().port;
            const redirectUrl = `http://localhost:${port}/oauth2callback`;

            // Обновляем redirect URI
            oauth2Client.redirectUri = redirectUrl;

            const authUrl = oauth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: SCOPES,
            });

            open(authUrl);
        });

        // Таймаут на 5 минут
        setTimeout(() => {
            server.close();
            reject(new Error('Таймаут авторизации'));
        }, 300000);
    });
}

/**
 * Получает даты начала и конца текущей недели
 */
function getCurrentWeekBounds() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    return { start: monday, end: sunday };
}

/**
 * Форматирует события по дням недели
 */
function formatEventsByDay(events) {
    const dayNames = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
    const eventsByDay = {};

    events.forEach(event => {
        const start = new Date(event.start.dateTime || event.start.date);
        const dayName = dayNames[start.getDay()];
        const dateStr = start.toLocaleDateString('ru-RU');

        if (!eventsByDay[dayName]) {
            eventsByDay[dayName] = { date: dateStr, events: [] };
        }

        const timeStr = event.start.dateTime
            ? new Date(event.start.dateTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
            : 'Весь день';

        eventsByDay[dayName].events.push({
            time: timeStr,
            summary: event.summary || '(Без названия)',
            id: event.id
        });
    });

    return eventsByDay;
}

/**
 * 1. Просмотр всех событий на эту неделю
 */
async function viewWeekEvents() {
    const auth = await authorize();
    const calendar = google.calendar({ version: 'v3', auth });

    const { start, end } = getCurrentWeekBounds();

    const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
    });

    const events = response.data.items || [];

    if (events.length === 0) {
        return '📅 На этой неделе нет событий.';
    }

    const eventsByDay = formatEventsByDay(events);
    let result = `📅 События на неделю (${start.toLocaleDateString('ru-RU')} - ${end.toLocaleDateString('ru-RU')}):\n\n`;

    const dayOrder = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

    dayOrder.forEach(day => {
        if (eventsByDay[day]) {
            result += `🗓️  ${day} (${eventsByDay[day].date})\n`;
            eventsByDay[day].events.forEach(event => {
                result += `   • ${event.time} - ${event.summary}\n`;
            });
            result += '\n';
        }
    });

    return result.trim();
}

/**
 * 2. Просмотр событий на определённый день
 */
async function viewDayEvents(dateStr) {
    const auth = await authorize();
    const calendar = google.calendar({ version: 'v3', auth });

    // Парсим дату
    const targetDate = new Date(dateStr);
    if (isNaN(targetDate.getTime())) {
        throw new Error('Неверный формат даты. Используйте YYYY-MM-DD');
    }

    const start = new Date(targetDate);
    start.setHours(0, 0, 0, 0);

    const end = new Date(targetDate);
    end.setHours(23, 59, 59, 999);

    const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
    });

    const events = response.data.items || [];

    if (events.length === 0) {
        return `📅 На ${targetDate.toLocaleDateString('ru-RU')} нет событий.`;
    }

    let result = `📅 События на ${targetDate.toLocaleDateString('ru-RU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}:\n\n`;

    events.forEach(event => {
        const timeStr = event.start.dateTime
            ? new Date(event.start.dateTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
            : 'Весь день';
        result += `• ${timeStr} - ${event.summary || '(Без названия)'}\n`;
    });

    return result.trim();
}

/**
 * 3. Добавление событий
 * @param {Array<string>} daysOfWeek - Дни недели ['monday', 'tuesday', etc]
 * @param {string} summary - Название события
 * @param {string} startTime - Время начала в формате HH:MM
 * @param {string} duration - Длительность в формате HH:MM
 * @param {boolean} recurring - Повторять ли на всех неделях
 */
async function addEvent(daysOfWeek, summary, startTime, duration, recurring = false) {
    const auth = await authorize();
    const calendar = google.calendar({ version: 'v3', auth });

    const dayMap = {
        'monday': 1, 'понедельник': 1,
        'tuesday': 2, 'вторник': 2,
        'wednesday': 3, 'среда': 3,
        'thursday': 4, 'четверг': 4,
        'friday': 5, 'пятница': 5,
        'saturday': 6, 'суббота': 6,
        'sunday': 0, 'воскресенье': 0
    };

    // Парсим время
    const [startHour, startMin] = startTime.split(':').map(Number);
    const [durationHour, durationMin] = duration.split(':').map(Number);

    const results = [];

    for (const day of daysOfWeek) {
        const dayNum = dayMap[day.toLowerCase()];
        if (dayNum === undefined) {
            results.push(`⚠️ Неизвестный день недели: ${day}`);
            continue;
        }

        // Находим ближайший такой день недели
        const now = new Date();
        const currentDay = now.getDay();
        let daysUntil = dayNum - currentDay;
        if (daysUntil < 0) daysUntil += 7;

        const eventDate = new Date(now);
        eventDate.setDate(now.getDate() + daysUntil);
        eventDate.setHours(startHour, startMin, 0, 0);

        const endDate = new Date(eventDate);
        endDate.setHours(startHour + durationHour, startMin + durationMin, 0, 0);

        const event = {
            summary,
            start: {
                dateTime: eventDate.toISOString(),
                timeZone: 'Europe/Moscow',
            },
            end: {
                dateTime: endDate.toISOString(),
                timeZone: 'Europe/Moscow',
            },
            reminders: {
                useDefault: false,
                overrides: [
                    {
                        method: 'popup',
                        minutes: 5
                    }
                ]
            }
        };

        // Если событие повторяющееся, добавляем правило рекуррентности
        if (recurring) {
            const dayAbbr = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][dayNum];
            event.recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=${dayAbbr}`];
        }

        const response = await calendar.events.insert({
            calendarId: 'primary',
            resource: event,
        });

        results.push(`✅ Событие создано: ${summary} на ${day} в ${startTime} (ID: ${response.data.id})`);
    }

    return results.join('\n');
}

/**
 * 4. Изменение событий по имени
 */
async function updateEvent(eventName, daysOfWeek = null, newSummary = null, startTime = null, duration = null, thisWeekOnly = true) {
    const auth = await authorize();
    const calendar = google.calendar({ version: 'v3', auth });

    // Находим события с указанным именем
    const searchBounds = thisWeekOnly ? getCurrentWeekBounds() : { start: new Date(), end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) };

    const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: searchBounds.start.toISOString(),
        timeMax: searchBounds.end.toISOString(),
        q: eventName,
        singleEvents: !thisWeekOnly,
    });

    const events = response.data.items || [];
    if (events.length === 0) {
        return `❌ События с названием "${eventName}" не найдены.`;
    }

    const results = [];

    for (const event of events) {
        // Обновляем только указанные поля
        const updates = {};

        if (newSummary) updates.summary = newSummary;

        if (startTime && duration) {
            const eventStart = new Date(event.start.dateTime || event.start.date);
            const [startHour, startMin] = startTime.split(':').map(Number);
            const [durationHour, durationMin] = duration.split(':').map(Number);

            eventStart.setHours(startHour, startMin, 0, 0);
            const eventEnd = new Date(eventStart);
            eventEnd.setHours(startHour + durationHour, startMin + durationMin, 0, 0);

            updates.start = {
                dateTime: eventStart.toISOString(),
                timeZone: event.start.timeZone || 'Europe/Moscow',
            };
            updates.end = {
                dateTime: eventEnd.toISOString(),
                timeZone: event.end.timeZone || 'Europe/Moscow',
            };
            // Добавляем напоминание за 5 минут
            updates.reminders = {
                useDefault: false,
                overrides: [
                    {
                        method: 'popup',
                        minutes: 5
                    }
                ]
            };
        }

        if (Object.keys(updates).length > 0) {
            await calendar.events.patch({
                calendarId: 'primary',
                eventId: event.id,
                resource: updates,
            });

            results.push(`✅ Событие обновлено: ${event.summary} (ID: ${event.id})`);
        }
    }

    return results.length > 0 ? results.join('\n') : '⚠️ Нет событий для обновления.';
}

/**
 * 5. Удаление событий по имени
 */
async function deleteEvent(eventName, daysOfWeek = null, thisWeekOnly = true) {
    const auth = await authorize();
    const calendar = google.calendar({ version: 'v3', auth });

    // Находим события с указанным именем
    const searchBounds = thisWeekOnly ? getCurrentWeekBounds() : { start: new Date(), end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) };

    const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: searchBounds.start.toISOString(),
        timeMax: searchBounds.end.toISOString(),
        q: eventName,
        singleEvents: false,
    });

    const events = response.data.items || [];
    if (events.length === 0) {
        return `❌ События с названием "${eventName}" не найдены.`;
    }

    const results = [];

    for (const event of events) {
        // Если указаны конкретные дни недели, проверяем
        if (daysOfWeek && daysOfWeek.length > 0) {
            const eventStart = new Date(event.start.dateTime || event.start.date);
            const dayNum = eventStart.getDay();

            // Создаем массив возможных названий для этого дня
            const possibleDayNames = [
                ['sunday', 'воскресенье'],      // 0
                ['monday', 'понедельник'],      // 1
                ['tuesday', 'вторник'],         // 2
                ['wednesday', 'среда'],         // 3
                ['thursday', 'четверг'],        // 4
                ['friday', 'пятница'],          // 5
                ['saturday', 'суббота']         // 6
            ];

            const eventDayNames = possibleDayNames[dayNum];
            const requestedDaysLower = daysOfWeek.map(d => String(d).toLowerCase());

            // Проверяем, есть ли совпадение с любым из названий дня
            const dayMatches = eventDayNames.some(dayName =>
                requestedDaysLower.includes(dayName)
            );

            if (!dayMatches) {
                continue;
            }
        }

        await calendar.events.delete({
            calendarId: 'primary',
            eventId: event.id,
        });

        results.push(`🗑️ Событие удалено: ${event.summary} (ID: ${event.id})`);
    }

    return results.length > 0 ? results.join('\n') : '⚠️ Нет событий для удаления.';
}

// Экспорт инструмента в формате системы
export const calendar = {
    /**
     * Просмотр всех событий на эту неделю
     * @returns {Promise<string>} Formatted list of week events
     */
    viewWeek: async () => {
        try {
            console.log(chalk.blue('\n📅 Выполняется операция: viewWeek'));
            return await viewWeekEvents();
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в Calendar.viewWeek:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    },

    /**
     * Просмотр событий на определённый день
     * @param {string} date - Date in YYYY-MM-DD format
     * @returns {Promise<string>} Formatted list of day events
     */
    viewDay: async (date) => {
        try {
            console.log(chalk.blue(`\n📅 Выполняется операция: viewDay для ${date}`));
            if (!date) throw new Error('Требуется параметр date в формате YYYY-MM-DD');
            return await viewDayEvents(date);
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в Calendar.viewDay:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    },

    /**
     * Добавление события
     * @param {Array<string>|string} daysOfWeek - Days of week (e.g., ['monday', 'friday'])
     * @param {string} summary - Event title
     * @param {string} startTime - Start time in HH:MM format
     * @param {string} duration - Duration in HH:MM format
     * @param {boolean} recurring - Whether to repeat weekly
     * @returns {Promise<string>} Result message
     */
    add: async (daysOfWeek, summary, startTime, duration, recurring = false) => {
        try {
            console.log(chalk.blue('\n📅 Выполняется операция: add'));
            
            if (!daysOfWeek || !summary || !startTime || !duration) {
                throw new Error('Требуются параметры: daysOfWeek, summary, startTime, duration');
            }

            // Парсим daysOfWeek если это строка
            let parsedDaysOfWeek;
            if (typeof daysOfWeek === 'string') {
                try {
                    parsedDaysOfWeek = JSON.parse(daysOfWeek);
                } catch (e) {
                    // Если не JSON, то просто массив из одного элемента
                    parsedDaysOfWeek = [daysOfWeek];
                }
            } else if (Array.isArray(daysOfWeek)) {
                parsedDaysOfWeek = daysOfWeek;
            } else {
                parsedDaysOfWeek = [daysOfWeek];
            }

            return await addEvent(
                parsedDaysOfWeek,
                summary,
                startTime,
                duration,
                recurring === true || recurring === 'true'
            );
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в Calendar.add:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    },

    /**
     * Изменение события по имени
     * @param {string} eventName - Name of the event to update
     * @param {Array<string>|string|null} daysOfWeek - Optional days filter
     * @param {string|null} newSummary - New event title
     * @param {string|null} startTime - New start time in HH:MM format
     * @param {string|null} duration - New duration in HH:MM format
     * @param {boolean} thisWeekOnly - Whether to update only this week's events
     * @returns {Promise<string>} Result message
     */
    update: async (eventName, daysOfWeek = null, newSummary = null, startTime = null, duration = null, thisWeekOnly = true) => {
        try {
            console.log(chalk.blue(`\n📅 Выполняется операция: update для "${eventName}"`));
            
            if (!eventName) throw new Error('Требуется параметр eventName');

            // Парсим daysOfWeek если это строка
            let parsedDaysOfWeek;
            if (daysOfWeek) {
                if (typeof daysOfWeek === 'string') {
                    try {
                        parsedDaysOfWeek = JSON.parse(daysOfWeek);
                    } catch (e) {
                        parsedDaysOfWeek = [daysOfWeek];
                    }
                } else if (Array.isArray(daysOfWeek)) {
                    parsedDaysOfWeek = daysOfWeek;
                } else {
                    parsedDaysOfWeek = [daysOfWeek];
                }
            }

            return await updateEvent(
                eventName,
                parsedDaysOfWeek,
                newSummary,
                startTime,
                duration,
                thisWeekOnly !== false && thisWeekOnly !== 'false'
            );
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в Calendar.update:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    },

    /**
     * Удаление события по имени
     * WARNING: If daysOfWeek is null, ALL matching events will be deleted!
     * @param {string} eventName - Name of the event to delete
     * @param {Array<string>|string|null} daysOfWeek - Days filter (null = delete ALL matching events!)
     * @param {boolean} thisWeekOnly - Whether to delete only this week's events
     * @returns {Promise<string>} Result message
     */
    delete: async (eventName, daysOfWeek = null, thisWeekOnly = true) => {
        try {
            console.log(chalk.blue(`\n📅 Выполняется операция: delete для "${eventName}"`));
            
            if (!eventName) throw new Error('Требуется параметр eventName');

            // Парсим daysOfWeek если это строка
            let parsedDaysOfWeek;
            if (daysOfWeek) {
                if (typeof daysOfWeek === 'string') {
                    try {
                        parsedDaysOfWeek = JSON.parse(daysOfWeek);
                    } catch (e) {
                        parsedDaysOfWeek = [daysOfWeek];
                    }
                } else if (Array.isArray(daysOfWeek)) {
                    parsedDaysOfWeek = daysOfWeek;
                } else {
                    parsedDaysOfWeek = [daysOfWeek];
                }
            }

            return await deleteEvent(
                eventName,
                parsedDaysOfWeek || null,
                thisWeekOnly !== false && thisWeekOnly !== 'false'
            );
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в Calendar.delete:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    }
};

