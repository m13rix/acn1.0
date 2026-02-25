import 'dotenv/config';
import { start, stop, getContext } from './tools/heartbeat/sensors/notes/index.js';

async function main() {
    console.log('Testing Notes Sensor...');

    await start((event, payload) => {
        console.log(`\n\n[EMITTED]: ${event}`);
        getContext().then(ctx => {
            console.log('--- Context Start ---');
            console.log(ctx);
            console.log('--- Context End ---');

            // Stop after one event
            stop();
            process.exit(0);
        });
    });

    console.log('Test script running. Waiting for a new note in OneNote...');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
