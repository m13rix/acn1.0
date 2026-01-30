/**
 * PPTXML Parser for pptxgen.js
 *
 * This Node.js script converts PPTXML syntax into PowerPoint presentations
 * using the pptxgen.js library.
 */

import * as fs from 'fs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import * as path from 'path';
import { DOMParser } from '@xmldom/xmldom';
import axios from 'axios';

const require = createRequire(import.meta.url);

/**
 * Parse size value which can be in inches or percentage
 * @param {string} size - Size value
 * @returns {number|string} - Parsed size
 */
function parseSize(size) {
    if (!size) return undefined;

    if (size.endsWith('%')) {
        return size; // Return as is for percentage
    }

    return parseFloat(size); // Return as number for inches
}

/**
 * Parse color value which can be hex or scheme color
 * @param {string} color - Color value
 * @param {PptxGenJS} pptx - PptxGenJS instance
 * @returns {string|object} - Parsed color
 */
function parseSchemeColor(color, pptx) {
    if (!color) return undefined;

    // Check if it's a scheme color
    if (color.startsWith('scheme:')) {
        const schemeName = color.substring(7); // Remove 'scheme:' prefix

        // Map the scheme name to pptx.SchemeColor
        switch (schemeName) {
            case 'text1': return pptx.SchemeColor.text1;
            case 'text2': return pptx.SchemeColor.text2;
            case 'background1': return pptx.SchemeColor.background1;
            case 'background2': return pptx.SchemeColor.background2;
            case 'accent1': return pptx.SchemeColor.accent1;
            case 'accent2': return pptx.SchemeColor.accent2;
            case 'accent3': return pptx.SchemeColor.accent3;
            case 'accent4': return pptx.SchemeColor.accent4;
            case 'accent5': return pptx.SchemeColor.accent5;
            case 'accent6': return pptx.SchemeColor.accent6;
            default: return color; // Return as is if unknown scheme
        }
    }

    return color; // Return as is for hex colors
}

/**
 * Main function to convert PPTXML to PPTX
 * @param {string} xmlInput - PPTXML content as string
 * @param {string} outputPath - Path where the PPTX file will be saved
 * @returns {Promise<void>}
 */
export async function convertPPTXMLtoPPTX(xmlInput, outputPath) {
    // Use require for CommonJS version of pptxgen
    const pptxgen = require('pptxgenjs');
    
    // Parse XML
    const parser = new DOMParser();
    console.log(xmlInput)
    const xmlDoc = parser.parseFromString(xmlInput, 'text/xml');

    // Create new presentation
    const pptx = new pptxgen();

    try {
        // Process presentation attributes
        await processPresentationAttributes(xmlDoc, pptx);

        // Process slides
        const slideNodes = xmlDoc.getElementsByTagName('slide');
        for (let i = 0; i < slideNodes.length; i++) {
            await processSlide(slideNodes[i], pptx);
        }

        // Save the presentation
        pptx.writeFile(outputPath);
        console.log(`Presentation saved to ${outputPath}`);
    } catch (error) {
        console.error('Error generating presentation:', error);
    }
}

/**
 * Process presentation attributes
 * @param {Document} xmlDoc - XML document
 * @param {PptxGenJS} pptx - PptxGenJS instance
 * @returns {Promise<void>}
 */
async function processPresentationAttributes(xmlDoc, pptx) {
    const presentationNode = xmlDoc.getElementsByTagName('presentation')[0];

    if (!presentationNode) {
        throw new Error('No presentation tag found in the XML');
    }

    // Set presentation properties
    if (presentationNode.getAttribute('title')) {
        pptx.title = presentationNode.getAttribute('title');
    }

    if (presentationNode.getAttribute('author')) {
        pptx.author = presentationNode.getAttribute('author');
    }

    if (presentationNode.getAttribute('company')) {
        pptx.company = presentationNode.getAttribute('company');
    }

    if (presentationNode.getAttribute('subject')) {
        pptx.subject = presentationNode.getAttribute('subject');
    }

    if (presentationNode.getAttribute('revision')) {
        pptx.revision = presentationNode.getAttribute('revision');
    }

    if (presentationNode.getAttribute('layout')) {
        const layout = presentationNode.getAttribute('layout');

        // Handle predefined layouts
        if (layout === '16x9') {
            pptx.layout = 'LAYOUT_16x9';
        } else if (layout === '4x3') {
            pptx.layout = 'LAYOUT_4x3';
        } else if (layout === 'WIDE') {
            pptx.layout = 'LAYOUT_WIDE';
        }
        // Custom layouts are handled below
    }

    if (presentationNode.getAttribute('rtl') === 'true') {
        pptx.rtlMode = true;
    }

    // Set theme fonts if specified
    const themeHeadFont = presentationNode.getAttribute('theme-headFont');
    const themeBodyFont = presentationNode.getAttribute('theme-bodyFont');

    if (themeHeadFont || themeBodyFont) {
        pptx.theme = {
            headFontFace: themeHeadFont || undefined,
            bodyFontFace: themeBodyFont || undefined
        };
    }

    // Process custom layout if present
    const layoutNodes = presentationNode.getElementsByTagName('layout');
    if (layoutNodes.length > 0) {
        const layoutNode = layoutNodes[0];
        const name = layoutNode.getAttribute('name');
        const width = parseFloat(layoutNode.getAttribute('width'));
        const height = parseFloat(layoutNode.getAttribute('height'));

        if (name && !isNaN(width) && !isNaN(height)) {
            pptx.defineLayout({ name, width, height });
            pptx.layout = name;
        }
    }
}

