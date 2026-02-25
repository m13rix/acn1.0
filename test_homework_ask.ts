import { ask } from './tools/homework/index.js';

async function test() {
    try {
        console.log("Testing homework ask...");
        const result = await ask("algebra", "Выведи текст задания 585");
        console.log("✅ ask works!\nResult:\n", result);
        console.log("Length: ", result.length);
    } catch (error) {
        console.error("❌ ask failed:", error);
    }
}
test();
