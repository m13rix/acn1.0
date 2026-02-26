const NS = require("netschoolapi").default;
const user = new NS({ origin: "https://sgo.rso23.ru/", login: "ГильгенбергЭ", password: "130480", school: "МАОУ СОШ №34" });

(async function () {
    try {
        await user.logIn();
        const initData = await user.client.get("student/diary/init").then(r => r.json());
        const studentId = initData.students[0].studentId;

        const context = await user.contextAsync;

        console.log("--- TRYING v2/student/diary ---");
        try {
            const v2 = await user.client.get("v2/student/diary", { params: { studentId, yearId: context.year.id, weekStart: "2026-02-23", weekEnd: "2026-03-01" } });
            const j2 = await v2.json();
            console.log("v2 length:", Object.keys(j2));
            console.log(j2);
        } catch (e) { console.log("Failed v2/student/diary"); }

    } catch (e) { console.error(e); }
})();
