const NS = require("netschoolapi").default;
const user = new NS({
    origin: "https://sgo.rso23.ru/",
    login: "ГильгенбергЭ",
    password: "130480",
    school: "МАОУ СОШ №34",
});

(async function () {
    try {
        const diary = await user.diary({}); // empty object will trigger the `else` block
        console.log("diary days:", diary.days?.length);
        if (diary.days && diary.days.length > 0) {
            for (const day of diary.days) {
                console.log(`\nДень: ${day.date ? day.date.toLocaleDateString() : '?'}`);
                for (const lesson of day.lessons) {
                    console.log(`  ${lesson.subject}`);
                }
            }
        } else {
            console.log("No days found");
        }
    } catch (e) {
        console.error(e);
    }
})();
