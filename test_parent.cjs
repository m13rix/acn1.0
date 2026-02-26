const NS = require("netschoolapi").default;
const user = new NS({ origin: "https://sgo.rso23.ru/", login: "ГильгенбергЭ", password: "130480", school: "МАОУ СОШ №34" });

(async function () {
    try {
        await user.logIn();
        try {
            const pb = await user.client.get("parent/diary/init");
            console.log("parent/diary/init:", await pb.text());
        } catch (e) { console.log("parent/diary/init failed"); }

        try {
            const pb2 = await user.client.get("student/diary/init");
            const d = await pb2.json();
            console.log("student/diary/init currentStudentId:", d.currentStudentId);

            // Try to set currentStudentId using some endpoint?
            // Nothing obvious. What if we pass studentId as a query param to student/diary/init?
            const pb3 = await user.client.get("student/diary/init", { params: { studentId: d.students[0].studentId } });
            console.log("student/diary/init with studentId:", await pb3.text().then(t => t.slice(0, 100)));
        } catch (e) { console.log("student/diary/init issue", e); }
    } catch (e) { console.error(e); }
})();
