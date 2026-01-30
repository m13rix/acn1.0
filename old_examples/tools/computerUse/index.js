// Computer Use tool - Uses Exa Research Pro API for task automation
import Exa from 'exa-js';
import chalk from 'chalk';

/**
 * Complete a task using Exa Research Pro API
 * @param {string} taskDescription - Detailed description of the task to complete
 * @returns {Promise<string>} Result from the task execution
 */
async function completeTaskWithExaResearch(taskDescription) {
    try {
        if (!taskDescription) {
            throw new Error('Требуется описание задачи');
        }

        console.log(chalk.blue(`\n🤖 Запуск Exa Research Pro для выполнения задачи: "${taskDescription}"`));

        // Initialize Exa client
        const exa = new Exa("3b6f5b88-fe18-492f-9d05-f3c67af51590");

        console.log(chalk.gray('📝 Создание исследования...'));

        // Create research task
        const research = await exa.research.create({
            instructions: taskDescription,
            model: "exa-research-pro"
        });

        console.log(chalk.gray(`📊 ID исследования: ${research.researchId}`));
        console.log(chalk.gray('⏳ Ожидание выполнения исследования...'));

        // Get research results with streaming
        const stream = await exa.research.get(research.researchId, { stream: true });

        const resultParts = [];
        let lastEvent = null;

        // Collect all events from stream
        for await (const event of stream) {
            lastEvent = event;
            
            // Collect content from different event types
            if (event.type === 'content' && event.content) {
                resultParts.push(event.content);
            } else if (event.type === 'research_complete' && event.result) {
                // If result is directly available
                if (typeof event.result === 'string') {
                    resultParts.push(event.result);
                } else if (event.result.content) {
                    resultParts.push(event.result.content);
                }
            } else if (event.content) {
                // Fallback for any content field
                resultParts.push(event.content);
            }
        }

        // If we have collected parts, join them
        let result = resultParts.join('\n\n');

        // If no content was collected but we have a last event, try to extract from it
        if (!result && lastEvent) {
            if (lastEvent.result) {
                result = typeof lastEvent.result === 'string' 
                    ? lastEvent.result 
                    : JSON.stringify(lastEvent.result, null, 2);
            } else {
                result = JSON.stringify(lastEvent, null, 2);
            }
        }

        // If still no result, return a message
        if (!result || result.trim().length === 0) {
            result = 'Результаты исследования не найдены. Проверьте статус исследования.';
        }

        console.log(chalk.green('✅ Исследование завершено!'));
        console.log(chalk.gray('📥 Результат получен'));

        return result;

    } catch (error) {
        console.error(chalk.red('❌ Ошибка выполнения задачи:'), error.message);
        throw error;
    }
}

// Export tool in system format
export const computerUse = {
    /**
     * Complete a task using Exa Research Pro API
     * Creates a research task using Exa Research Pro and retrieves results
     * @param {string} taskDescription - Super detailed description of the task to complete
     * @returns {Promise<string>} Task execution results
     */
    completeTask: async (taskDescription) => {
        try {
            console.log(chalk.blue('\n🤖 Выполняется операция: computerUse.completeTask'));

            if (!taskDescription) {
                throw new Error('Требуется параметр taskDescription');
            }

            return await completeTaskWithExaResearch(taskDescription);
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в computerUse.completeTask:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    }
};

