const NS = require("netschoolapi").default;
const user = new NS({
    origin: "https://sgo.rso23.ru/",
    login: "ГильгенбергЭ",
    password: "130480",
    school: "МАОУ СОШ №34",
});

(async function () {
    try {
        const startDate = new Date();
        const startDay = startDate.getDay();
        const diffToMonday = startDay === 0 ? -6 : 1 - startDay;

        startDate.setDate(startDate.getDate() + diffToMonday);

        // ВАЖНО: устанавливаем время в UTC, чтобы toJSON() дата не съехала на предыдущий день!
        startDate.setUTCHours(12, 0, 0, 0);
        console.log("UTC Date start:", startDate.toJSON());

        const endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6);
        console.log("UTC Date end:", endDate.toJSON());

        const diary = await user.diary({ start: startDate, end: endDate });
        console.log("diary days:", diary.days?.length);
        if (diary.days && diary.days.length > 0) {
            for (const day of diary.days) {
                console.log(`\nДень: ${day.date ? day.date.toLocaleDateString() : '?'}`);
                for (const lesson of day.lessons) {
                    console.log(`  ${lesson.subject}`);
                }
            }
        }

    } catch (e) {
        console.error(e);
    }
})();
