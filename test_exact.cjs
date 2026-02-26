const NS = require("netschoolapi").default;
const user = new NS({ origin: "https://sgo.rso23.ru/", login: "ГильгенбергЭ", password: "130480", school: "МАОУ СОШ №34" });

(async function () {
    try {
        await user.logIn();
        const initData = await user.client.get("student/diary/init").then(r => r.json());
        const weekStartStr = initData.weekStart; // "2026-02-25T00:00:00+03:00"

        const start = new Date(weekStartStr);
        const end = new Date(weekStartStr);
        end.setDate(end.getDate() + 7);

        const d = await user.client.get("student/diary", {
            params: {
                yearId: user.context.year.id,
                studentId: initData.students[0].studentId,
                weekStart: start.toJSON().replace(/T.+/, ""),
                weekEnd: end.toJSON().replace(/T.+/, "")
            }
        }).then(r => r.json());

        console.log("Diary with exact init weekStart:", start.toJSON().replace(/T.+/, ""), "-", end.toJSON().replace(/T.+/, ""));
        console.log("Term:", d.termName, "Class:", d.className);
        console.log("Days:", d.weekDays?.length);

    } catch (e) { console.error(e); }
})();