/**
 * Process a slide and its elements
 * @param {Element} slideNode - XML slide node
 * @param {PptxGenJS} pptx - PptxGenJS instance
 * @returns {Promise<void>}
 */
async function processSlide(slideNode, pptx) {
    // Create a new slide
    const slide = pptx.addSlide();

    // Set slide background
    const bg = slideNode.getAttribute('bg');
    if (bg) {
        // Check if it's a color (hex)
        if (bg.startsWith('#')) {
            slide.background = { color: bg };
        }
        // Check if it's a base64 image
        else if (bg.startsWith('data:')) {
            slide.background = { data: bg };
        }
        // Otherwise, treat as path
        else {
            // Check if it's a URL or local path
            if (bg.startsWith('http')) {
                const response = await axios.get(bg, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data, 'binary');
                slide.background = { data: buffer.toString('base64') };
            } else {
                try {
                    const data = fs.readFileSync(bg, { encoding: 'base64' });
                    slide.background = { data: data };
                } catch (error) {
                    console.warn(`Could not load background image: ${bg}`);
                }
            }
        }
    }

    // Set background opacity if specified
    const bgOpacity = slideNode.getAttribute('bg-opacity');
    if (bgOpacity && !isNaN(parseFloat(bgOpacity))) {
        if (slide.background) {
            slide.background.opacity = parseFloat(bgOpacity);
        }
    }

    // Set slide text color
    const color = slideNode.getAttribute('color');
    if (color) {
        slide.color = parseSchemeColor(color, pptx);
    }

    // Set slide visibility
    if (slideNode.getAttribute('hidden') === 'true') {
        slide.hidden = true;
    }

    // Set master slide if specified
    const master = slideNode.getAttribute('master');
    if (master) {
        slide.masterName = master;
    }

    // Process slide number
    const slideNumberNodes = slideNode.getElementsByTagName('slideNumber');
    if (slideNumberNodes.length > 0) {
        const slideNumberNode = slideNumberNodes[0];
        const slideNumber = {};

        if (slideNumberNode.getAttribute('x')) {
            slideNumber.x = parseSize(slideNumberNode.getAttribute('x'));
        }

        if (slideNumberNode.getAttribute('y')) {
            slideNumber.y = parseSize(slideNumberNode.getAttribute('y'));
        }

        if (slideNumberNode.getAttribute('font')) {
            slideNumber.fontFace = slideNumberNode.getAttribute('font');
        }

        if (slideNumberNode.getAttribute('size')) {
            slideNumber.fontSize = parseFloat(slideNumberNode.getAttribute('size'));
        }

        if (slideNumberNode.getAttribute('color')) {
            slideNumber.color = parseSchemeColor(slideNumberNode.getAttribute('color'), pptx);
        }

        slide.slideNumber = slideNumber;
    }

    // Process slide elements
    await processShapeElements(slideNode, slide, pptx);
    await processTableElements(slideNode, slide);
    await processChartElements(slideNode, slide);
    await processMediaElements(slideNode, slide);
    await processTextElements(slideNode, slide, pptx);
    await processImageElements(slideNode, slide);
    await processNotes(slideNode, slide);
}

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ПОДБОРА ШРИФТА ===

/**
 * Оценка размеров текста (ширина и высота) для заданного размера шрифта и области
 * @param {string|string[]} text - Текст или массив строк
 * @param {number} fontSize - Размер шрифта
 * @param {number} w - Ширина области (inches)
 * @returns {{width: number, height: number, lines: number}}
 */
function estimateTextBox(text, fontSize, w) {
    // Если text — массив, склеиваем через \n
    let lines = [];
    if (Array.isArray(text)) {
        text.forEach(t => {
            if (typeof t === 'string') lines.push(...t.split('\n'));
            else if (t && t.text) lines.push(...t.text.split('\n'));
        });
    } else if (typeof text === 'string') {
        lines = text.split('\n');
    } else {
        lines = [''];
    }
    // Эвристика: ширина строки ≈ 0.6 * fontSize * длина строки (в символах), в pptxgenjs 1 inch ≈ 72pt
    // Высота строки ≈ fontSize * 1.2 (с учётом межстрочного интервала)
    let maxLineLen = Math.max(...lines.map(l => l.length));
    let width = 0.6 * fontSize * maxLineLen / 72; // в дюймах
    let height = lines.length * fontSize * 1.2 / 72; // в дюймах
    // Если задана ширина области, считаем переносы строк
    if (w && width > w) {
        // Оцениваем, сколько строк потребуется
        let charsPerLine = Math.floor(w * 72 / (0.6 * fontSize));
        let newLines = [];
        lines.forEach(line => {
            for (let i = 0; i < line.length; i += charsPerLine) {
                newLines.push(line.slice(i, i + charsPerLine));
            }
        });
        height = newLines.length * fontSize * 1.2 / 72;
        width = w;
        lines = newLines;
    }
    return { width, height, lines: lines.length };
}

