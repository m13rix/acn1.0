/**
 * Pulse: The Heartbeat Logic Engine
 *
 * Responsible for:
 * 1. Taking context from a sensor
 * 2. Evaluating a condition (Micro-LLM) or just extracting variables
 * 3. Parsing the "TRUE >>> var1 >>> var2" format
 * 4. Mapping extracted variables to the Action template
 */

import { getProvider } from '../providers/base.js';
import { PulseResult } from './types.js';

export class Pulse {

    /**
     * Evaluate a condition against context using a specific Micro-LLM config.
     *
     * @param context - The sensor data (logs, time, etc.)
     * @param condition - The user's condition (e.g. "Is it urgent?"). If empty, treated as implicit TRUE.
     * @param actionTemplate - The action prompt string (used to extract required variables like {{sender}})
     * @param llmConfig - { model: string, provider: string }
     */
    static async evaluate(
        context: string,
        condition: string | undefined,
        actionTemplate: string,
        llmConfig: { model: string; provider: string }
    ): Promise<PulseResult> {

        // 1. Identify variables to extract from the action template
        // e.g. "Send message to {{sender}}: {{text}}" -> ['sender', 'text']
        const variableRegex = /{{(.*?)}}/g;
        const variablesToExtract: string[] = [];
        let match;
        while ((match = variableRegex.exec(actionTemplate)) !== null) {
            variablesToExtract.push(match[1].trim());
        }

        // If no condition and no variables, it's a simple trigger
        if (!condition && variablesToExtract.length === 0) {
            return { success: true, variables: {} };
        }

        // 2. Construct the Micro-Prompt
        const prompt = this.buildPrompt(context, condition, variablesToExtract);

        // 3. Call the Micro-LLM
        try {
            const provider = getProvider(llmConfig.provider);
            const response = await provider.complete([
                { role: 'system', content: 'You are a logic gate and data extractor. Reply strictly in the requested format.' },
                { role: 'user', content: prompt }
            ], {
                model: llmConfig.model,
                temperature: 0.1, // Precision is key
                maxTokens: 500
            });

            const content = response.content.trim();

            console.log(content);

            const result = this.parseResponse(content, variablesToExtract)
            console.log(result);
            // 4. Parse response
            return result;

        } catch (error: any) {
            console.error('[Pulse] Evaluation failed:', error);
            return { success: false, error: error.message };
        }
    }

    private static buildPrompt(context: string, condition: string | undefined, variables: string[]): string {
        let instructions = '';

        if (condition) {
            instructions += `CONDITION to check: "${condition}"\n\n`;
            instructions += `INSTRUCTIONS:\n`;
            instructions += `1. Analyze the Context below.\n`;
            instructions += `2. If the Condition is FALSE, reply exactly: "FALSE"\n`;
            instructions += `3. If the Condition is TRUE, reply exactly: "TRUE`;
        } else {
            // Implicit TRUE
            instructions += `INSTRUCTIONS:\n`;
            instructions += `1. Analyze the Context below.\n`;
            instructions += `2. Extract data. Reply exactly: "TRUE`;
        }

        // Variable extraction instructions
        if (variables.length > 0) {
            instructions += ` >>> [value for ${variables[0]}]`;
            for (let i = 1; i < variables.length; i++) {
                instructions += ` >>> [value for ${variables[i]}]`;
            }
            instructions += `"\n(Replace [value for ...] with the actual extracted string)`;
        } else {
            if (condition) instructions += `"\n`; // Just TRUE
        }

        return `${instructions}\n\nCONTEXT:\n${context}`;
    }

    private static parseResponse(response: string, variablesKeys: string[]): PulseResult {
        // Check for FALSE
        if (response.startsWith('FALSE')) {
            return { success: false };
        }

        if (!response.startsWith('TRUE')) {
            // Fallback: Model might have chitchatted. Treat as fail or try to find "TRUE"
            return { success: false, error: 'Invalid LLM response format' };
        }

        // Parse "TRUE >>> val1 >>> val2"
        // Remove "TRUE"
        const parts = response.split('>>>').map(p => p.trim());
        // parts[0] is "TRUE" (or empty if split consumes it)

        // Remove the first element "TRUE"
        parts.shift();

        const extractedVars: Record<string, string> = {};

        // map parts to keys
        for (let i = 0; i < variablesKeys.length; i++) {
            const key = variablesKeys[i];
            if (key) {
                const value = parts[i] || 'UNKNOWN'; // Fallback
                extractedVars[key] = value;
            }
        }

        return { success: true, variables: extractedVars };
    }

    /**
     * Replace {{variables}} in an Action template with actual values
     */
    static interpolate(actionTemplate: string, variables: Record<string, string>): string {
        let result = actionTemplate;
        for (const [key, value] of Object.entries(variables)) {
            result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
        }
        return result;
    }
}
