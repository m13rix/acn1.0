/**
 * Script to fix existing images: remove background using rembg (ML) and trim empty space
 * 
 * Usage:
 *   node fix_images.js              - Fix all images in data/images/
 *   node fix_images.js img1.png     - Fix specific image
 *   node fix_images.js --backup     - Create backups before processing
 */

import sharp from 'sharp';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALPHA_THRESHOLD = 10;

/**
 * Remove background using rembg (Python ML library with U2-Net model)
 * Provides professional-quality background removal
 */
async function removeBackground(imageBuffer) {
    return new Promise((resolve, reject) => {
        console.log(chalk.gray('   🤖 Запуск rembg (ML модель U2-Net)...'));
        
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
            // rembg может выводить прогресс в stderr, игнорируем
            const text = chunk.toString();
            if (!text.includes('Downloading') && !text.includes('%')) {
                errorChunks.push(chunk);
            }
        });
        
        pythonProcess.on('close', (code) => {
            if (code !== 0) {
                const errorMsg = Buffer.concat(errorChunks).toString();
                reject(new Error(`rembg exited with code ${code}: ${errorMsg}`));
                return;
            }
            
            const outputBuffer = Buffer.concat(outputChunks);
            console.log(chalk.gray('   ✓ Фон удалён'));
            resolve(outputBuffer);
        });
        
        pythonProcess.on('error', (err) => {
            reject(new Error(`Failed to start Python: ${err.message}`));
        });
        
        // Send image data to Python process
        pythonProcess.stdin.write(imageBuffer);
        pythonProcess.stdin.end();
    });
}

/**
 * Trim transparent space around object
 */
async function trimTransparent(imageBuffer, padding = 0) {
    const image = sharp(imageBuffer);
    const { data, info } = await image
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    
    const width = info.width;
    const height = info.height;
    const channels = info.channels;
    
    let minX = width, minY = height, maxX = 0, maxY = 0;
    
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
    
    if (minX > maxX || minY > maxY) {
        return { buffer: imageBuffer, trimmed: false, originalSize: { width, height }, newSize: { width, height } };
    }
    
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(width - 1, maxX + padding);
    maxY = Math.min(height - 1, maxY + padding);
    
    const cropWidth = maxX - minX + 1;
    const cropHeight = maxY - minY + 1;
    
    if (cropWidth === width && cropHeight === height) {
        return { buffer: imageBuffer, trimmed: false, originalSize: { width, height }, newSize: { width, height } };
    }
    
    const croppedBuffer = await sharp(imageBuffer)
        .extract({
            left: minX,
            top: minY,
            width: cropWidth,
            height: cropHeight
        })
        .png()
        .toBuffer();
    
    return { 
        buffer: croppedBuffer, 
        trimmed: true, 
        originalSize: { width, height }, 
        newSize: { width: cropWidth, height: cropHeight }
    };
}

/**
 * Process a single image
 */
async function processImage(imagePath, createBackup = false) {
    const filename = path.basename(imagePath);
    console.log(chalk.blue(`\n📷 Обработка: ${filename}`));
    
    try {
        // Read original image
        const originalBuffer = await fs.readFile(imagePath);
        const originalMetadata = await sharp(originalBuffer).metadata();
        
        console.log(chalk.gray(`   Исходный размер: ${originalMetadata.width}x${originalMetadata.height}`));
        
        // Create backup if requested
        if (createBackup) {
            const backupDir = path.join(path.dirname(imagePath), 'backup');
            if (!fsSync.existsSync(backupDir)) {
                await fs.mkdir(backupDir, { recursive: true });
            }
            const backupPath = path.join(backupDir, filename);
            await fs.writeFile(backupPath, originalBuffer);
            console.log(chalk.gray(`   📁 Бэкап: backup/${filename}`));
        }
        
        // Step 1: Remove background using rembg ML
        const noBgBuffer = await removeBackground(originalBuffer);
        
        // Step 2: Trim transparent space
        console.log(chalk.gray('   ✂️ Обрезка пустого пространства...'));
        const trimResult = await trimTransparent(noBgBuffer, 0);
        
        let finalBuffer = trimResult.buffer;
        
        if (trimResult.trimmed) {
            const { originalSize, newSize } = trimResult;
            const trimPercent = Math.round((1 - (newSize.width * newSize.height) / (originalSize.width * originalSize.height)) * 100);
            console.log(chalk.gray(`   → ${originalSize.width}x${originalSize.height} → ${newSize.width}x${newSize.height} (убрано ${trimPercent}%)`));
        } else {
            console.log(chalk.gray('   → Объект уже занимает всё изображение'));
        }
        
        // Save processed image
        await fs.writeFile(imagePath, finalBuffer);
        
        const newMetadata = await sharp(finalBuffer).metadata();
        console.log(chalk.green(`   ✅ Готово: ${newMetadata.width}x${newMetadata.height}`));
        
        return { success: true, filename };
    } catch (error) {
        console.error(chalk.red(`   ❌ Ошибка: ${error.message}`));
        return { success: false, filename, error: error.message };
    }
}

/**
 * Main function
 */
async function main() {
    console.log(chalk.cyan.bold('\n🖼️  Image Fixer - ML удаление фона (rembg) + обрезка пустого пространства\n'));
    
    const args = process.argv.slice(2);
    const createBackup = args.includes('--backup');
    const specificFiles = args.filter(arg => !arg.startsWith('--') && arg.endsWith('.png'));
    
    const imagesDir = path.join(__dirname, 'data', 'images');
    
    // Check if images directory exists
    if (!fsSync.existsSync(imagesDir)) {
        console.error(chalk.red(`❌ Папка не найдена: ${imagesDir}`));
        process.exit(1);
    }
    
    let filesToProcess;
    
    if (specificFiles.length > 0) {
        // Process specific files
        filesToProcess = specificFiles.map(f => path.join(imagesDir, f));
        console.log(chalk.gray(`Обработка файлов: ${specificFiles.join(', ')}`));
    } else {
        // Process all images in directory
        const allFiles = await fs.readdir(imagesDir);
        filesToProcess = allFiles
            .filter(f => f.endsWith('.png'))
            .map(f => path.join(imagesDir, f));
        console.log(chalk.gray(`Найдено изображений: ${filesToProcess.length}`));
    }
    
    if (filesToProcess.length === 0) {
        console.log(chalk.yellow('⚠️ Нет изображений для обработки'));
        return;
    }
    
    if (createBackup) {
        console.log(chalk.gray('📁 Режим с бэкапами включён'));
    }
    
    console.log(chalk.yellow('\n⚠️  Первый запуск может занять время - загрузка ML модели (~170MB)\n'));
    
    // Process each image
    const results = { success: 0, failed: 0 };
    
    for (const imagePath of filesToProcess) {
        if (!fsSync.existsSync(imagePath)) {
            console.log(chalk.yellow(`⚠️ Файл не найден: ${path.basename(imagePath)}`));
            results.failed++;
            continue;
        }
        
        const result = await processImage(imagePath, createBackup);
        if (result.success) {
            results.success++;
        } else {
            results.failed++;
        }
    }
    
    // Summary
    console.log(chalk.cyan.bold('\n📊 Результаты:'));
    console.log(chalk.green(`   ✅ Успешно: ${results.success}`));
    if (results.failed > 0) {
        console.log(chalk.red(`   ❌ Ошибки: ${results.failed}`));
    }
    console.log();
}

main().catch(error => {
    console.error(chalk.red('Критическая ошибка:'), error);
    process.exit(1);
});
