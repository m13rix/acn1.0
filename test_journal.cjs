const NS = require("netschoolapi").default;
const util = require("util");

const user = new NS({
    origin: "https://sgo.rso23.ru/",
    login: "ГильгенбергЭ",
    password: "130480",
    school: "МАОУ СОШ №34",
});

(async function () {
    try {
        console.log("Авторизуемся...");
        const info = await user.info();
        console.log("info:", info.firstName, info.lastName);

        const context = await user.contextAsync;
        const currentTerm = context.defaultTerm();
        console.log("termId:", currentTerm.id);

        console.log("journal...");
        const journal = await user.journal({ termId: currentTerm.id });
        console.log("journal: success, subjects count:", journal.subjects?.length);

        console.log("schedule (via diary)...");
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - startDate.getDay() + 1); // Monday
        const endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6); // Sunday

        const diary = await user.diary({ start: startDate, end: endDate });
        console.log("diary days:", diary.days?.length);
        if (diary.days) {
            for (const day of diary.days) {
                console.log(`\nДень: ${day.date ? day.date.toLocaleDateString() : '?'}`);
                for (const lesson of day.lessons) {
                    console.log(`  ${lesson.subject}`);
                }
            }
        }

    } catch (e) {
        console.error("Error:", e);
    }
})();
