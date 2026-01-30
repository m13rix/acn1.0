/**
 * Base provider class for LLM integrations
 */
export class BaseProvider {
  constructor(apiKey, model) {
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * Check if error is retryable (503 Service Unavailable)
   * @param {Error} error - Error to check
   * @returns {boolean} True if error is retryable
   */
  isRetryableError(error) {
    // Check for 503 status code
    if (error.response && error.response.status === 503) {
      return true;
    }
    
    // Check for specific error messages that indicate temporary issues
    const retryableMessages = [
      'service unavailable',
      'temporarily unavailable',
      'rate limit exceeded',
      'too many requests',
      'server overloaded'
    ];
    
    const errorMessage = error.message?.toLowerCase() || '';
    return retryableMessages.some(msg => errorMessage.includes(msg));
  }

  /**
   * Chat with the LLM
   * @param {Array} messages - Array of message objects
   * @param {Object} options - Additional options
   * @param {number} options.temperature - Temperature setting
   * @param {string} options.systemPrompt - System prompt
   * @param {Function} options.onChunk - Callback for streaming chunks
   * @param {Function} options.onReasoning - Callback for chain-of-thought reasoning chunks
   * @param {Array<string>} options.stopSequences - Stop sequences
   * @returns {Promise<string>} Complete response
   */
  async chat(messages, options = {}) {
    throw new Error('chat() must be implemented by provider subclass');
  }

  /**
   * Format messages for the provider
   * @param {Array} messages - Messages to format
   * @param {string} systemPrompt - System prompt
   * @param {Array} attachments - Attachments (default implementation appends text files to user content)
   * @returns {Array} Formatted messages
   */
  formatMessages(messages, systemPrompt, attachments = []) {
    // Default implementation:
    // 1. Add system prompt
    // 2. Copy messages
    // 3. For the last user message, append content of text-based attachments
    // Note: Binary attachments (images, etc.) are ignored in the base implementation
    
    const formatted = systemPrompt 
      ? [{ role: 'system', content: systemPrompt }]
      : [];

    for (const msg of messages) {
      // Check if this is the last user message and we have attachments
      const isLast = msg === messages[messages.length - 1];
      const hasAttachments = isLast && attachments && attachments.length > 0;
      
      if (isLast && msg.role === 'user' && hasAttachments) {
        let newContent = msg.content || '';
        
        // Append text attachments
        const textAttachments = attachments.filter(att => 
          att.type.startsWith('text/') || 
          att.type === 'application/json' || 
          att.type === 'application/javascript' ||
          att.name.endsWith('.js') ||
          att.name.endsWith('.ts') ||
          att.name.endsWith('.py') ||
          att.name.endsWith('.md') ||
          att.name.endsWith('.txt')
        );

        if (textAttachments.length > 0) {
          newContent += '\n\n--- Attached Context Files ---\n';
          for (const att of textAttachments) {
            try {
              const base64 = att.dataUrl.split(',')[1];
              const textContent = Buffer.from(base64, 'base64').toString('utf-8');
              newContent += `\nFile: ${att.name}\n\`\`\`\n${textContent}\n\`\`\`\n`;
            } catch (e) {
              console.error(`Failed to decode attachment ${att.name}: ${e.message}`);
            }
          }
          newContent += '\n--- End of Attached Files ---\n';
        }
        
        formatted.push({ ...msg, content: newContent });
      } else {
        formatted.push(msg);
      }
    }
    
    return formatted;
  }
}

