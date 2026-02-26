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

        console.log("Fetching student/diary/init...");
        const initRes = await user.client.get("student/diary/init");
        const initData = await initRes.json();

        for (const student of initData.students) {
            console.log("Fetching diary for", student.nickName, "(ID:", student.studentId, ")");

            const diary = await user.diary({ studentId: student.studentId });
            console.log("diary days:", diary.days?.length);
            if (diary.days && diary.days.length > 0) {
                console.log("  First subject on first day:", diary.days[0].lessons[0]?.subject);
            }
        }

    } catch (e) {
        console.error(e);
    }
})();
