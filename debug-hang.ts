console.log('Starting debug-hang.ts');
import { getAvailableProviders } from './src/providers/base.js';
import './src/providers/index.js';
console.log('Available providers:', getAvailableProviders());
console.log('Done!');
