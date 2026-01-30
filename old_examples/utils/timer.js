import chalk from 'chalk';

/**
 * Utility for creating beautiful countdown timers in CLI
 */
export class Timer {
  constructor() {
    this.isActive = false;
    this.intervalId = null;
  }

  /**
   * Start a countdown timer with visual feedback
   * @param {number} seconds - Number of seconds to count down
   * @param {string} message - Message to display during countdown
   * @param {Function} onComplete - Callback when timer completes
   * @returns {Promise<void>}
   */
  async start(seconds, message = 'Waiting', onComplete = null) {
    if (this.isActive) {
      throw new Error('Timer is already active');
    }

    this.isActive = true;
    let remaining = seconds;

    return new Promise((resolve) => {
      // Display initial message
      process.stdout.write(chalk.yellow(`\n⏳ ${message}... `));
      
      this.intervalId = setInterval(() => {
        if (remaining <= 0) {
          this.stop();
          process.stdout.write(chalk.green('✓ Done!\n'));
          if (onComplete) onComplete();
          resolve();
          return;
        }

        // Clear the line and rewrite with countdown
        process.stdout.write('\r');
        process.stdout.write(chalk.yellow(`⏳ ${message}... `));
        process.stdout.write(chalk.cyan(`${remaining}s`));
        
        remaining--;
      }, 1000);
    });
  }

  /**
   * Stop the timer
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isActive = false;
  }

  /**
   * Check if timer is currently active
   * @returns {boolean}
   */
  get active() {
    return this.isActive;
  }
}

/**
 * Create a simple countdown timer
 * @param {number} seconds - Seconds to wait
 * @param {string} message - Message to display
 * @returns {Promise<void>}
 */
export async function countdown(seconds, message = 'Waiting') {
  const timer = new Timer();
  return await timer.start(seconds, message);
}
