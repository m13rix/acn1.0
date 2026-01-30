// PDF Generation tool - High-quality PDF generation with AI-powered images
import sharp from 'sharp';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = process.env.OPENROUTER_API_KEY || "<YOUR_OPENROUTER_API_KEY>";
const MODEL = "google/gemini-2.5-flash-image";

/**
 * CSS rules for smart page breaks - prevents ugly content splitting
 * @returns {string} CSS rules for page break management
 */
function getSmartPageBreakCSS() {
    return `
<style id="smart-page-breaks">
    /* Prevent breaks inside these elements */
    h1, h2, h3, h4, h5, h6,
    .section, .content-page, .cover-page,
    .focus-box, .column-left, .column-right,
    table, .two-col-grid, .split-focus-diagram,
    pre, code, blockquote {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
    }
    
    /* Prevent orphan headings - never break right after a heading */
    h1, h2, h3, h4, h5, h6 {
        page-break-after: avoid !important;
        break-after: avoid !important;
        /* Keep heading with at least the next element */
        orphans: 3;
        widows: 3;
    }
    
    /* Group heading with the following content */
    h2 + *, h3 + *, h4 + * {
        page-break-before: avoid !important;
        break-before: avoid !important;
    }
    
    /* Major sections should start on a new page if not first */
    h2:not(:first-child) {
        page-break-before: auto;
        break-before: auto;
    }
    
    /* Keep lists together */
    ul, ol {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
    }
    
    /* Keep table rows together */
    tr {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
    }
    
    /* General orphan and widow control */
    p {
        orphans: 3;
        widows: 3;
    }
    
    /* Utility classes for manual control */
    .page-break-before {
        page-break-before: always !important;
        break-before: always !important;
    }
    
    .page-break-after {
        page-break-after: always !important;
        break-after: always !important;
    }
    
    .no-page-break {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
    }
    
    .keep-together {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
        display: block;
    }
    
    /* Vertical centering helper - use this class on elements that should be centered when they start on a new page */
    .center-on-page {
        min-height: 100vh;
        width: 100%;
        display: flex;
        flex-direction: column;
        justify-content: center;
        box-sizing: border-box;
        padding-top: 0;
        padding-bottom: 0;
    }
</style>`;
}

/**
 * Remove background from image using rembg (ML-based, U2-Net model)
 * This provides professional-quality background removal without artifacts
 * 
 * @param {Buffer} imageBuffer - Original image buffer
 * @returns {Promise<Buffer>} Image buffer with transparent background
 */
async function removeWhiteBackground(imageBuffer) {
    return new Promise((resolve, reject) => {
        try {
            console.log(chalk.gray('  → Удаление фона с помощью rembg (ML модель)...'));
            
            // Use Python rembg via stdin/stdout for efficient processing
            const pythonProcess = spawn('python', ['-c', `
import sys
from rembg import remove

# Read image from stdin
input_data = sys.stdin.buffer.read()

# Remove background using U2-Net model
output_data = remove(input_data)

# Write result to stdout
sys.stdout.buffer.write(output_data)
`]);
            
            const outputChunks = [];
            const errorChunks = [];
            
            pythonProcess.stdout.on('data', (chunk) => {
                outputChunks.push(chunk);
            });
            
            pythonProcess.stderr.on('data', (chunk) => {
                errorChunks.push(chunk);
            });
            
            pythonProcess.on('close', (code) => {
                if (code !== 0) {
                    const errorMsg = Buffer.concat(errorChunks).toString();
                    console.error(chalk.red('  ❌ rembg error:'), errorMsg);
                    reject(new Error(`rembg process exited with code ${code}: ${errorMsg}`));
                    return;
                }
                
                const outputBuffer = Buffer.concat(outputChunks);
                console.log(chalk.gray('  ✓ Фон успешно удалён'));
                resolve(outputBuffer);
            });
            
            pythonProcess.on('error', (err) => {
                console.error(chalk.red('  ❌ Failed to start rembg:'), err.message);
                reject(err);
            });
            
            // Send image data to Python process
            pythonProcess.stdin.write(imageBuffer);
            pythonProcess.stdin.end();
            
        } catch (error) {
            console.error(chalk.red('Ошибка при удалении фона:'), error.message);
            reject(error);
        }
    });
}