/**
 * Проверка пересечения двух прямоугольников
 * @param {object} a - {x, y, w, h}
 * @param {object} b - {x, y, w, h}
 * @returns {boolean}
 */
function isOverlap(a, b) {
    return (
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y
    );
}

/**
 * Process text elements in a slide
 * @param {Element} slideNode - XML slide node
 * @param {Slide} slide - pptxgen.js slide object
 * @param {PptxGenJS} pptx - PptxGenJS instance
 * @returns {Promise<void>}
 */
async function processTextElements(slideNode, slide, pptx) {
    const textNodes = slideNode.getElementsByTagName('text');
    // Собираем bounding box всех элементов на слайде
    if (!slide._elementBoxes) slide._elementBoxes = [];
    const elementBoxes = slide._elementBoxes;

    for (let i = 0; i < textNodes.length; i++) {
        const textNode = textNodes[i];
        const textOptions = {};

        // Process position and size
        if (textNode.getAttribute('x')) {
            textOptions.x = parseSize(textNode.getAttribute('x'));
        }
        if (textNode.getAttribute('y')) {
            textOptions.y = parseSize(textNode.getAttribute('y'));
        }
        if (textNode.getAttribute('w')) {
            textOptions.w = parseSize(textNode.getAttribute('w'));
        }
        if (textNode.getAttribute('h')) {
            textOptions.h = parseSize(textNode.getAttribute('h'));
        }

        // Process text formatting
        if (textNode.getAttribute('align')) {
            textOptions.align = textNode.getAttribute('align');
        }
        if (textNode.getAttribute('valign')) {
            textOptions.valign = textNode.getAttribute('valign');
        }
        if (textNode.getAttribute('font')) {
            textOptions.fontFace = textNode.getAttribute('font');
        }
        if (textNode.getAttribute('size')) {
            textOptions.fontSize = parseFloat(textNode.getAttribute('size'));
        }
        if (textNode.getAttribute('color')) {
            textOptions.color = parseSchemeColor(textNode.getAttribute('color'), pptx);
        }
        if (textNode.getAttribute('bold') === 'true') {
            textOptions.bold = true;
        }
        if (textNode.getAttribute('italic') === 'true') {
            textOptions.italic = true;
        }
        if (textNode.getAttribute('underline') === 'true') {
            textOptions.underline = true;
        }
        if (textNode.getAttribute('bullet') === 'true') {
            textOptions.bullet = true;
        }
        if (textNode.getAttribute('indent')) {
            textOptions.indentLevel = parseInt(textNode.getAttribute('indent'));
        }
        if (textNode.getAttribute('hyperlink')) {
            textOptions.hyperlink = { url: textNode.getAttribute('hyperlink') };
        }
        if (textNode.getAttribute('glow') === 'true') {
            textOptions.glow = { size: 10, color: 'FFFFFF', opacity: 0.3 };
        }
        if (textNode.getAttribute('shadow') === 'true') {
            textOptions.shadow = { type: 'outer', angle: 45, blur: 3, color: '000000', offset: 3, opacity: 0.5 };
        }
        if (textNode.getAttribute('rotate')) {
            textOptions.rotate = parseInt(textNode.getAttribute('rotate'));
        }

        // Check if this is a single text or multi-formatted text
        const value = textNode.getAttribute('value');
        const spanNodes = textNode.getElementsByTagName('span');

        // === АВТОПОДБОР РАЗМЕРА ШРИФТА ===
        let minFontSize = 8; // минимальный размер шрифта
        let maxFontSize = textOptions.fontSize || 44; // стартовый/максимальный
        let bestFontSize = maxFontSize;
        let textContent = value;
        let isMultiSpan = false;
        let textArray = [];
        if (!value && spanNodes.length > 0) {
            isMultiSpan = true;
            for (let j = 0; j < spanNodes.length; j++) {
                const spanNode = spanNodes[j];
                textArray.push(spanNode.getAttribute('value') || '');
            }
            textContent = textArray;
        }
        // Область для текста
        let x = textOptions.x || 0, y = textOptions.y || 0, w = textOptions.w || 2, h = textOptions.h || 1;
        // Подбор размера шрифта
        for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 1) {
            let { width, height } = estimateTextBox(textContent, fontSize, w);
            if (width <= w && height <= h) {
                // Проверяем пересечения с другими элементами
                let box = { x, y, w, h: height };
                let overlap = elementBoxes.some(b => isOverlap(box, b));
                if (!overlap) {
                    bestFontSize = fontSize;
                    break;
                }
            }
        }
        textOptions.fontSize = Math.max(bestFontSize, 12);
        // Добавляем текст
        if (value) {
            slide.addText(value, textOptions);
        } else if (spanNodes.length > 0) {
            // Multi-formatted text (оставляем как было, но с подобранным fontSize)
            const textArray = [];
            for (let j = 0; j < spanNodes.length; j++) {
                const spanNode = spanNodes[j];
                const spanOptions = {};
                for (const key in textOptions) {
                    if (key !== 'x' && key !== 'y' && key !== 'w' && key !== 'h') {
                        spanOptions[key] = textOptions[key];
                    }
                }
                if (spanNode.getAttribute('bold') === 'true') {
                    spanOptions.bold = true;
                }
                if (spanNode.getAttribute('italic') === 'true') {
                    spanOptions.italic = true;
                }
                if (spanNode.getAttribute('underline') === 'true') {
                    spanOptions.underline = true;
                }
                if (spanNode.getAttribute('color')) {
                    spanOptions.color = parseSchemeColor(spanNode.getAttribute('color'), pptx);
                }
                if (spanNode.getAttribute('size')) {
                    let sz = parseFloat(spanNode.getAttribute('size'));
                    spanOptions.fontSize = sz > 12 ? 12 : sz;
                } else {
                    spanOptions.fontSize = Math.max(bestFontSize, 12);
                }
                if (spanNode.getAttribute('bullet') === 'true') {
                    spanOptions.bullet = true;
                }
                if (spanNode.getAttribute('indent')) {
                    spanOptions.indentLevel = parseInt(spanNode.getAttribute('indent'));
                }
                if (spanNode.getAttribute('bullet-type') === 'number') {
                    spanOptions.bullet = { type: 'number' };
                }
                if (spanNode.getAttribute('hyperlink')) {
                    spanOptions.hyperlink = { url: spanNode.getAttribute('hyperlink') };
                }
                textArray.push({
                    text: spanNode.getAttribute('value').replace('\\n', '\n'),
                    options: spanOptions
                });
            }
            slide.addText(textArray, textOptions);
        }
        // Добавляем bounding box текста в массив элементов
        let { height } = estimateTextBox(textContent, bestFontSize, w);
        elementBoxes.push({ x, y, w, h: height });
    }
}

