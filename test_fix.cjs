const NS = require("netschoolapi").default;
const user = new NS({ origin: "https://sgo.rso23.ru/", login: "ГильгенбергЭ", password: "130480", school: "МАОУ СОШ №34" });

(async function () {
    try {
        await user.logIn();
        const context = await user.contextAsync;

        const classId = context.user.classes[0].id; // 3445555

        console.log("Fetching scheduleWeek directly for class", classId);

        const Client = require("netschoolapi/dist/classes/Client").default;
        const ScheduleWeek = require("netschoolapi/dist/classes/ScheduleWeek").default;
        const { date2str } = require("netschoolapi/dist/utils/dateNum");

        const date = new Date();
        const { accessToken: at, ver } = user.session;

        const htmlText = await user.client.post("../asp/Calendar/WeekViewTimeS.asp", Client.formData({
            at,
            ver,
            date: date2str(date),
            PCLID_IUP: classId + "_0",
            LoginType: 0,
        })).then(res => res.text());

        const scheduleWeek = new ScheduleWeek({ htmlText });
        console.log("Lines in scheduleWeek:", scheduleWeek.parsed?.length);
        if (scheduleWeek.parsed?.length > 0) {
            console.log(scheduleWeek.parsed[0]);
        }

    } catch (e) { console.error(e); }
})();