/**
 * Trim transparent/empty space around the object in an image
 * Finds the bounding box of non-transparent pixels and crops to it
 * 
 * @param {Buffer} imageBuffer - Image buffer (should have alpha channel)
 * @param {number} padding - Optional padding to add around the object (default: 0)
 * @returns {Promise<Buffer>} Trimmed image buffer
 */
async function trimTransparent(imageBuffer, padding = 0) {
    try {
        const image = sharp(imageBuffer);
        const { data, info } = await image
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        
        const width = info.width;
        const height = info.height;
        const channels = info.channels;
        
        // Find bounding box of non-transparent pixels
        let minX = width;
        let minY = height;
        let maxX = 0;
        let maxY = 0;
        
        const ALPHA_THRESHOLD = 10; // Consider pixel visible if alpha > this
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const offset = (y * width + x) * channels;
                const alpha = data[offset + 3];
                
                if (alpha > ALPHA_THRESHOLD) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        
        // Check if image is completely transparent
        if (minX > maxX || minY > maxY) {
            console.log(chalk.yellow('  ⚠️ Изображение полностью прозрачное, пропускаем обрезку'));
            return imageBuffer;
        }
        
        // Add padding
        minX = Math.max(0, minX - padding);
        minY = Math.max(0, minY - padding);
        maxX = Math.min(width - 1, maxX + padding);
        maxY = Math.min(height - 1, maxY + padding);
        
        const cropWidth = maxX - minX + 1;
        const cropHeight = maxY - minY + 1;
        
        // Skip if nothing to crop (object fills entire image)
        if (cropWidth === width && cropHeight === height) {
            console.log(chalk.gray('  → Объект уже занимает всё изображение'));
            return imageBuffer;
        }
        
        const trimPercentX = Math.round((1 - cropWidth / width) * 100);
        const trimPercentY = Math.round((1 - cropHeight / height) * 100);
        console.log(chalk.gray(`  → Обрезка: ${width}x${height} → ${cropWidth}x${cropHeight} (убрано ${trimPercentX}% по X, ${trimPercentY}% по Y)`));
        
        // Crop the image
        return await sharp(imageBuffer)
            .extract({
                left: minX,
                top: minY,
                width: cropWidth,
                height: cropHeight
            })
            .png()
            .toBuffer();
    } catch (error) {
        console.error(chalk.red('Ошибка при обрезке изображения:'), error.message);
        throw error;
    }
}

/**
 * Full image processing pipeline: remove white background + trim
 * 
 * @param {Buffer} imageBuffer - Original image buffer
 * @param {Object} options - Processing options
 * @param {boolean} options.removeBackground - Remove white background (default: true)
 * @param {boolean} options.trim - Trim transparent space (default: true)
 * @param {number} options.padding - Padding after trim (default: 0)
 * @returns {Promise<Buffer>} Processed image buffer
 */
async function processImage(imageBuffer, options = {}) {
    const {
        removeBackground = true,
        trim = true,
        padding = 0
    } = options;
    
    let result = imageBuffer;
    
    if (removeBackground) {
        console.log(chalk.gray('🔄 Удаление белого фона...'));
        result = await removeWhiteBackground(result);
    }
    
    if (trim) {
        console.log(chalk.gray('✂️ Обрезка пустого пространства...'));
        result = await trimTransparent(result, padding);
    }
    
    return result;
}

/**
 * Get next available image index
 * @returns {Promise<number>} Next available index
 */
async function getNextImageIndex() {
    const imagesDir = path.join(__dirname, 'data', 'images');

    try {
        const files = await fs.readdir(imagesDir);
        const imageFiles = files.filter(f => f.startsWith('img') && f.endsWith('.png'));

        if (imageFiles.length === 0) {
            return 1;
        }

        // Extract numbers from filenames
        const numbers = imageFiles.map(f => {
            const match = f.match(/img(\d+)\.png/);
            return match ? parseInt(match[1]) : 0;
        });

        return Math.max(...numbers) + 1;
    } catch (error) {
        return 1;
    }
}

