import puppeteer from 'puppeteer';

/**
 * Retrieves the minimal HTML content of a page by stripping unnecessary elements
 * and attributes, and keeping only visible or structurally important nodes.
 *
 * @param {string} url The URL to visit.
 * @returns {Promise<string>} The minimal HTML string.
 */
async function getMinimalHtml(url) {
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();

        // Set a reasonable viewport size to determine visibility
        await page.setViewport({ width: 1280, height: 800 });

        console.log(`Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

        const minimalHtml = await page.evaluate(() => {

            /**
             * Checks if an element is visible in the viewport or relevant for context.
             * Note: This is a basic check.
             */
            function isVisible(element) {
                if (!element.getBoundingClientRect) return false;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);

                // Check for display:none or visibility:hidden or opacity:0
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                    return false;
                }

                // Check if it has 0 dimensions (unless it contains visible children - handling complex cases is hard,
                // strictly removing 0-size elements might kill containers.
                // Better strategy: keep containers if they have children, but remove empty 0-size leaf nodes?
                // Let's simplify: strict visibility check for leaf nodes, looser for containers?
                // Actually, user wants "what is on the screen".
                // Let's check if it intersects the viewport or is reasonably close.

                const inViewport = (
                    rect.width > 0 &&
                    rect.height > 0 &&
                    rect.bottom >= 0 &&
                    rect.right >= 0 &&
                    rect.top <= window.innerHeight &&
                    rect.left <= window.innerWidth
                );

                return inViewport;
            }

            /**
             * Cleans a node and its children.
             * Returns a simplified clone or null if the node should be removed.
             */
            function cleanNode(node) {
                // Handle Text Nodes
                if (node.nodeType === Node.TEXT_NODE) {
                    // Keep text only if it's not just whitespace
                    if (node.textContent.trim().length > 0) {
                        return document.createTextNode(node.textContent.trim());
                    }
                    return null;
                }

                // Handle Element Nodes
                if (node.nodeType === Node.ELEMENT_NODE) {
                    const tagName = node.tagName.toLowerCase();

                    // 1. Remove Unwanted Tags
                    const blockedTags = [
                        'script', 'style', 'link', 'meta', 'noscript', 'iframe', 'svg',
                        'object', 'embed', 'applet', 'frame', 'frameset'
                    ];
                    if (blockedTags.includes(tagName)) {
                        return null;
                    }

                    // 2. Check Visibility (Optimization: Skip huge trees if root is hidden)
                    // Note: getComputedStyle is expensive. If page is huge, this might be slow.
                    // But we need it.
                    // We can also skip this check for structural tags like html, body, main, div (if we check children)
                    // But if a huge div is display:none, we really want to skip its children.
                    // Let's trust isVisible check.
                    const style = window.getComputedStyle(node);
                    if (style.display === 'none' || style.visibility === 'hidden') return null;


                    // 3. Clone Element (Shallow)
                    // We create a new element to strip events and custom properties attached to the DOM object
                    const cleanEl = document.createElement(tagName);

                    // 4. Copy and Clean Attributes
                    // Allowed attributes: standard identifiers, inputs, accessibility
                    const allowedAttributes = [
                        'id', 'class', 'href', 'src', 'alt', 'title',
                        'type', 'value', 'placeholder', 'name',
                        'role', 'aria-label', 'aria-hidden', 'aria-expanded',
                        'checked', 'selected', 'disabled', 'readonly'
                    ];

                    // Some specialized heavy attributes to definitely remove even if we were permissive:
                    // jsaction, data-*, on*

                    Array.from(node.attributes).forEach(attr => {
                        const name = attr.name.toLowerCase();
                        const value = attr.value;

                        // Skip known junk
                        if (name.startsWith('on') || name.startsWith('data-') || name === 'jsaction' || name.startsWith('ng-')) {
                            return;
                        }

                        // Allow list approach or Block list?
                        // User said "remove huge parameters like jsaction...".
                        // Allow list is safer for "Minimal".
                        if (allowedAttributes.includes(name)) {
                            // Truncate huge values if necessary (e.g. huge data:image src)
                            if (value.length > 500 && name === 'src' && value.startsWith('data:')) {
                                cleanEl.setAttribute(name, value.substring(0, 50) + '...[truncated]');
                            } else if (value.length > 1000) {
                                // Truncate other huge attributes
                                cleanEl.setAttribute(name, value.substring(0, 50) + '...[truncated]');
                            } else {
                                cleanEl.setAttribute(name, value);
                            }
                        }
                    });

                    // 5. Process Children
                    let hasVisibleChildren = false;
                    let hasContent = false;

                    Array.from(node.childNodes).forEach(child => {
                        const cleanedChild = cleanNode(child);
                        if (cleanedChild) {
                            cleanEl.appendChild(cleanedChild);
                            if (cleanedChild.nodeType === Node.TEXT_NODE || (cleanedChild.nodeType === Node.ELEMENT_NODE)) {
                                hasContent = true;
                            }
                            if (cleanedChild.nodeType === Node.ELEMENT_NODE) {
                                hasVisibleChildren = true;
                            }
                        }
                    });

                    // 6. Final Filter: Remove empty elements that are supposed to have content
                    // (e.g. empty divs, spans) UNLESS they are self-closing or structural markers we want to keep?
                    // "leave only elements shown on screen".
                    // An empty div with height might be a spacer.
                    // If we stripped styles, spacer divs are useless unless we keep layout info.
                    // But we are returning HTML, not a screenshot.
                    // If it has no children and no text, and it's a container, kill it.
                    // Inputs/imgs are void elements so they don't have children but are content.
                    const voidTags = ['img', 'input', 'br', 'hr', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr'];

                    if (!voidTags.includes(tagName) && !hasContent) {
                        return null;
                    }

                    return cleanEl;
                }

                return null;
            }

            const cleanRoot = cleanNode(document.body);
            return cleanRoot ? cleanRoot.outerHTML : '';
        });

        await browser.close();
        return minimalHtml;

    } catch (error) {
        if (browser) await browser.close();
        console.error("Error generating minimal HTML:", error);
        throw error;
    }
}

// Test execution if run directly
const testUrl = process.argv[2] || 'https://google.com';
console.log(`Running minimal HTML extraction for: ${testUrl}`);

getMinimalHtml(testUrl).then(html => {
    console.log("--- Minimal HTML Start ---");
    console.log(html);
    console.log("--- Minimal HTML End ---");
    // Calculate reduction stats if possible (approximated)
    console.log(`Output length: ${html.length} chars`);
}).catch(err => console.error(err));
