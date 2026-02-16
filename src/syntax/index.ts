/**
 * Syntax exports
 */

export * from './base.js';
export { XMLTagsSyntax } from './xml-tags.js';
export { MarkdownSyntax } from './markdown.js';

// Import to register syntax types
import './xml-tags.js';
import './markdown.js';
