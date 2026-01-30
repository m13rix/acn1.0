// Notes tool - Notion integration via REST API
import axios from 'axios';
import chalk from 'chalk';

/**
 * Get Notion API headers
 */
function getNotionHeaders() {
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) {
        throw new Error('Необходимо установить переменную окружения NOTION_API_KEY');
    }
    return {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
    };
}

/**
 * Get database ID from environment
 */
function getDatabaseId() {
    const databaseId = "2908f11a0fbb80bbae3ae60ae0c89539";
    if (!databaseId) {
        throw new Error('Необходимо установить переменную окружения NOTION_DATABASE_ID');
    }
    return databaseId;
}

/**
 * Get all notes from Notion database
 * @param {number} limit - Maximum number of notes to return (default: 10)
 * @returns {Promise<string>} List of note titles
 */
async function getAllNotes(limit = 10) {
    try {
        const databaseId = getDatabaseId();
        console.log(databaseId)

        console.log(chalk.blue(`\n📝 Получение списка заметок (лимит: ${limit})`));

        const response = await axios.post(
            `https://api.notion.com/v1/databases/${databaseId}/query`,
            {
                page_size: Math.min(limit, 100),
                sorts: [
                    {
                        timestamp: 'last_edited_time',
                        direction: 'descending'
                    }
                ]
            },
            { headers: getNotionHeaders() }
        );

        const results = response.data.results || [];

        if (results.length === 0) {
            console.log(chalk.yellow('ℹ️  Заметки не найдены'));
            return 'Заметки не найдены';
        }

        const notes = results.map((page, index) => {
            // Extract title from page properties
            let title = 'Без названия';

            // Find title property
            for (const [key, value] of Object.entries(page.properties)) {
                if (value.type === 'title' && value.title && value.title.length > 0) {
                    title = value.title[0].plain_text;
                    break;
                }
            }

            return `${index + 1}. ${title}`;
        });

        const result = `Найдено заметок: ${notes.length}\n\n${notes.join('\n')}`;
        console.log(chalk.green(`✅ Получено заметок: ${notes.length}`));
        return result;

    } catch (error) {
        console.error(chalk.red('❌ Ошибка при получении списка заметок:'), error.message);
        if (error.response) {
            console.error(chalk.red('Детали ошибки:'), error.response.data);
        }
        throw error;
    }
}

/**
 * Get note content by title
 * @param {string} title - Note title
 * @returns {Promise<string>} Note content
 */
async function getNoteByTitle(title) {
    try {
        const databaseId = getDatabaseId();

        console.log(chalk.blue(`\n📄 Поиск заметки: "${title}"`));

        // First, get database to find the title property name
        const dbResponse = await axios.get(
            `https://api.notion.com/v1/databases/${databaseId}`,
            { headers: getNotionHeaders() }
        );

        // Find the title property name
        let titlePropertyName = 'Name';
        for (const [key, value] of Object.entries(dbResponse.data.properties)) {
            if (value.type === 'title') {
                titlePropertyName = key;
                break;
            }
        }

        // Search for page by title
        const searchResponse = await axios.post(
            `https://api.notion.com/v1/databases/${databaseId}/query`,
            {
                filter: {
                    property: titlePropertyName,
                    title: {
                        contains: title
                    }
                }
            },
            { headers: getNotionHeaders() }
        );

        const results = searchResponse.data.results || [];

        if (results.length === 0) {
            console.log(chalk.yellow(`ℹ️  Заметка "${title}" не найдена`));
            return `Заметка с названием "${title}" не найдена`;
        }

        // Get the first matching page
        const page = results[0];
        const pageId = page.id;

        // Extract title
        let pageTitle = 'Без названия';
        for (const [key, value] of Object.entries(page.properties)) {
            if (value.type === 'title' && value.title && value.title.length > 0) {
                pageTitle = value.title[0].plain_text;
                break;
            }
        }

        console.log(chalk.blue(`📖 Получение содержимого заметки: "${pageTitle}"`));

        // Get page content (blocks)
        const blocksResponse = await axios.get(
            `https://api.notion.com/v1/blocks/${pageId}/children`,
            { headers: getNotionHeaders() }
        );

        const blocks = blocksResponse.data.results || [];

        if (blocks.length === 0) {
            console.log(chalk.yellow('ℹ️  Заметка пустая'));
            return `Заметка "${pageTitle}" пустая`;
        }

        // Convert blocks to text
        const content = blocks.map(block => {
            return extractTextFromBlock(block);
        }).filter(text => text.length > 0).join('\n\n');

        const result = `=== ${pageTitle} ===\n\n${content}`;
        console.log(chalk.green('✅ Содержимое заметки получено'));
        return result;

    } catch (error) {
        console.error(chalk.red('❌ Ошибка при получении заметки:'), error.message);
        if (error.response) {
            console.error(chalk.red('Детали ошибки:'), error.response.data);
        }
        throw error;
    }
}

/**
 * Extract plain text from a Notion block
 * @param {Object} block - Notion block object
 * @returns {string} Plain text content
 */
function extractTextFromBlock(block) {
    const type = block.type;
    const content = block[type];

    if (!content) return '';

    // Handle different block types
    if (content.rich_text) {
        return content.rich_text.map(rt => rt.plain_text).join('');
    }

    if (type === 'child_page') {
        return `[Вложенная страница: ${content.title}]`;
    }

    if (type === 'table_of_contents') {
        return '[Оглавление]';
    }

    if (type === 'divider') {
        return '---';
    }

    return '';
}

