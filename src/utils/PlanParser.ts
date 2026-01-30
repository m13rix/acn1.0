
import { SyntaxType } from '../types/index.js';

export interface PlanStep {
    originalText: string;
    actions: string[]; // Code extracted from action tags
    cli: string[];     // Commands extracted from cli tags
    instruction: string; // Text content stripped of action and cli tags
}

export interface ParsedPlan {
    immediateActions: string[]; // Actions found before any numbered steps
    immediateCli: string[];     // CLI commands found before any numbered steps
    steps: PlanStep[];
    rawText: string;
}

export class PlanParser {
    /**
     * Parse planner output into immediate actions and a list of steps.
     */
    static parse(text: string, syntax: SyntaxType): ParsedPlan {
        // We use the syntax object to get text without thoughts for consistency
        // Note: XMLTagsSyntax.stripThoughts is private, but getAction etc. already handle it.
        // However, for splitting into lines, we might want a clean version.
        // We'll rely on our generic stripping since it's safe for splitting.
        let textToParse = text.replace(/<(think|thought)>[\s\S]*?<\/(think|thought)>/gi, '');
        textToParse = textToParse.replace(/<(think|thought)>[\s\S]*$/gi, '');

        const lines = textToParse.split('\n');
        const steps: PlanStep[] = [];
        let currentStep: Partial<PlanStep> | null = null;
        let preamble = '';

        const stepRegex = /^(\d+)[\.\)]\s+(.*)/;

        const finalizeStep = () => {
            if (currentStep && currentStep.originalText) {
                const fullText = currentStep.originalText;
                const actions: string[] = [];
                const cliCommands: string[] = [];

                // Use non-greedy regex that allows optional closing tag at the end of input
                const actionRegex = /<action>([\s\S]*?)(?:<\/action>|$)/gi;
                const cliRegex = /<cli>([\s\S]*?)(?:<\/cli>|$)/gi;
                let match;

                while ((match = actionRegex.exec(fullText)) !== null) {
                    if (match[1]) actions.push(match[1].trim());
                }
                while ((match = cliRegex.exec(fullText)) !== null) {
                    if (match[1]) cliCommands.push(match[1].trim());
                }

                const instruction = fullText.replace(/<action>[\s\S]*?(?:<\/action>|$)/gi, '')
                    .replace(/<cli>[\s\S]*?(?:<\/cli>|$)/gi, '')
                    .trim();

                steps.push({
                    originalText: fullText.trim(),
                    actions,
                    cli: cliCommands,
                    instruction
                });
            }
        };

        let foundFirstStep = false;
        for (const line of lines) {
            const match = line.match(stepRegex);
            if (match) {
                finalizeStep();
                foundFirstStep = true;
                currentStep = { originalText: match[2] };
            } else if (foundFirstStep && currentStep) {
                currentStep.originalText += '\n' + line;
            } else {
                preamble += line + '\n';
            }
        }
        finalizeStep();

        // Immediate items (preamble)
        const immediateActions: string[] = [];
        const immediateCli: string[] = [];

        const actionRegex = /<action>([\s\S]*?)(?:<\/action>|$)/gi;
        const cliRegex = /<cli>([\s\S]*?)(?:<\/cli>|$)/gi;
        let match;
        while ((match = actionRegex.exec(preamble)) !== null) {
            if (match[1]) immediateActions.push(match[1].trim());
        }
        while ((match = cliRegex.exec(preamble)) !== null) {
            if (match[1]) immediateCli.push(match[1].trim());
        }

        return {
            immediateActions,
            immediateCli,
            steps,
            rawText: text
        };
    }
}
