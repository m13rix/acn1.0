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

        const initRes = await user.client.get("student/diary/init");
        const initData = await initRes.json();
        const studentId = initData.students[0].studentId;

        console.log("Checking weeks around current date for student", studentId);

        const now = new Date();
        const yearBase = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        yearBase.setDate(yearBase.getDate() - yearBase.getDay() + 1); // Monday of current week

        for (let weekOffset = -3; weekOffset <= 3; weekOffset++) {
            const start = new Date(yearBase);
            start.setDate(start.getDate() + weekOffset * 7);
            start.setUTCHours(12, 0, 0, 0);

            const end = new Date(start);
            end.setDate(end.getDate() + 6);

            const diary = await user.diary({ start, end, studentId });
            console.log(`Offset ${weekOffset} (${start.toJSON().split('T')[0]}): days = ${diary.days?.length}`);
            if (diary.days?.length > 0) {
                console.log(`  First lesson: ${diary.days[0].lessons[0]?.subject}`);
            }
        }

    } catch (e) {
        console.error(e);
    }
})();