/**
 * Process image elements in a slide
 * @param {Element} slideNode - XML slide node
 * @param {Slide} slide - pptxgen.js slide object
 * @returns {Promise<void>}
 */
async function processImageElements(slideNode, slide) {
    const imageNodes = slideNode.getElementsByTagName('image');

    for (let i = 0; i < imageNodes.length; i++) {
        const imageNode = imageNodes[i];
        const imageOptions = {};

        // Process position and size
        if (imageNode.getAttribute('x')) {
            imageOptions.x = parseSize(imageNode.getAttribute('x'));
        }

        if (imageNode.getAttribute('y')) {
            imageOptions.y = parseSize(imageNode.getAttribute('y'));
        }

        if (imageNode.getAttribute('w')) {
            imageOptions.w = parseSize(imageNode.getAttribute('w'));
        }

        if (imageNode.getAttribute('h')) {
            imageOptions.h = parseSize(imageNode.getAttribute('h'));
        }

        // Process image options
        if (imageNode.getAttribute('alt')) {
            imageOptions.altText = imageNode.getAttribute('alt');
        }

        if (imageNode.getAttribute('flip-h') === 'true') {
            imageOptions.flipH = true;
        }

        if (imageNode.getAttribute('flip-v') === 'true') {
            imageOptions.flipV = true;
        }

        if (imageNode.getAttribute('rotate')) {
            imageOptions.rotate = parseInt(imageNode.getAttribute('rotate'));
        }

        if (imageNode.getAttribute('rounding')) {
            const rounding = imageNode.getAttribute('rounding');
            imageOptions.rounding = rounding === 'true' ? true : parseFloat(rounding);
        }

        if (imageNode.getAttribute('transparency')) {
            imageOptions.transparency = parseFloat(imageNode.getAttribute('transparency'));
        }

        // Process sizing
        const sizingNodes = imageNode.getElementsByTagName('sizing');
        if (sizingNodes.length > 0) {
            const sizingNode = sizingNodes[0];
            imageOptions.sizing = {};

            if (sizingNode.getAttribute('type')) {
                imageOptions.sizing.type = sizingNode.getAttribute('type');
            }

            if (sizingNode.getAttribute('w')) {
                imageOptions.sizing.w = parseFloat(sizingNode.getAttribute('w'));
            }

            if (sizingNode.getAttribute('h')) {
                imageOptions.sizing.h = parseFloat(sizingNode.getAttribute('h'));
            }

            if (sizingNode.getAttribute('x')) {
                imageOptions.sizing.x = parseFloat(sizingNode.getAttribute('x'));
            }

            if (sizingNode.getAttribute('y')) {
                imageOptions.sizing.y = parseFloat(sizingNode.getAttribute('y'));
            }
        }

        // Get image data
        const path = imageNode.getAttribute('path');
        const data = imageNode.getAttribute('data');

        if (path) {
            // Check if it's a URL or local path
            if (path.startsWith('http')) {
                // Это URL, загружаем картинку
                try {
                    // Получаем бинарные данные картинки
                    const response = await axios.get(path, { responseType: 'arraybuffer' });
                    // Создаём Buffer из полученных данных
                    const buffer = Buffer.from(response.data, 'binary');
                    // Берём MIME-тип из заголовка ответа (например "image/png")
                    const mimeType = response.headers['content-type'] || 'image/png';
                    // Переводим в строку base64 и добавляем нужный префикс
                    imageOptions.data = `data:${mimeType};base64,${buffer.toString('base64')}`;

                    slide.addImage(imageOptions);
                } catch (error) {
                    console.warn(`Could not load image from URL: ${path}`, error);
                }
            } else {
                // It's a local path
                imageOptions.path = path;
                slide.addImage(imageOptions);
            }
        } else if (data) {
            // It's base64 data
            imageOptions.data = data;
            slide.addImage(imageOptions);
        }
    }
}

