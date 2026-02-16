/**
 * Passthrough Reminder Loop
 *
 * This loop type is a variant of message-passthrough that adds a reminder of the
 * original user request to every observation message, to help smaller LLMs
 * stay on track.
 */

import { BaseLoop, registerLoop } from './base.js';
import type { ProcessedResponse, SyntaxType } from '../types/index.js';

export class PassthroughReminderLoop extends BaseLoop {
    name = 'passthrough-reminder';
    override stopSequences = ['</action>', '</cli>'];

    processResponse(response: string, syntax: SyntaxType): ProcessedResponse {
        const hasAction = syntax.hasAction(response);
        const hasCli = syntax.hasCli(response);

        if (!hasAction && !hasCli) {
            // No action or CLI - this is the final response
            return {
                hasAction: false,
                actionCode: null,
                hasCli: false,
                cliCommand: null,
                filesToWrite: [],
                diffs: [],
                edits: [],
                fullResponse: response,
            };
        }

        // Extract the action code or CLI command
        const actionCode = hasAction ? syntax.getAction(response) : null;
        const cliCommand = hasCli ? syntax.getCli(response) : null;

        return {
            hasAction,
            actionCode,
            hasCli,
            cliCommand,
            filesToWrite: [],
            diffs: [],
            edits: [],
            fullResponse: response,
        };
    }

    buildContinuationMessages(
        currentAssistantContent: string,
        observation: string,
        syntax: SyntaxType,
        filename?: string,
        originalUserRequest?: string
    ): { updatedAssistantContent: string; continuationUserMessage: string } {
        // Complete the action tag that was cut off by stop sequence
        const hasCli = syntax.hasCli(currentAssistantContent);
        const hasAction = syntax.hasAction(currentAssistantContent);

        // Determine closing tag based on which unclosed tag is present
        let closingTag: string;
        if (hasCli && !currentAssistantContent.includes('</cli>')) {
            closingTag = '</cli>';
        } else if (hasAction && !currentAssistantContent.includes('</action>')) {
            closingTag = '</action>';
        } else {
            closingTag = '</action>';
        }

        // Complete the assistant message with the closing tag
        const updatedAssistantContent = currentAssistantContent + closingTag;

        // Format observation with filename prefix if available
        const formattedObservation = filename
            ? `${filename}:\n${observation}`
            : observation;

        // Wrap the observation
        let continuationUserMessage = syntax.wrapObservation(formattedObservation);

        // Append the last real user request as a reminder
        if (originalUserRequest) {
            continuationUserMessage += '\n' + originalUserRequest;
        }

        return {
            updatedAssistantContent,
            continuationUserMessage,
        };
    }

    override shouldCommitMessagesAfterAction(): boolean {
        return true;
    }

    getDescription(): string {
        return `## Loop 

- If you need to run code, output \`<action>...</action>\` and stop at \`</action>\`.
- If you need to run a shell command, output \`<cli>...</cli>\` and stop at \`</cli>\`.
- The system will execute the action and send the result as \`<obs>...</obs>\` followed by your original request as a reminder in a new user message.
- Respond to the observation in your next message.`;
    }
}

// Register the loop
registerLoop('passthrough-reminder', () => new PassthroughReminderLoop());

export default PassthroughReminderLoop;
