const NS = require("netschoolapi").default;
const util = require("util");
const user = new NS({ origin: "https://sgo.rso23.ru/", login: "ГильгенбергЭ", password: "130480", school: "МАОУ СОШ №34" });

(async function () {
    try {
        await user.logIn();
        const context = await user.contextAsync;
        console.log(util.inspect(context.user, { depth: null, colors: true }));
        console.log("students", context.students);
    } catch (e) { console.error(e); }
})();