/**
 * Process shape elements in a slide
 * @param {Element} slideNode - XML slide node
 * @param {Slide} slide - pptxgen.js slide object
 * @param {PptxGenJS} pptx - PptxGenJS instance
 * @returns {Promise<void>}
 */
async function processShapeElements(slideNode, slide, pptx) {
    const shapeNodes = slideNode.getElementsByTagName('shape');

    for (let i = 0; i < shapeNodes.length; i++) {
        const shapeNode = shapeNodes[i];
        const shapeOptions = {};

        // Get shape type
        const type = shapeNode.getAttribute('type');
        if (!type) {
            console.warn('Shape without type attribute, skipping');
            continue;
        }

        // Process position and size
        if (shapeNode.getAttribute('x')) {
            shapeOptions.x = parseSize(shapeNode.getAttribute('x'));
        }

        if (shapeNode.getAttribute('y')) {
            shapeOptions.y = parseSize(shapeNode.getAttribute('y'));
        }

        if (shapeNode.getAttribute('w')) {
            shapeOptions.w = parseSize(shapeNode.getAttribute('w'));
        }

        if (shapeNode.getAttribute('h')) {
            shapeOptions.h = parseSize(shapeNode.getAttribute('h'));
        }

        // Process shape options
        if (shapeNode.getAttribute('fill')) {
            shapeOptions.fill = parseSchemeColor(shapeNode.getAttribute('fill'), pptx);
        }

        if (shapeNode.getAttribute('line')) {
            shapeOptions.line = {color: parseSchemeColor(shapeNode.getAttribute('line'), pptx)};

            if (shapeNode.getAttribute('line-size')) {
                shapeOptions.line.pt = parseFloat(shapeNode.getAttribute('line-size'));
            }

            if (shapeNode.getAttribute('line-dash')) {
                const dash = shapeNode.getAttribute('line-dash');
                if (dash === 'dash') {
                    shapeOptions.line.dashType = 'dash';
                }
            }
        }

        if (shapeNode.getAttribute('rotate')) {
            shapeOptions.rotate = parseInt(shapeNode.getAttribute('rotate'));
        }

        if (shapeNode.getAttribute('flip-h') === 'true') {
            shapeOptions.flipH = true;
        }

        if (shapeNode.getAttribute('flip-v') === 'true') {
            shapeOptions.flipV = true;
        }

        if (shapeNode.getAttribute('hyperlink')) {
            shapeOptions.hyperlink = {url: shapeNode.getAttribute('hyperlink')};
        }

        if (shapeNode.getAttribute('shadow') === 'true') {
            shapeOptions.shadow = {type: 'outer', angle: 45, blur: 3, color: '000000', offset: 3, opacity: 0.5};
        }

        // Handle text inside shape
        const text = shapeNode.getAttribute('text');
        if (text) {
            shapeOptions.text = text;

            if (shapeNode.getAttribute('text-align')) {
                shapeOptions.align = shapeNode.getAttribute('text-align');
            }

            if (shapeNode.getAttribute('text-valign')) {
                shapeOptions.valign = shapeNode.getAttribute('text-valign');
            }

            if (shapeNode.getAttribute('text-color')) {
                shapeOptions.color = parseSchemeColor(shapeNode.getAttribute('text-color'), pptx);
            }

            if (shapeNode.getAttribute('text-font')) {
                shapeOptions.fontFace = shapeNode.getAttribute('text-font');
            }

            if (shapeNode.getAttribute('text-size')) {
                shapeOptions.fontSize = parseFloat(shapeNode.getAttribute('text-size'));
            }
        }

        // Map the type string to pptx.ShapeType
        let shapeType;
        try {
            shapeType = pptx.ShapeType[type];

            if (!shapeType) {
                // Try to handle common shapes directly
                switch (type.toLowerCase()) {
                    case 'rectangle':
                        shapeType = pptx.ShapeType.rect;
                        break;
                    case 'oval':
                    case 'ellipse':
                        shapeType = pptx.ShapeType.ellipse;
                        break;
                    case 'triangle':
                        shapeType = pptx.ShapeType.triangle;
                        break;
                    case 'line':
                        shapeType = pptx.ShapeType.line;
                        break;
                    case 'arrow':
                        shapeType = pptx.ShapeType.rightArrow;
                        break;
                    default:
                        console.warn(`Unknown shape type: ${type}, using RECTANGLE as fallback`);
                        shapeType = pptx.ShapeType.rect;
                }
            }

            slide.addShape(shapeType, shapeOptions);
        } catch (error) {
            console.warn(`Error adding shape: ${error.message}`);
        }
    }
}

/**
 * Process table elements in a slide
 * @param {Element} slideNode - XML slide node
 * @param {Slide} slide - pptxgen.js slide object
 * @returns {Promise<void>}
 */
