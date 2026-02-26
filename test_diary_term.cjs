const NS = require("netschoolapi").default;
const user = new NS({
    origin: "https://sgo.rso23.ru/",
    login: "ГильгенбергЭ",
    password: "130480",
    school: "МАОУ СОШ №34",
});

(async function () {
    try {
        const context = await user.contextAsync;

        // Fetch whole term diary
        const term = context.defaultTerm();
        console.log("Term start:", term.start, "end:", term.end);

        const diary = await user.diary({ start: term.start, end: term.end });
        console.log("diary days:", diary.days?.length);
        if (diary.days && diary.days.length > 0) {
            console.log("First day:", diary.days[0].date);
            console.log("Last day:", diary.days[diary.days.length - 1].date);
        } else {
            console.log("No days returned for the entire term.");
        }

    } catch (e) {
        console.error(e);
    }
})();
