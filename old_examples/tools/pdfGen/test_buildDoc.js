// Test script for building PDF document from existing HTML pages
import { pdfGen } from './index.js';
import chalk from 'chalk';

console.log(chalk.blue('\n=== Тестирование функции pdfGen.buildDoc() ===\n'));

try {
    const result = await pdfGen.buildDoc();
    console.log(chalk.green('\n✅ Успешно!'));
    console.log(chalk.gray(`Результат: ${result}`));
    process.exit(0);
} catch (error) {
    console.error(chalk.red('\n❌ Ошибка при создании PDF:'));
    console.error(chalk.red(error.message));
    console.error(error.stack);
    process.exit(1);
}