async function processTableElements(slideNode, slide) {
    const tableNodes = slideNode.getElementsByTagName('table');

    for (let i = 0; i < tableNodes.length; i++) {
        const tableNode = tableNodes[i];
        const tableOptions = {};

        // Process position and size
        if (tableNode.getAttribute('x')) {
            tableOptions.x = parseSize(tableNode.getAttribute('x'));
        }

        if (tableNode.getAttribute('y')) {
            tableOptions.y = parseSize(tableNode.getAttribute('y'));
        }

        if (tableNode.getAttribute('w')) {
            tableOptions.w = parseSize(tableNode.getAttribute('w'));
        }

        if (tableNode.getAttribute('h')) {
            tableOptions.h = parseSize(tableNode.getAttribute('h'));
        }

        // Process table formatting
        if (tableNode.getAttribute('font')) {
            tableOptions.fontFace = tableNode.getAttribute('font');
        }

        if (tableNode.getAttribute('size')) {
            let sz = parseFloat(tableNode.getAttribute('size'));
            tableOptions.fontSize = sz > 12 ? 12 : sz;
        }

        if (tableNode.getAttribute('color')) {
            tableOptions.color = tableNode.getAttribute('color');
        }

        if (tableNode.getAttribute('fill')) {
            tableOptions.fill = tableNode.getAttribute('fill');
        }

        if (tableNode.getAttribute('border')) {
            // Parse border values like "1px solid #000000"
            const borderValue = tableNode.getAttribute('border');
            const parts = borderValue.split(' ');

            if (parts.length >= 3) {
                const width = parseFloat(parts[0]);
                tableOptions.border = {
                    pt: isNaN(width) ? 1 : width,
                    color: parts[2] || '#000000'
                };
            } else {
                tableOptions.border = { pt: 1, color: '#000000' };
            }
        }

        if (tableNode.getAttribute('align')) {
            tableOptions.align = tableNode.getAttribute('align');
        }

        if (tableNode.getAttribute('valign')) {
            tableOptions.valign = tableNode.getAttribute('valign');
        }

        // Set auto-paging options
        if (tableNode.getAttribute('autoPage') === 'true') {
            tableOptions.autoPage = true;
        }

        if (tableNode.getAttribute('autoPageRepeatHeader') === 'true') {
            tableOptions.autoPageRepeatHeader = true;
        }

        if (tableNode.getAttribute('autoPageHeaderRows')) {
            tableOptions.autoPageHeaderRows = parseInt(tableNode.getAttribute('autoPageHeaderRows'));
        }

        // Process column widths if specified
        const colWidthNodes = tableNode.getElementsByTagName('colW');
        if (colWidthNodes.length > 0) {
            const colWidths = colWidthNodes[0].textContent.split(',').map(w => parseFloat(w.trim()));
            tableOptions.colW = colWidths;
        }

        // Process row heights if specified
        const rowHeightNodes = tableNode.getElementsByTagName('rowH');
        if (rowHeightNodes.length > 0) {
            const rowHeights = rowHeightNodes[0].textContent.split(',').map(h => parseFloat(h.trim()));
            tableOptions.rowH = rowHeights;
        }

        // Process rows and cells
        const rowNodes = tableNode.getElementsByTagName('row');
        const tableData = [];

        for (let j = 0; j < rowNodes.length; j++) {
            const rowNode = rowNodes[j];
            const row = [];
            const rowOptions = {};

            // Process row-level formatting
            if (rowNode.getAttribute('fill')) {
                rowOptions.fill = rowNode.getAttribute('fill');
            }

            if (rowNode.getAttribute('bold') === 'true') {
                rowOptions.bold = true;
            }

            // Process cells
            const cellNodes = rowNode.getElementsByTagName('cell');
            for (let k = 0; k < cellNodes.length; k++) {
                const cellNode = cellNodes[k];
                const cellValue = cellNode.getAttribute('value');
                const cellOptions = Object.assign({}, rowOptions);

                // Process cell-level formatting
                if (cellNode.getAttribute('fill')) {
                    cellOptions.fill = cellNode.getAttribute('fill');
                }

                if (cellNode.getAttribute('color')) {
                    cellOptions.color = cellNode.getAttribute('color');
                }

                if (cellNode.getAttribute('size')) {
                    let sz = parseFloat(cellNode.getAttribute('size'));
                    cellOptions.fontSize = sz > 12 ? 12 : sz;
                }

                if (cellNode.getAttribute('border')) {
                    // Parse border values like "1px solid #000000"
                    const borderValue = cellNode.getAttribute('border');
                    const parts = borderValue.split(' ');

                    if (parts.length >= 3) {
                        const width = parseFloat(parts[0]);
                        cellOptions.border = {
                            pt: isNaN(width) ? 1 : width,
                            color: parts[2] || '#000000'
                        };
                    } else {
                        cellOptions.border = { pt: 1, color: '#000000' };
                    }
                }

                if (cellNode.getAttribute('bold') === 'true') {
                    cellOptions.bold = true;
                }

                if (cellNode.getAttribute('italic') === 'true') {
                    cellOptions.italic = true;
                }

                if (cellNode.getAttribute('underline') === 'true') {
                    cellOptions.underline = true;
                }

                // Check for span elements for formatted text
                const spanNodes = cellNode.getElementsByTagName('span');
                if (spanNodes.length > 0) {
                    const textArray = [];

                    for (let l = 0; l < spanNodes.length; l++) {
                        const spanNode = spanNodes[l];
                        const spanOptions = Object.assign({}, cellOptions);

                        if (spanNode.getAttribute('bold') === 'true') {
                            spanOptions.bold = true;
                        }

                        if (spanNode.getAttribute('italic') === 'true') {
                            spanOptions.italic = true;
                        }

                        if (spanNode.getAttribute('underline') === 'true') {
                            spanOptions.underline = true;
                        }

                        if (spanNode.getAttribute('color')) {
                            spanOptions.color = spanNode.getAttribute('color');
                        }
                        if (spanNode.getAttribute('size')) {
                            let sz = parseFloat(spanNode.getAttribute('size'));
                            spanOptions.fontSize = sz > 12 ? 12 : sz;
                        }

                        textArray.push({
                            text: spanNode.getAttribute('value'),
                            options: spanOptions
                        });
                    }

                    row.push({ text: textArray });
                } else {
                    // Simple cell
                    row.push({ text: cellValue, options: cellOptions });
                }
            }

            tableData.push(row);
        }

        // Add the table to the slide
        slide.addTable(tableData, tableOptions);
    }
}

