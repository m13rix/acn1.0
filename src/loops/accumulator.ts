/**
 * Accumulator Loop
 * 
 * This loop type accumulates all agent output in a single assistant message.
 * 
 * Flow:
 * 1. User sends message
 * 2. Agent responds (may include actions)
 * 3. If action found, execute and append observation to assistant message
 * 4. Send continuation with "Complete the user request" as user message
 * 5. Repeat until no action in response
 * 
 * Stop sequence: </action> - prevents hallucinated observations
 */

import { BaseLoop, registerLoop } from './base.js';
import type { ProcessedResponse, SyntaxType } from '../types/index.js';

export class AccumulatorLoop extends BaseLoop {
  name = 'accumulator';
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
    syntax: SyntaxType
  ): { updatedAssistantContent: string; continuationUserMessage: string } {
    // Determine which tag was cut off by stop sequence
    // Check if CLI tag is present (and not closed) - it would be the last one
    const hasCli = syntax.hasCli(currentAssistantContent);
    const hasAction = syntax.hasAction(currentAssistantContent);
    
    // Determine closing tag based on which unclosed tag is present
    // CLI takes precedence if both somehow exist (shouldn't happen due to stop sequences)
    let closingTag: string;
    if (hasCli && !currentAssistantContent.includes('</cli>')) {
      closingTag = '</cli>';
    } else if (hasAction && !currentAssistantContent.includes('</action>')) {
      closingTag = '</action>';
    } else {
      // Fallback - shouldn't happen
      closingTag = '</action>';
    }
    
    // Complete the tag that was cut off by stop sequence
    // and append the observation
    const updatedAssistantContent = 
      currentAssistantContent + 
      closingTag + '\n' + 
      syntax.wrapObservation(observation);
    
    // The continuation message prompts the agent to continue
    const continuationUserMessage = '<system>Continue your answer</system>';
    
    return {
      updatedAssistantContent,
      continuationUserMessage,
    };
  }
  
  getDescription(): string {
    return `## Loop (accumulator)

- Write everything in a single assistant message.
- If you need to run code, output \`<action>...</action>\` and stop at \`</action>\`.
- If you need to run a shell command, output \`<cli>...</cli>\` and stop at \`</cli>\`.
- The system will execute and append \`<obs>...</obs>\` automatically.
- When you are ready to answer, respond normally (no tags).`;
  }
}

// Register the loop
registerLoop('accumulator', () => new AccumulatorLoop());

export default AccumulatorLoop;
