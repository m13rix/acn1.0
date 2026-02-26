const NS = require("netschoolapi").default;
const user = new NS({ origin: "https://sgo.rso23.ru/", login: "ГильгенбергЭ", password: "130480", school: "МАОУ СОШ №34" });

(async function () {
    try {
        await user.logIn();
        const info = await user.info();
        const initData = await user.client.get("student/diary/init").then(r => r.json());
        const studentId = initData.students[0].studentId;
        console.log("studentId:", studentId);

        console.log("--- TRYING v2/student/diary ---");
        try {
            const v2 = await user.client.get("v2/student/diary", { params: { studentId, weekStart: "2026-02-23", weekEnd: "2026-03-01" } });
            console.log("v2 length:", await v2.text().then(t => t.length));
        } catch (e) { console.log("Failed v2/student/diary"); }

        console.log("--- TRYING diary without yearId ---");
        try {
            const d2 = await user.client.get("student/diary", { params: { studentId, weekStart: "2026-02-23", weekEnd: "2026-03-01" } });
            const j2 = await d2.json();
            console.log("d2 weekDays:", j2.weekDays?.length);
            console.log("d2 termName:", j2.termName);
        } catch (e) { console.log("Failed diary without yearId"); }

    } catch (e) { console.error(e); }
})();