/**
 * Process chart elements in a slide
 * @param {Element} slideNode - XML slide node
 * @param {Slide} slide - pptxgen.js slide object
 * @returns {Promise<void>}
 */
async function processChartElements(slideNode, slide) {
    const chartNodes = slideNode.getElementsByTagName('chart');

    for (let i = 0; i < chartNodes.length; i++) {
        const chartNode = chartNodes[i];
        const chartData = [];
        const chartOptions = {};

        // Process position and size
        if (chartNode.getAttribute('x')) {
            chartOptions.x = parseSize(chartNode.getAttribute('x'));
        }

        if (chartNode.getAttribute('y')) {
            chartOptions.y = parseSize(chartNode.getAttribute('y'));
        }

        if (chartNode.getAttribute('w')) {
            chartOptions.w = parseSize(chartNode.getAttribute('w'));
        }

        if (chartNode.getAttribute('h')) {
            chartOptions.h = parseSize(chartNode.getAttribute('h'));
        }

        // Get chart type
        const type = chartNode.getAttribute('type');
        if (!type) {
            console.warn('Chart without type attribute, skipping');
            continue;
        }

        // Map chart type to pptxgen.js chart type
        let chartType;
        switch (type.toLowerCase()) {
            case 'bar':
                chartType = 'bar';
                break;
            case 'line':
                chartType = 'line';
                break;
            case 'pie':
                chartType = 'pie';
                break;
            case 'scatter':
                chartType = 'scatter';
                break;
            case 'area':
                chartType = 'area';
                break;
            case 'radar':
                chartType = 'radar';
                break;
            case 'doughnut':
                chartType = 'doughnut';
                break;
            default:
                console.warn(`Unknown chart type: ${type}, using bar as fallback`);
                chartType = 'bar';
        }

        // Process chart title
        if (chartNode.getAttribute('title')) {
            chartOptions.title = chartNode.getAttribute('title');
        }

        if (chartNode.getAttribute('title-color')) {
            chartOptions.titleColor = chartNode.getAttribute('title-color');
        }

        if (chartNode.getAttribute('title-size')) {
            chartOptions.titleFontSize = parseInt(chartNode.getAttribute('title-size'));
        }

        // Process legend options
        if (chartNode.getAttribute('show-legend') === 'true') {
            chartOptions.showLegend = true;

            if (chartNode.getAttribute('legend-pos')) {
                chartOptions.legendPos = chartNode.getAttribute('legend-pos');
            }

            if (chartNode.getAttribute('legend-color')) {
                chartOptions.legendColor = chartNode.getAttribute('legend-color');
            }

            if (chartNode.getAttribute('legend-size')) {
                chartOptions.legendFontSize = parseInt(chartNode.getAttribute('legend-size'));
            }
        } else if (chartNode.getAttribute('show-legend') === 'false') {
            chartOptions.showLegend = false;
        }

        // Process data table and labels
        if (chartNode.getAttribute('show-data-table') === 'true') {
            chartOptions.showDataTable = true;
        }

        if (chartNode.getAttribute('show-labels') === 'true') {
            chartOptions.showDataTableKeys = true;
        }

        // Process series data
        const seriesNodes = chartNode.getElementsByTagName('series');
        for (let j = 0; j < seriesNodes.length; j++) {
            const seriesNode = seriesNodes[j];
            const seriesName = seriesNode.getAttribute('name') || `Series ${j + 1}`;
            const seriesColor = seriesNode.getAttribute('color');

            const series = {
                name: seriesName,
                labels: [],
                values: []
            };

            if (seriesColor) {
                series.color = seriesColor;
            }

            // Process data points
            const pointNodes = seriesNode.getElementsByTagName('point');
            for (let k = 0; k < pointNodes.length; k++) {
                const pointNode = pointNodes[k];
                const label = pointNode.getAttribute('label') || '';
                const value = parseFloat(pointNode.getAttribute('value') || 0);

                series.labels.push(label);
                series.values.push(value);
            }

            chartData.push(series);
        }

        // Process axis configuration
        const catAxisNodes = chartNode.getElementsByTagName('catAxis');
        if (catAxisNodes.length > 0) {
            const catAxisNode = catAxisNodes[0];
            chartOptions.catAxisTitle = catAxisNode.getAttribute('title') || '';

            if (catAxisNode.getAttribute('show-grid-lines') === 'true') {
                chartOptions.catGridLine = { color: 'D8D8D8', style: 'solid', size: 1 };
            }
        }

        const valAxisNodes = chartNode.getElementsByTagName('valAxis');
        if (valAxisNodes.length > 0) {
            const valAxisNode = valAxisNodes[0];
            chartOptions.valAxisTitle = valAxisNode.getAttribute('title') || '';

            if (valAxisNode.getAttribute('min')) {
                chartOptions.valAxisMinVal = parseFloat(valAxisNode.getAttribute('min'));
            }

            if (valAxisNode.getAttribute('max')) {
                chartOptions.valAxisMaxVal = parseFloat(valAxisNode.getAttribute('max'));
            }

            if (valAxisNode.getAttribute('major-unit')) {
                chartOptions.valAxisMajorUnit = parseFloat(valAxisNode.getAttribute('major-unit'));
            }
        }

        // Add the chart to the slide
        slide.addChart(chartType, chartData, chartOptions);
    }
}

