const NS = require("netschoolapi").default;
const user = new NS({ origin: "https://sgo.rso23.ru/", login: "ГильгенбергЭ", password: "130480", school: "МАОУ СОШ №34" });

(async function () {
    try {
        await user.logIn();
        const info = await user.info();

        console.log("TRYING GET request to DayViewS.asp");
        try {
            const res = await user.client.get("../asp/Calendar/DayViewS.asp");
            console.log("GET length:", await res.text().then(t => t.length));
        } catch (e) { console.log("GET failed", e.message); }

        console.log("TRYING POST DayViewS.asp without PCLID");
        try {
            const Client = require("netschoolapi/dist/classes/Client").default;
            const res = await user.client.post("../asp/Calendar/DayViewS.asp", Client.formData({
                at: user.session.accessToken,
                ver: user.session.ver,
                date: "24.02.2026",
            }));
            console.log("POST length:", await res.text().then(t => t.length));
        } catch (e) { console.log("POST failed", e.message); }

    } catch (e) { console.error(e); }
})();