/**
 * Create a new note in Notion database
 * @param {string} title - Note title
 * @param {string} content - Note text content
 * @returns {Promise<string>} Success message with note ID
 */
async function createNote(title, content) {
    try {
        const databaseId = getDatabaseId();

        console.log(chalk.blue(`\n➕ Создание новой заметки: "${title}"`));

        // First, get database to find the title property name
        const dbResponse = await axios.get(
            `https://api.notion.com/v1/databases/${databaseId}`,
            { headers: getNotionHeaders() }
        );

        // Find the title property name
        let titlePropertyName = 'Name';
        for (const [key, value] of Object.entries(dbResponse.data.properties)) {
            if (value.type === 'title') {
                titlePropertyName = key;
                break;
            }
        }

        // Create new page in database
        const pageResponse = await axios.post(
            `https://api.notion.com/v1/pages`,
            {
                parent: {
                    database_id: databaseId
                },
                properties: {
                    [titlePropertyName]: {
                        title: [
                            {
                                text: {
                                    content: title
                                }
                            }
                        ]
                    }
                }
            },
            { headers: getNotionHeaders() }
        );

        const pageId = pageResponse.data.id;

        console.log(chalk.blue(`📝 Добавление содержимого заметки (Page ID: ${pageId})`));

        // Split content into paragraphs (split by double newlines, or single newlines if no double newlines)
        // First try splitting by double newlines
        let paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 0);
        
        // If we got only one paragraph, try splitting by single newlines for better formatting
        if (paragraphs.length === 1 && content.includes('\n')) {
            paragraphs = content.split(/\n+/).filter(p => p.trim().length > 0);
        }

        if (paragraphs.length === 0) {
            // If no content provided, just create empty page
            console.log(chalk.green('✅ Заметка создана (без содержимого)'));
            return `Заметка "${title}" успешно создана. ID: ${pageId}`;
        }

        // Create blocks for content
        const blocks = paragraphs.map(paragraph => {
            return {
                type: 'paragraph',
                paragraph: {
                    rich_text: [
                        {
                            type: 'text',
                            text: {
                                content: paragraph.trim()
                            }
                        }
                    ]
                }
            };
        });

        // Add blocks to page (chunk by 100 blocks as per Notion API limit)
        const chunkSize = 100;
        for (let i = 0; i < blocks.length; i += chunkSize) {
            const chunk = blocks.slice(i, i + chunkSize);
            
            const url = `https://api.notion.com/v1/blocks/${pageId}/children`;
            console.log(chalk.gray(`Попытка добавления блоков, URL: ${url}`));
            
            try {
                await axios.patch(
                    url,
                    {
                        children: chunk
                    },
                    { headers: getNotionHeaders() }
                );
                console.log(chalk.green(`✅ Блоки ${i + 1}-${Math.min(i + chunkSize, blocks.length)} добавлены успешно`));
            } catch (blockError) {
                console.error(chalk.yellow(`⚠️  Ошибка при добавлении блока ${i + 1}-${Math.min(i + chunkSize, blocks.length)}:`), blockError.message);
                if (blockError.response) {
                    console.error(chalk.yellow('Детали ошибки блока:'), JSON.stringify(blockError.response.data, null, 2));
                }
                // Не выбрасываем ошибку, заметка уже создана
                throw new Error(`Заметка "${title}" создана (ID: ${pageId}), но не удалось добавить содержимое: ${blockError.message}`);
            }
        }

        console.log(chalk.green(`✅ Заметка "${title}" успешно создана с ${paragraphs.length} блок(ами) содержимого`));
        return `Заметка "${title}" успешно создана. ID: ${pageId}`;

    } catch (error) {
        console.error(chalk.red('❌ Ошибка при создании заметки:'), error.message);
        if (error.response) {
            console.error(chalk.red('Детали ошибки:'), error.response.data);
        }
        throw error;
    }
}

// Export tool in system format
export const notes = {
    /**
     * Get list of all notes (titles only)
     * @param {number} limit - Maximum number of notes to return (default: 10, max: 100)
     * @returns {Promise<string>} Formatted list of note titles
     */
    getAll: async (limit = 10) => {
        try {
            console.log(chalk.blue('\n📝 Выполняется операция: notes.getAll'));

            const parsedLimit = parseInt(limit);
            if (isNaN(parsedLimit) || parsedLimit < 1) {
                throw new Error('Параметр limit должен быть положительным числом');
            }

            return await getAllNotes(parsedLimit);
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в notes.getAll:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    },

    /**
     * Get note content by title
     * @param {string} title - Note title or part of title
     * @returns {Promise<string>} Note content
     */
    get: async (title) => {
        try {
            console.log(chalk.blue('\n📄 Выполняется операция: notes.get'));

            if (!title) {
                throw new Error('Требуется параметр title');
            }

            return await getNoteByTitle(title);
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в notes.get:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    },

    /**
     * Create a new note in Notion database
     * @param {string} title - Note title
     * @param {string} content - Note text content
     * @returns {Promise<string>} Success message with note ID
     */
    add: async (title, content) => {
        try {
            console.log(chalk.blue('\n➕ Выполняется операция: notes.add'));

            if (!title) {
                throw new Error('Требуется параметр title');
            }

            if (content === undefined || content === null) {
                content = '';
            }

            return await createNote(title, content);
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в notes.add:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    }
};