/**
 * Process media elements in a slide
 * @param {Element} slideNode - XML slide node
 * @param {Slide} slide - pptxgen.js slide object
 * @returns {Promise<void>}
 */
async function processMediaElements(slideNode, slide) {
    const mediaNodes = slideNode.getElementsByTagName('media');

    for (let i = 0; i < mediaNodes.length; i++) {
        const mediaNode = mediaNodes[i];
        const mediaOptions = {};

        // Process position and size
        if (mediaNode.getAttribute('x')) {
            mediaOptions.x = parseSize(mediaNode.getAttribute('x'));
        }

        if (mediaNode.getAttribute('y')) {
            mediaOptions.y = parseSize(mediaNode.getAttribute('y'));
        }

        if (mediaNode.getAttribute('w')) {
            mediaOptions.w = parseSize(mediaNode.getAttribute('w'));
        }

        if (mediaNode.getAttribute('h')) {
            mediaOptions.h = parseSize(mediaNode.getAttribute('h'));
        }

        // Get media type
        const type = mediaNode.getAttribute('type');
        if (!type) {
            console.warn('Media without type attribute, skipping');
            continue;
        }

        // Process media source
        const path = mediaNode.getAttribute('path');
        const data = mediaNode.getAttribute('data');
        const link = mediaNode.getAttribute('link');
        const cover = mediaNode.getAttribute('cover');

        // Set cover image if provided
        if (cover) {
            try {
                if (cover.startsWith('http')) {
                    // It's a URL, fetch it
                    const response = await axios.get(cover, { responseType: 'arraybuffer' });
                    const buffer = Buffer.from(response.data, 'binary');
                    mediaOptions.cover = buffer.toString('base64');
                } else {
                    // It's a local path
                    const coverData = fs.readFileSync(cover, { encoding: 'base64' });
                    mediaOptions.cover = coverData;
                }
            } catch (error) {
                console.warn(`Could not load cover image: ${cover}`, error);
            }
        }

        // Handle different media types
        switch (type.toLowerCase()) {
            case 'audio':
                if (path) {
                    mediaOptions.path = path;
                    slide.addAudio(mediaOptions);
                } else if (data) {
                    mediaOptions.data = data;
                    slide.addAudio(mediaOptions);
                }
                break;

            case 'video':
                if (path) {
                    mediaOptions.path = path;
                    slide.addVideo(mediaOptions);
                } else if (data) {
                    mediaOptions.data = data;
                    slide.addVideo(mediaOptions);
                }
                break;

            case 'youtube':
                if (link) {
                    // Extract YouTube ID from link
                    let youtubeId = link;

                    // Handle common YouTube URL formats
                    if (link.includes('youtube.com') || link.includes('youtu.be')) {
                        const match = link.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
                        if (match && match[1]) {
                            youtubeId = match[1];
                        }
                    }

                    mediaOptions.link = youtubeId;
                    slide.addMedia(mediaOptions);
                }
                break;

            default:
                console.warn(`Unknown media type: ${type}, skipping`);
        }
    }
}

/**
 * Process notes for a slide
 * @param {Element} slideNode - XML slide node
 * @param {Slide} slide - pptxgen.js slide object
 * @returns {Promise<void>}
 */
async function processNotes(slideNode, slide) {
    const notesNodes = slideNode.getElementsByTagName('notes');

    if (notesNodes.length > 0) {
        const notesNode = notesNodes[0];
        const notes = notesNode.textContent;

        if (notes && notes.trim()) {
            slide.addNotes(notes.trim());
        }
    }
}
