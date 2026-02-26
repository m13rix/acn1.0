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
        console.log("initData:", initData);

        const startDate = new Date(initData.weekStart);
        const endDate = new Date(initData.weekStart);
        endDate.setDate(endDate.getDate() + 7);

        console.log("Fetching student/diary...");
        const diaryRaw = await user.client.get("student/diary", {
            params: {
                yearId: context.year.id,
                studentId: user.session.userId,
                weekEnd: endDate.toJSON().replace(/T.+/, ""),
                weekStart: startDate.toJSON().replace(/T.+/, ""),
            },
        });
        const diaryData = await diaryRaw.json();
        console.log("diary keys:", Object.keys(diaryData));
        if (diaryData.weekDays) {
            console.log("weekDays length:", diaryData.weekDays.length);
        } else {
            console.log("No weekDays in diaryData");
            console.log(initData);
        }

    } catch (e) {
        console.error(e);
    }
})();
