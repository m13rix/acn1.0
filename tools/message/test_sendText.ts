import { sendText } from './index.js';

async function test() {
    console.log('Testing sendText...');
    try {
        await sendText("Hello from sendText test! 🚀");
        console.log("✅ sendText executed successfully!");
    } catch (error) {
        console.error("❌ sendText failed:", error);
    }
}

test();
