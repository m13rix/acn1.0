// Тестовый файл для инструмента computerUse
import { computerUse } from './index.js';

/**
 * Тестирует инструмент computerUse с заданным запросом
 * @param {string} taskDescription - Описание задачи для тестирования
 */
async function testComputerUse(taskDescription) {
    try {
        console.log('🧪 Начало тестирования инструмента computerUse');
        console.log(`📋 Задача: "${taskDescription}"`);
        console.log('─'.repeat(60));

        // Вызов функции инструмента
        const result = await computerUse.completeTask(taskDescription);

        console.log('─'.repeat(60));
        console.log('✅ Тест завершен успешно');
        console.log('\n📊 Результат:');
        console.log('─'.repeat(60));
        console.log(result);
        console.log('─'.repeat(60));

        return result;
    } catch (error) {
        console.error('─'.repeat(60));
        console.error('❌ Ошибка при тестировании:');
        console.error(error.message);
        console.error('─'.repeat(60));
        throw error;
    }
}

// Получение задачи из аргументов командной строки или использование тестовой задачи по умолчанию
const taskDescription = process.argv[2] || "Conduct a comprehensive review of three precise psychological concepts critical for non-verbal rapport building: 1. **Mirroring " +
    "in walking pace (Pacing and Leading):** Explain the psychological mechanism by which matching another person's gait/speed fosters subconscious connection. 2. **Shared silence co" +
    "mfort levels:** Define how the presence of comfortable, non-awkward silence between two individuals serves as a measure of established trust and intimacy. 3. **The Ben Franklin " +
    "Effect:** Detail the social psychological principle that states a person who has performed a favor for another person is more likely to feel attraction or liking toward that person than if they had received a favor from them. Synthesize the findings into practical social strategy notes.";

// Запуск теста
testComputerUse(taskDescription)
    .then(() => {
        console.log('\n✅ Тестирование завершено');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Тестирование завершилось с ошибкой');
        process.exit(1);
    });

