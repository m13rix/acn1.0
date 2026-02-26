const NS = require("netschoolapi").default;
const user = new NS({
    origin: "https://sgo.rso23.ru/",
    login: "ГильгенбергЭ",
    password: "130480",
    school: "МАОУ СОШ №34",
});

(async function () {
    try {
        await user.logIn();

        const context = await user.contextAsync;
        console.log("classes:", context.classes);

        if (context.classes && context.classes.length > 0) {
            for (const c of context.classes) {
                console.log("Fetching scheduleDay for class:", c.name, c.id);
                try {
                    const sDay = await user.scheduleDay({ classId: c.id });
                    console.log("  Lines:", sDay.lines?.length);
                } catch (e) {
                    console.error("  Error:", e.message);
                }
            }
        } else {
            console.log("No classes in context.");
        }

    } catch (e) {
        console.error(e);
    }
})();
