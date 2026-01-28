/**
 * Message Passthrough Loop
 *
 * This loop type wraps tool results in syntax and passes them as user messages.
 *
 * Flow:
 * 1. User sends message
 * 2. Agent responds (may include actions)
 * 3. If action found, execute and wrap result in <obs>...</obs>
 * 4. Add wrapped observation as a NEW user message
 * 5. Agent responds to the observation as a user message
 * 6. Repeat until no action in response
 *
 * Stop sequence: </action> - prevents hallucinated observations
 */

import { BaseLoop, registerLoop } from './base.js';
import type { ProcessedResponse, SyntaxType } from '../types/index.js';

export class MessagePassthroughLoop extends BaseLoop {
  name = 'message-passthrough';
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
        fullResponse: response,
      };
    }

    // Extract the action code or CLI command
    // Note: The response may be cut off by stop sequence, so we extract what we have
    const actionCode = hasAction ? syntax.getAction(response) : null;
    const cliCommand = hasCli ? syntax.getCli(response) : null;

    return {
      hasAction,
      actionCode,
      hasCli,
      cliCommand,
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
      // Fallback - shouldn't happen
      closingTag = '</action>';
    }

    // Complete the assistant message with the closing tag (no observation appended)
    const updatedAssistantContent = currentAssistantContent + closingTag;

    // Format observation with filename prefix if available
    const formattedObservation = filename
      ? `${filename}:\n${observation}`
      : observation;

    // The observation will be added as a separate user message by the Executor
    // Here we return it as the continuation user message
    const continuationUserMessage = syntax.wrapObservation(formattedObservation);

    return {
      updatedAssistantContent,
      continuationUserMessage,
    };
  }

  override shouldCommitMessagesAfterAction(): boolean {
    return true;
  }

  getDescription(): string {
    return `## Loop (message-passthrough)

- If you need to run code, output \`<action>...</action>\` and stop at \`</action>\`.
- If you need to run a shell command, output \`<cli>...</cli>\` and stop at \`</cli>\`.
- The system will execute the action and send the result as \`<obs>...</obs>\` in a new user message.
- Respond to the observation in your next message.`;
  }
}

// Register the loop
registerLoop('message-passthrough', () => new MessagePassthroughLoop());

export default MessagePassthroughLoop;
