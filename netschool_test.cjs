const NS = require("netschoolapi").default;
const user = new NS({
    origin: "https://sgo.rso23.ru/", // Origin вашего сайта
    login: "ГильгенбергЭ", // Ваш логин
    password: "130480", // Ваш пароль
    school: "МАОУ СОШ №34", // Название вашей школы (как на сайте)
});

const util = require("util");

(async function () {
    try {
        console.log("Авторизация и получение данных...");
        const info = await user.info();
        console.log(`Пользователь: ${info.firstName} ${info.lastName}\n`);

        // Получаем контекст, чтобы узнать текущую четверть
        const context = await user.contextAsync;
        const currentTerm = context.defaultTerm();

        // Получаем оценки за текущую четверть через journal()
        // ВАЖНО: передаем именно currentTerm.id, так как defaultTerm() возвращает объект
        console.log(`=== ОЦЕНКИ ЗА ТЕКУЩУЮ ЧЕТВЕРТЬ (${currentTerm.name}) ===`);
        const journal = await user.journal({ termId: currentTerm.id });

        if (journal.range && journal.range.start && journal.range.end) {
            console.log(`Период: с ${journal.range.start.toLocaleDateString()} по ${journal.range.end.toLocaleDateString()}`);
        }

        if (journal.subjects) {
            journal.subjects.forEach(subject => {
                const marksArray = subject.marks ? subject.marks.map(m => m.mark) : [];
                console.log(`• ${subject.name} (Средний балл: ${subject.periodMiddleMark || 'нет'})`);
                if (marksArray.length > 0) {
                    console.log(`  Оценки: ${marksArray.join(", ")}`);
                }
            });
        } else {
            console.log("Нет данных по предметам.");
        }

        console.log("\n=========================================\n");

        // Получаем расписание за текущую неделю через дневник (diary)
        // Метод scheduleWeek на многих серверах СГО выдает ошибку 500
        console.log("=== РАСПИСАНИЕ НА ТЕКУЩУЮ НЕДЕЛЮ ===");
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - startDate.getDay() + 1); // Понедельник
        const endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6); // Воскресенье

        const diary = await user.diary({ start: startDate, end: endDate });

        if (diary.days && diary.days.length > 0) {
            diary.days.forEach(day => {
                console.log(`\n📅 ${day.date ? day.date.toLocaleDateString() : 'Неизвестная дата'}`);
                day.lessons.forEach(lesson => {
                    const markStr = lesson.assignments && lesson.assignments.some(a => a.mark)
                        ? ` [Оценка: ${lesson.assignments.find(a => a.mark).mark}]`
                        : '';
                    console.log(`  ${lesson.id || '-'}. ${lesson.subject}${markStr}`);
                });
            });
        } else {
            console.log("Расписание на эту неделю пусто (каникулы или не выгружено).");
        }

    } catch (e) {
        console.error("Произошла ошибка при получении данных:", e);
    }
})();
