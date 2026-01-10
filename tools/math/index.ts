/**
 * Math Tool
 * 
 * Provides mathematical computation capabilities for agents.
 */

export interface Stats {
  mean: number;
  median: number;
  min: number;
  max: number;
  sum: number;
  count: number;
}

/**
 * Evaluate a mathematical expression
 * Note: Uses Function constructor - in production, use a proper math parser
 */
export function calculate(expression: string): number {
  console.log(`[Math] Calculating: ${expression}`);
  
  // Basic safety check - only allow math characters
  const sanitized = expression.replace(/[^0-9+\-*/().%\s^]/g, '');
  
  if (sanitized !== expression) {
    throw new Error('Expression contains invalid characters');
  }
  
  // Replace ^ with ** for exponentiation
  const normalized = sanitized.replace(/\^/g, '**');
  
  try {
    // Using Function constructor for evaluation
    // In production, use a proper math expression parser like mathjs
    const result = new Function(`return ${normalized}`)() as number;
    return result;
  } catch (error) {
    throw new Error(`Failed to evaluate expression: ${expression}`);
  }
}

/**
 * Calculate factorial
 */
export function factorial(n: number): number {
  console.log(`[Math] Factorial of ${n}`);
  
  if (n < 0) {
    throw new Error('Factorial is not defined for negative numbers');
  }
  
  if (n === 0 || n === 1) {
    return 1;
  }
  
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  
  return result;
}

/**
 * Check if a number is prime
 */
export function isPrime(n: number): boolean {
  console.log(`[Math] Checking if ${n} is prime`);
  
  if (n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  
  const sqrt = Math.sqrt(n);
  for (let i = 3; i <= sqrt; i += 2) {
    if (n % i === 0) return false;
  }
  
  return true;
}

/**
 * Generate Fibonacci sequence
 */
export function fibonacci(n: number): number[] {
  console.log(`[Math] Generating ${n} Fibonacci numbers`);
  
  if (n <= 0) return [];
  if (n === 1) return [0];
  if (n === 2) return [0, 1];
  
  const result = [0, 1];
  for (let i = 2; i < n; i++) {
    const prev1 = result[i - 1];
    const prev2 = result[i - 2];
    if (prev1 !== undefined && prev2 !== undefined) {
      result.push(prev1 + prev2);
    }
  }
  
  return result;
}

/**
 * Calculate statistics for an array of numbers
 */
export function statistics(numbers: number[]): Stats {
  console.log(`[Math] Calculating statistics for ${numbers.length} numbers`);
  
  if (numbers.length === 0) {
    throw new Error('Cannot calculate statistics for empty array');
  }
  
  const sorted = [...numbers].sort((a, b) => a - b);
  const sum = numbers.reduce((a, b) => a + b, 0);
  const count = numbers.length;
  const mean = sum / count;
  
  let median: number;
  const mid = Math.floor(count / 2);
  if (count % 2 === 0) {
    const midVal1 = sorted[mid - 1];
    const midVal2 = sorted[mid];
    median = (midVal1 !== undefined && midVal2 !== undefined) 
      ? (midVal1 + midVal2) / 2 
      : 0;
  } else {
    median = sorted[mid] ?? 0;
  }
  
  return {
    mean,
    median,
    min: sorted[0] ?? 0,
    max: sorted[count - 1] ?? 0,
    sum,
    count,
  };
}
