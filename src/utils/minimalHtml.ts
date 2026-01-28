/**
 * Minimal HTML Extraction Utility
 * 
 * Extracts a minimal, stripped-down version of the current page's HTML
 * for use as context for AI agents.
 */

import type { Page } from 'puppeteer';

/**
 * Extracts minimal HTML from a Puppeteer Page.
 * Removes scripts, styles, invisible elements, and heavy attributes.
 * 
 * @param page - The Puppeteer Page object
 * @returns The minimal HTML string
 */
export async function getMinimalHtml(page: Page): Promise<string> {
    // Use string-based evaluate to avoid TypeScript DOM type issues
    // The code inside runs in browser context where DOM types exist
    return await page.evaluate(`
        (function() {
            function cleanNode(node) {
                // Handle Text Nodes
                if (node.nodeType === Node.TEXT_NODE) {
                    if (node.textContent && node.textContent.trim().length > 0) {
                        return document.createTextNode(node.textContent.trim());
                    }
                    return null;
                }

                // Handle Element Nodes
                if (node.nodeType === Node.ELEMENT_NODE) {
                    const element = node;
                    const tagName = element.tagName.toLowerCase();

                    // 1. Remove Unwanted Tags
                    const blockedTags = [
                        'script', 'style', 'link', 'meta', 'noscript', 'iframe', 'svg',
                        'object', 'embed', 'applet', 'frame', 'frameset'
                    ];
                    if (blockedTags.includes(tagName)) {
                        return null;
                    }

                    // 2. Check Visibility
                    const style = window.getComputedStyle(element);
                    if (style.display === 'none' || style.visibility === 'hidden') {
                        return null;
                    }

                    // 3. Process Children First (Depth-First for Flattening)
                    const cleanChildren = [];
                    let hasContent = false;
                    let hasText = false;

                    Array.from(node.childNodes).forEach(function(child) {
                        const cleanedChild = cleanNode(child);
                        if (cleanedChild) {
                            cleanChildren.push(cleanedChild);
                            hasContent = true;
                            if (cleanedChild.nodeType === Node.TEXT_NODE) {
                                hasText = true;
                            }
                        }
                    });

                    // 4. Final Filter: Remove empty elements
                    const voidTags = ['img', 'input', 'br', 'hr', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr'];
                    if (!voidTags.includes(tagName) && !hasContent) {
                        return null;
                    }

                    // 5. Flattening Optimization
                    // If element has only ONE child which is an ELEMENT, and no text content itself,
                    // return the child directly, bypassing the wrapper.
                    // Exceptions: 
                    // - Important semantic tags (button, a, input, form, etc.) should not be skipped even if they just wrap something
                    // - Elements with ID (might be anchors)
                    // - Elements with significant attributes (like href, onclick handlers if we kept them)
                    const semanticTags = ['a', 'button', 'input', 'select', 'textarea', 'form', 'label', 'summary', 'details'];
                    const hasId = element.hasAttribute('id');
                    
                    if (
                        !semanticTags.includes(tagName) && 
                        !hasId && 
                        cleanChildren.length === 1 && 
                        cleanChildren[0].nodeType === Node.ELEMENT_NODE
                    ) {
                        return cleanChildren[0];
                    }


                    // 6. Create Element & Copy Attributes
                    const cleanEl = document.createElement(tagName);
                    
                    // Allowed attributes - removed 'class' to reduce noise
                    const allowedAttributes = [
                        'id', 'href', 'src', 'alt', 'title',
                        'type', 'value', 'placeholder', 'name',
                        'role', 'aria-label', 'aria-hidden', 'aria-expanded',
                        'checked', 'selected', 'disabled', 'readonly'
                    ];

                    Array.from(element.attributes).forEach(function(attr) {
                        const name = attr.name.toLowerCase();
                        const value = attr.value;

                        // Skip known junk
                        if (name.startsWith('on') || name.startsWith('data-') || name === 'jsaction' || name.startsWith('ng-')) {
                            return;
                        }

                        if (allowedAttributes.includes(name)) {
                            // Truncate huge values
                            if (value.length > 500 && name === 'src' && value.startsWith('data:')) {
                                cleanEl.setAttribute(name, value.substring(0, 50) + '...[truncated]');
                            } else if (value.length > 1000) {
                                cleanEl.setAttribute(name, value.substring(0, 50) + '...[truncated]');
                            } else {
                                cleanEl.setAttribute(name, value);
                            }
                        }
                    });

                    // Append processed children
                    cleanChildren.forEach(child => cleanEl.appendChild(child));

                    return cleanEl;
                }

                return null;
            }

            const cleanRoot = cleanNode(document.body);
            return cleanRoot ? cleanRoot.outerHTML : '';
        })()
    `) as Promise<string>;
}
