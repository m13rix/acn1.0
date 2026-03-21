import axios from 'axios';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import * as fs from 'fs';
import * as path from 'path';

const API_BASE = 'https://torapi-test.vercel.app';

// Интерфейс для результатов поиска
interface TorrentResult {
    Provider: string;
    Name: string;
    Id: string;
    Url: string;
    Torrent: string;
    Size: string;
    Seeds: string;
    Peers: string;
}

async function main() {
    // Инициализация интерфейса чтения ввода из консоли
    const rl = readline.createInterface({ input, output });

    try {
        const query = await rl.question('🎬 Введите название фильма, сериала или игры для поиска: ');

        if (!query.trim()) {
            console.log('Пустой запрос. Выход.');
            return;
        }

        console.log('\n⏳ Ищем в TorAPI (по всем провайдерам)...');

        // В документации сказано, что можно использовать '+' вместо пробелов
        const formattedQuery = encodeURIComponent(query).replace(/%20/g, '+');
        const searchUrl = `${API_BASE}/api/search/title/all?query=${formattedQuery}&page=0&year=0`;

        const { data } = await axios.get(searchUrl);
        const choices: TorrentResult[] =[];

        // Обрабатываем ответ. Провайдеры могут вернуть массив с результатами или объект с ошибкой {"Result": "..."}
        for (const [provider, results] of Object.entries(data)) {
            if (Array.isArray(results)) {
                results.forEach((item: any) => {
                    choices.push({
                        Provider: provider,
                        Name: item.Name,
                        Id: item.Id,
                        Url: item.Url,
                        Torrent: item.Torrent,
                        Size: item.Size,
                        Seeds: item.Seeds,
                        Peers: item.Peers
                    });
                });
            }
        }

        if (choices.length === 0) {
            console.log('❌ Ничего не найдено.');
            return;
        }

        console.log('\n📋 Найденные источники:\n');
        choices.forEach((choice, index) => {
            console.log(`[${index + 1}][${choice.Provider}] ${choice.Name}`);
            console.log(`    💾 Размер: ${choice.Size} | 🔼 Сиды: ${choice.Seeds} | 🔽 Пиры: ${choice.Peers}`);
            console.log(`    🔗 URL: ${choice.Url}\n`);
        });

        const answer = await rl.question('👉 Введите номер источника для скачивания (или 0 для отмены): ');
        const selectedIndex = parseInt(answer.trim(), 10) - 1;

        if (selectedIndex === -1) {
            console.log('Отменено пользователем.');
            return;
        }

        if (selectedIndex >= 0 && selectedIndex < choices.length) {
            const selected = choices[selectedIndex];
            console.log(`\n⬇️  Скачивание .torrent файла для "${selected.Name}"...`);

            // Запрашиваем файл как поток данных (stream)
            const response = await axios({
                url: selected.Torrent,
                method: 'GET',
                responseType: 'stream'
            });

            // Создаем папку downloads, если её не существует
            const downloadsDir = path.join(process.cwd(), 'downloads');
            if (!fs.existsSync(downloadsDir)) {
                fs.mkdirSync(downloadsDir);
            }

            const fileName = `${selected.Provider}_${selected.Id}.torrent`;
            const filePath = path.join(downloadsDir, fileName);

            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            console.log(`\n✅ Файл успешно сохранен по пути: ${filePath}`);
        } else {
            console.log('❌ Неверный номер.');
        }

    } catch (error: any) {
        if (error.code === 'ECONNREFUSED') {
            console.error('\n❌ Ошибка: Не удалось подключиться к TorAPI. Убедитесь, что сервер запущен на localhost:8443.');
        } else {
            console.error('\n❌ Произошла ошибка:', error.message);
        }
    } finally {
        rl.close();
    }
}

main();
