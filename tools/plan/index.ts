/**
 * Plan Tool
 * 
 * System tool for managing sub-agents.
 * Implementation is injected by PlannerExecutor into the runtime environment.
 * These exports are for interface reference.
 */

export async function createSubAgent(name: string, config: any): Promise<void> {
    throw new Error('This tool is a system tool and should be injected by the runtime.');
}

export async function switchSubAgent(name: string): Promise<void> {
    throw new Error('This tool is a system tool and should be injected by the runtime.');
}
