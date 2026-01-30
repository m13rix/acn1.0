import { countdown } from './timer.js';
import chalk from 'chalk';

/**
 * Retry utility for handling temporary failures
 */
export class RetryHandler {
  constructor() {
    this.maxRetries = 3; // Only retry once for 503 errors
    this.retryDelay = 60; // Wait 60 seconds before retry
  }

  /**
   * Execute a function with retry logic for 503 errors
   * @param {Function} fn - Function to execute
   * @param {string} operation - Description of the operation
   * @returns {Promise<any>} Result of the function
   */
  async executeWithRetry(fn, operation = 'API call') {
    let lastError;
    
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        // Check if this is a retryable error
        if (this.isRetryableError(error) && attempt <= this.maxRetries) {
          console.log(chalk.yellow(`\n⚠️  ${operation} failed (attempt ${attempt}/${this.maxRetries + 1})`));
          console.log(chalk.gray(`   Error: ${error.message}`));
          console.log(chalk.blue(`   Retrying in ${this.retryDelay} seconds...`));
          
          await countdown(this.retryDelay, `Retrying ${operation}`);
          continue;
        }
        
        // If not retryable or max retries reached, throw the error
        throw error;
      }
    }
    
    throw lastError;
  }

  /**
   * Check if error is retryable
   * @param {Error} error - Error to check
   * @returns {boolean} True if error is retryable
   */
  isRetryableError(error) {
    // Check for 503 status code
    if (error.response && error.response.status === 503) {
      return true;
    }
    
    // Check for 429 status code (Rate Limit) - check both response.status and direct status
    if ((error.response && error.response.status === 429) || error.status === 429) {
      return true;
    }
    
    // Check error name/type for RateLimitError
    if (error.name === 'RateLimitError' || error.constructor?.name === 'RateLimitError') {
      return true;
    }
    
    // Check for specific error messages that indicate temporary issues
    const retryableMessages = [
      'service unavailable',
      'temporarily unavailable',
      'rate limit exceeded',
      'ratelimiterror',
      'too many requests',
      'server overloaded',
      '503',
      '429',
      '429 status code',
      'service temporarily unavailable'
    ];
    
    const errorMessage = error.message?.toLowerCase() || '';
    return retryableMessages.some(msg => errorMessage.includes(msg));
  }
}

/**
 * Create a retry handler instance
 * @returns {RetryHandler}
 */
export function createRetryHandler() {
  return new RetryHandler();
}
