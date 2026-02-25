import { ask, generateSVG, formatHomework } from './tools/homework/index.js';
import fs from 'fs/promises';

async function test() {
    try {
        console.log("Тест: Запрашиваем несуществующий ID...");
        try {
            await ask("invalid_id", "test");
            console.error("❌ Ошибка: Не выброшено исключение для неверного ID");
        } catch (e: any) {
            console.log("✅ Корректно выброшено исключение для неверного ID:", e.message);
        }

        console.log("\nТест: Запрашиваем algebra...");
        // Мы не ожидаем, что у вас есть загруженный стор algebra, но если хотя бы функция попытается запуститься
        // или кинет ошибку, что стор не найден - это тоже успешное прохождение логики.
        try {
            const res = await ask("algebra", "Тестовый запрос");
            console.log("✅ Успешный ответ:", res);
        } catch (e: any) {
            if (e.message.includes("не найден в File Search Store")) {
                console.log("✅ Ожидаемая ошибка (учебник не загружен):", e.message);
            } else {
                console.error("❌ Неожиданная ошибка:", e);
            }
        }

        console.log("\nТест: generateSVG...");
        try {
            const svg = await generateSVG("В треугольнике ABC угол C равен 90 градусов. AC = 10, BC = 24. Покажи рисунок.");
            if (svg && svg.includes("<svg")) {
                console.log("✅ Успешно сгенерирован SVG:", svg.substring(0, 100) + '...');
            } else {
                console.error("❌ SVG не получен или некорректен:", svg);
            }
        } catch (e: any) {
            console.error("❌ Ошибка generateSVG:", e);
        }

        console.log("\nТест: formatHomework...");
        try {
            const formatTestContent = `Дано:
АD = 8
DС = 28
<svg xmlns="http://www.w3.org/2000/svg">...</svg>
Решение:
_тут решение_
Ответ: 112`;
            const resultFile = "test_output_homework.txt";
            const formatted = await formatHomework(formatTestContent, resultFile);
            console.log("✅ Успешно отформатировано:\n", formatted.substring(0, 200) + '...');

            // Проверим, что файл создался
            const stat = await fs.stat(resultFile);
            if (stat.isFile()) {
                console.log("✅ Файл успешно создан:", resultFile);
                await fs.unlink(resultFile); // убираем за собой
            }
        } catch (e: any) {
            console.error("❌ Ошибка formatHomework:", e);
        }

    } catch (error) {
        console.error("❌ Тест сломан:", error);
    }
}
test();