/**
 * Generate an image using OpenRouter API
 * @param {string} prompt - English prompt for image generation
 * @param {boolean} transparent - Whether to make background transparent (default: true)
 * @returns {Promise<string>} Path to generated image
 */
async function generateImage(prompt, transparent = true) {
    try {
        console.log(chalk.blue('\n🎨 Генерация изображения...'));
        console.log(chalk.gray(`Промпт: ${prompt}`));

        const url = "https://openrouter.ai/api/v1/chat/completions";

        // Add white background instruction if transparency is requested
        let finalPrompt = prompt;
        if (transparent) {
            finalPrompt += "\nMake the background purely white, no shadows";
        }

        const payload = {
            model: MODEL,
            messages: [
                { role: "user", content: finalPrompt }
            ],
            modalities: ["image", "text"],
            image_config: {
                aspect_ratio: "1:1"
            },
            stream: false
        };

        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`OpenRouter error ${res.status}: ${text}`);
        }

        const json = await res.json();

        // Extract image data from response
        const message = json.choices?.[0]?.message;
        if (!message || !message.images) {
            throw new Error("No images in response — check model/modalities.");
        }

        const images = message.images.map(img => img.image_url?.url);
        if (!images || images.length === 0 || !images[0]) {
            throw new Error('Не удалось получить изображение из ответа API');
        }

        // Extract base64 data from data:image/png;base64,... format
        const imageDataUrl = images[0];
        const base64Match = imageDataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
        if (!base64Match) {
            throw new Error('Неверный формат данных изображения');
        }

        const base64Data = base64Match[1];
        let imageBuffer = Buffer.from(base64Data, 'base64');

        // Process image if transparency is requested
        if (transparent) {
            imageBuffer = await processImage(imageBuffer, {
                removeBackground: true,
                trim: true,
                padding: 0
            });
        }

        // Get next available index
        const imageIndex = await getNextImageIndex();
        const filename = `img${imageIndex}.png`;
        const imagePath = path.join(__dirname, 'data', 'images', filename);

        // Save image
        await fs.writeFile(imagePath, imageBuffer);

        console.log(chalk.green(`✅ Изображение успешно сгенерировано: ./images/${filename}`));

        return `Изображение успешно сгенерировано и сохранено в ./images/${filename}`;

    } catch (error) {
        console.error(chalk.red('❌ Ошибка генерации изображения:'), error.message);
        throw error;
    }
}

/**
 * Generate an HTML page
 * @param {string} htmlContent - Full HTML content of the page
 * @param {number} pageIndex - Page index (0-based)
 * @param {boolean} smartPageBreaks - Enable smart page break management (default: true)
 * @returns {Promise<string>} Success message with page filename
 */
