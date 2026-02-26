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
        const diffToMonday = startDay === 0 ? -6 : 1 - startDay; // if sunday, go back 6 days, else go back (day - 1)

        startDate.setDate(startDate.getDate() + diffToMonday);
        startDate.setHours(0, 0, 0, 0);

        const endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6);
        endDate.setHours(23, 59, 59, 999);

        console.log("Fetching from", startDate, "to", endDate);
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
        console.error(e);
    }
})();
