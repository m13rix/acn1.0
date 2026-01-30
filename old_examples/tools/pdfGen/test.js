// Comprehensive test script for pdfGen tool
import { pdfGen } from './index.js';
import chalk from 'chalk';

const command = process.argv[2] || 'build';

console.log(chalk.blue('\n=== Тестирование pdfGen Tool ===\n'));

async function testGenerateImage() {
    console.log(chalk.cyan('📸 Тест генерации изображения...'));
    const result = await pdfGen.generateImage('A beautiful sunset over mountains with vibrant colors', true);
    console.log(chalk.green('✅ ' + result));
}

async function testGenerateStyle() {
    console.log(chalk.cyan('🎨 Тест генерации стилей...'));
    const css = `
        body {
            font-family: 'Arial', sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
        }
        .page {
            background: white;
            padding: 40px;
            max-width: 800px;
            margin: 0 auto;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #2c3e50;
            border-bottom: 3px solid #3498db;
            padding-bottom: 10px;
        }
        img {
            max-width: 100%;
            height: auto;
            display: block;
            margin: 20px auto;
        }
    `;
    const result = await pdfGen.generateStyle(css);
    console.log(chalk.green('✅ ' + result));
}

async function testGeneratePage() {
    console.log(chalk.cyan('📄 Тест генерации страницы...'));
    const html = `
        <div class="page">
            <h1>Тестовая страница</h1>
            <p>Это тестовая страница для проверки функционала pdfGen.</p>
            <p>Здесь может быть любой HTML контент.</p>
        </div>
    `;
    const result = await pdfGen.generatePage(html, 0);
    console.log(chalk.green('✅ ' + result));
}

async function testBuildDoc() {
    console.log(chalk.cyan('📚 Тест сборки PDF документа...'));
    const result = await pdfGen.buildDoc();
    console.log(chalk.green('✅ ' + result));
}

async function testSmartPageBreaks() {
    console.log(chalk.cyan('🔧 Тест применения умных разрывов страниц...'));
    const result = await pdfGen.applySmartPageBreaks();
    console.log(chalk.green('✅ ' + result));
}

async function testAll() {
    console.log(chalk.yellow('🔧 Запуск полного тестирования...\n'));
    
    await testGenerateStyle();
    console.log();
    
    await testGenerateImage();
    console.log();
    
    await testGeneratePage();
    console.log();
    
    await testBuildDoc();
}

try {
    switch (command) {
        case 'image':
            await testGenerateImage();
            break;
        case 'style':
            await testGenerateStyle();
            break;
        case 'page':
            await testGeneratePage();
            break;
        case 'build':
            await testBuildDoc();
            break;
        case 'breaks':
            await testSmartPageBreaks();
            break;
        case 'all':
            await testAll();
            break;
        default:
            console.log(chalk.yellow('Использование:'));
            console.log(chalk.gray('  node test.js [command]'));
            console.log();
            console.log(chalk.yellow('Команды:'));
            console.log(chalk.gray('  build  - Собрать PDF из существующих HTML страниц (по умолчанию)'));
            console.log(chalk.gray('  breaks - Применить умные разрывы страниц к существующим файлам'));
            console.log(chalk.gray('  image  - Тест генерации изображения'));
            console.log(chalk.gray('  style  - Тест генерации стилей'));
            console.log(chalk.gray('  page   - Тест генерации страницы'));
            console.log(chalk.gray('  all    - Запустить все тесты'));
            process.exit(1);
    }
    
    console.log(chalk.green('\n✅ Тестирование завершено успешно!\n'));
    process.exit(0);
} catch (error) {
    console.error(chalk.red('\n❌ Ошибка при тестировании:'));
    console.error(chalk.red(error.message));
    if (error.stack) {
        console.error(chalk.gray('\nStack trace:'));
        console.error(chalk.gray(error.stack));
    }
    process.exit(1);
}