async function generatePage(htmlContent, pageIndex, smartPageBreaks = true) {
    try {
        console.log(chalk.blue(`\n📄 Генерация страницы ${pageIndex}...`));

        let finalHtml = htmlContent.trim();

        // Check if HTML has doctype and basic structure
        const hasDoctype = /<!DOCTYPE html>/i.test(finalHtml);
        const hasHtmlTag = /<html/i.test(finalHtml);
        const hasHead = /<head/i.test(finalHtml);
        const hasBody = /<body/i.test(finalHtml);

        // If missing basic structure, add it
        if (!hasDoctype || !hasHtmlTag || !hasHead || !hasBody) {
            // Extract body content if body tags exist
            let bodyContent = finalHtml;
            const bodyMatch = finalHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
            if (bodyMatch) {
                bodyContent = bodyMatch[1];
            }

            finalHtml = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="./styles.css">
    <title>Страница ${pageIndex + 1}</title>
</head>
<body>
${bodyContent}
</body>
</html>`;
        } else {
            // Add stylesheet link if not present
            if (!finalHtml.includes('styles.css')) {
                finalHtml = finalHtml.replace(
                    /<\/head>/i,
                    '    <link rel="stylesheet" href="./styles.css">\n</head>'
                );
            }

            // Add UTF-8 charset if not present
            if (!finalHtml.includes('charset')) {
                finalHtml = finalHtml.replace(
                    /<head([^>]*)>/i,
                    '<head$1>\n    <meta charset="UTF-8">'
                );
            }
        }

        // Add smart page break CSS if enabled
        if (smartPageBreaks && !finalHtml.includes('smart-page-breaks')) {
            const pageBreakCSS = getSmartPageBreakCSS();
            finalHtml = finalHtml.replace(
                /<\/head>/i,
                `    ${pageBreakCSS}\n</head>`
            );
            console.log(chalk.gray('🔧 Добавлены умные правила разрыва страниц'));
        }

        const filename = `page${pageIndex}.html`;
        const pagePath = path.join(__dirname, 'data', filename);

        await fs.writeFile(pagePath, finalHtml, 'utf-8');

        console.log(chalk.green(`✅ Страница успешно создана: ${filename}`));

        return `Страница успешно сгенерирована: ${filename}`;

    } catch (error) {
        console.error(chalk.red('❌ Ошибка генерации страницы:'), error.message);
        throw error;
    }
}

/**
 * Generate CSS stylesheet
 * @param {string} cssContent - Full CSS code
 * @returns {Promise<string>} Success message
 */
async function generateStyle(cssContent) {
    try {
        console.log(chalk.blue('\n🎨 Генерация стилей...'));

        const stylesPath = path.join(__dirname, 'data', 'styles.css');
        await fs.writeFile(stylesPath, cssContent, 'utf-8');

        console.log(chalk.green('✅ Файл стилей успешно создан: styles.css'));

        return 'Файл стилей успешно создан: styles.css';

    } catch (error) {
        console.error(chalk.red('❌ Ошибка генерации стилей:'), error.message);
        throw error;
    }
}

/**
 * Apply smart page breaks to existing HTML files
 * @returns {Promise<number>} Number of files updated
 */
async function applySmartPageBreaks() {
    try {
        console.log(chalk.blue('\n🔧 Применение умных правил разрыва страниц...'));

        const dataDir = path.join(__dirname, 'data');
        const files = await fs.readdir(dataDir);
        const pageFiles = files.filter(f => f.startsWith('page') && f.endsWith('.html'));

        let updatedCount = 0;

        for (const pageFile of pageFiles) {
            const pagePath = path.join(dataDir, pageFile);
            let content = await fs.readFile(pagePath, 'utf-8');

            // Check if already has smart page breaks
            if (!content.includes('smart-page-breaks')) {
                const pageBreakCSS = getSmartPageBreakCSS();
                content = content.replace(
                    /<\/head>/i,
                    `    ${pageBreakCSS}\n</head>`
                );
                await fs.writeFile(pagePath, content, 'utf-8');
                updatedCount++;
                console.log(chalk.gray(`✓ Обновлен: ${pageFile}`));
            }
        }

        console.log(chalk.green(`✅ Обновлено файлов: ${updatedCount}`));
        return updatedCount;

    } catch (error) {
        console.error(chalk.red('❌ Ошибка применения правил:'), error.message);
        throw error;
    }
}

/**
 * Build PDF document from all HTML pages
 * @returns {Promise<string>} Path to generated PDF
 */
async function buildDoc() {
    let browser = null;

    try {
        console.log(chalk.blue('\n📚 Создание PDF документа...'));

        const dataDir = path.join(__dirname, 'data');

        // Apply smart page breaks to existing files first
        await applySmartPageBreaks();

        // Find all page files
        const files = await fs.readdir(dataDir);
        const pageFiles = files
            .filter(f => f.startsWith('page') && f.endsWith('.html'))
            .sort((a, b) => {
                const numA = parseInt(a.match(/page(\d+)\.html/)[1]);
                const numB = parseInt(b.match(/page(\d+)\.html/)[1]);
                return numA - numB;
            });

        if (pageFiles.length === 0) {
            throw new Error('Не найдено ни одной HTML страницы для конвертации');
        }

        console.log(chalk.gray(`Найдено страниц: ${pageFiles.length}`));

        // Launch browser
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
        });

        const page = await browser.newPage();
        // Align viewport with A4 landscape to help layout calculations
        await page.setViewport({ width: 1247, height: 882 });

        // Set longer timeout for complex pages
        page.setDefaultTimeout(60000);
        page.setDefaultNavigationTimeout(60000);

        // Array to store PDF buffers
        const pdfBuffers = [];

        // Convert each HTML page to PDF
        for (const pageFile of pageFiles) {
            console.log(chalk.gray(`Конвертация: ${pageFile}`));

            const htmlPath = path.join(dataDir, pageFile);

            // Use file:// protocol to load HTML with proper local resource loading
            const fileUrl = `file:///${htmlPath.replace(/\\/g, '/')}`;

            try {
                // Navigate to the file URL - this properly handles relative paths for images/css
                await page.goto(fileUrl, {
                    waitUntil: 'domcontentloaded', // Changed from 'networkidle0' for faster loading
                    timeout: 60000
                });

                // Wait a bit for any CSS/images to load
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Apply smart vertical centering for content that naturally breaks to new pages
                await page.evaluate(() => {
                    // Функция для вычисления положения элемента на странице
                    function getPagePosition(element) {
                        const rect = element.getBoundingClientRect();
                        const pageHeight = window.innerHeight || 882;
                        const offsetY = rect.top + window.scrollY;
                        const pageNumber = Math.floor(offsetY / pageHeight);
                        const positionOnPage = offsetY % pageHeight;
                        return { pageNumber, positionOnPage, offsetY };
                    }

                    // Найти все основные контентные блоки (h2, h3, sections)
                    const contentBlocks = document.querySelectorAll('h2, h3, .section, .content-page > div');

                    contentBlocks.forEach((element, index) => {
                        // Пропускаем первый элемент
                        if (index === 0) return;

                        const position = getPagePosition(element);

                        // Если элемент находится в верхней части страницы (первые 100px)
                        // и это не первая страница, значит он был перенесен из-за page-break
                        if (position.positionOnPage < 140 && position.pageNumber > 0) {
                            // Проверяем, не является ли это намеренной обложкой
                            const isCoverPage = element.classList.contains('cover-page') ||
                                              element.parentElement?.classList.contains('cover-page');

                            if (!isCoverPage) {
                                // Снимаем предыдущие настройки, если они были
                                element.style.marginTop = '';
                                element.style.paddingTop = '';
                                element.classList.remove('center-on-page');

                                const rect = element.getBoundingClientRect();
                                const pageHeight = window.innerHeight || 882;
                                const elementHeight = rect.height;
                                const availableSpace = pageHeight - elementHeight;
                                const margin = Math.max(availableSpace / 2, 40);

                                // Если элемент выше страницы, оставляем стандартный отступ
                                if (availableSpace > 0) {
                                    element.style.marginTop = `${margin}px`;
                                    element.classList.add('center-on-page');
                                } else {
                                    element.style.marginTop = '40px';
                                }
                                element.style.paddingTop = '0';
                            }
                        } else {
                            element.classList.remove('center-on-page');
                            element.style.marginTop = '';
                            element.style.paddingTop = '';
                        }
                    });
                });
            } catch (error) {
                console.log(chalk.yellow(`⚠️  Предупреждение при загрузке ${pageFile}: ${error.message}`));
                console.log(chalk.gray('Продолжаем генерацию PDF...'));
            }

            // Generate PDF for this page
            const pdfBuffer = await page.pdf({
                format: 'A4',
                landscape: true, // Альбомная ориентация
                printBackground: true,
                margin: {
                    top: '0',
                    right: '0',
                    bottom: '0',
                    left: '0'
                },
                preferCSSPageSize: false
            });

            pdfBuffers.push(pdfBuffer);
        }

        await browser.close();

        // For simplicity, if there's only one page, save it directly
        // If multiple pages, we need to merge PDFs
        if (pdfBuffers.length === 1) {
            const outputPath = path.join(dataDir, 'cheap_setup.pdf');
            await fs.writeFile(outputPath, pdfBuffers[0]);
            console.log(chalk.green('✅ PDF документ успешно создан: cheap_setup.pdf'));
            return `PDF документ успешно создан: generatedDocument.pdf (1 страница)`;
        } else {
            // For multiple pages, we need pdf-lib
            const { PDFDocument } = await import('pdf-lib');

            const mergedPdf = await PDFDocument.create();

            for (const pdfBuffer of pdfBuffers) {
                const pdf = await PDFDocument.load(pdfBuffer);
                const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                copiedPages.forEach((page) => mergedPdf.addPage(page));
            }

            const mergedPdfBytes = await mergedPdf.save();
            const outputPath = path.join(dataDir, 'cheap_setup.pdf');
            await fs.writeFile(outputPath, mergedPdfBytes);

            console.log(chalk.green(`✅ PDF документ успешно создан: generatedDocument.pdf (${pdfBuffers.length} страниц)`));
            return `PDF документ успешно создан: generatedDocument.pdf (${pdfBuffers.length} страниц)`;
        }

    } catch (error) {
        console.error(chalk.red('❌ Ошибка создания PDF:'), error.message);
        if (browser) {
            await browser.close();
        }
        throw error;
    }
}

