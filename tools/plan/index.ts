import * as fs from 'fs';
import * as path from 'path';

/**
 * Add a command to the .plan-commands.json file for the PlannerExecutor to process.
 */
function addCommand(command: any) {
    const sandboxDir = process.cwd();
    const commandFile = path.join(sandboxDir, '.plan-commands.json');

    let commands: any[] = [];
    try {
        if (fs.existsSync(commandFile)) {
            commands = JSON.parse(fs.readFileSync(commandFile, 'utf-8'));
        }
    } catch (e) {
        // If file is corrupted or can't be read, start fresh
    }

    commands.push(command);
    fs.writeFileSync(commandFile, JSON.stringify(commands, null, 2), 'utf-8');
}

/**
 * Create a new sub-agent with the given configuration.
 */
export async function createSubAgent(name: string, config: any): Promise<void> {
    console.log(`[Plan] Queueing sub-agent creation: ${name}`);
    addCommand({ type: 'createSubAgent', name, config });
}

/**
 * Switch to a different sub-agent (or 'default').
 */
export async function switchSubAgent(name: string): Promise<void> {
    console.log(`[Plan] Queueing switch to sub-agent: ${name}`);
    addCommand({ type: 'switchSubAgent', name });
}