// Export tool in system format
export const pdfGen = {
    /**
     * Generate an image using OpenRouter API
     * @param {string} prompt - English prompt for image generation
     * @param {boolean} transparent - Whether to make background transparent (default: true)
     * @returns {Promise<string>} Path to generated image
     */
    generateImage: async (prompt, transparent = true) => {
        try {
            console.log(chalk.blue('\n🤖 Выполняется операция: pdfGen.generateImage'));

            if (!prompt) {
                throw new Error('Требуется параметр prompt');
            }

            return await generateImage(prompt, transparent);
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в pdfGen.generateImage:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    },

    /**
     * Generate an HTML page
     * @param {string} htmlContent - Full HTML content of the page
     * @param {number} pageIndex - Page index (0-based)
     * @returns {Promise<string>} Success message with page filename
     */
    generatePage: async (htmlContent, pageIndex) => {
        try {
            console.log(chalk.blue('\n🤖 Выполняется операция: pdfGen.generatePage'));

            if (!htmlContent) {
                throw new Error('Требуется параметр htmlContent');
            }

            if (pageIndex === undefined || pageIndex === null) {
                throw new Error('Требуется параметр pageIndex');
            }

            return await generatePage(htmlContent, pageIndex);
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в pdfGen.generatePage:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    },

    /**
     * Generate CSS stylesheet
     * @param {string} cssContent - Full CSS code
     * @returns {Promise<string>} Success message
     */
    generateStyle: async (cssContent) => {
        try {
            console.log(chalk.blue('\n🤖 Выполняется операция: pdfGen.generateStyle'));

            if (!cssContent) {
                throw new Error('Требуется параметр cssContent');
            }

            return await generateStyle(cssContent);
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в pdfGen.generateStyle:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    },

    /**
     * Build PDF document from all HTML pages
     * @returns {Promise<string>} Path to generated PDF
     */
    buildDoc: async () => {
        try {
            console.log(chalk.blue('\n🤖 Выполняется операция: pdfGen.buildDoc'));

            return await buildDoc();
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в pdfGen.buildDoc:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    },

    /**
     * Apply smart page break rules to existing HTML files
     * Useful for regenerating PDF with better page breaks
     * @returns {Promise<string>} Success message with number of files updated
     */
    applySmartPageBreaks: async () => {
        try {
            console.log(chalk.blue('\n🤖 Выполняется операция: pdfGen.applySmartPageBreaks'));

            const count = await applySmartPageBreaks();
            return `Умные правила разрыва страниц применены к ${count} файлам`;
        } catch (error) {
            console.error(chalk.red('❌ Ошибка в pdfGen.applySmartPageBreaks:'), error.message);
            return `Ошибка: ${error.message}`;
        }
    }
};

