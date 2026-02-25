#!/usr/bin/env npx tsx
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { Command } from 'commander';
import { GoogleGenAI } from '@google/genai';
import readline from 'readline/promises';
import { createReadStream } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const DEFAULT_MODEL = 'gemini-3-flash-preview';
const DEFAULT_STORE_NAME = 'rag-test-store';

// Check for API Key
const GEMINI_API_KEY = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error(chalk.red('\nERROR: GEMINI_KEY is not set in .env file.'));
    console.log(chalk.yellow('Please add GEMINI_KEY=your_api_key to your .env file.\n'));
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const program = new Command();

program
    .name('rag-test')
    .description('Premium CLI for Gemini PDF RAG testing')
    .version('1.0.0');

/**
 * Uploads a PDF to Gemini File Search Store
 */
program
    .command('upload')
    .description('Upload a PDF file to a File Search Store')
    .argument('<path>', 'Path to the PDF file')
    .option('-s, --store <name>', 'Store name', DEFAULT_STORE_NAME)
    .action(async (filePath, options) => {
        try {
            const absolutePath = path.resolve(filePath);
            const stats = await fs.stat(absolutePath);

            if (!stats.isFile()) {
                throw new Error(`${filePath} is not a file.`);
            }

            console.log(chalk.blue(`\n[File Search] Uploading ${path.basename(absolutePath)} (${(stats.size / 1024 / 1024).toFixed(2)} MB)...`));

            // 1. Get or Create Store
            let storeName = options.store;
            const stores = await ai.fileSearchStores.list();
            let targetStore = null;

            for await (const store of stores) {
                if (store.displayName === storeName || store.name === storeName || store.name.endsWith(storeName)) {
                    targetStore = store.name;
                    break;
                }
            }

            if (!targetStore) {
                console.log(chalk.gray(`[File Search] Creating new store: ${storeName}`));
                const newStore = await ai.fileSearchStores.create({
                    config: { displayName: storeName }
                });
                targetStore = newStore.name;
            }

            console.log(chalk.gray(`[File Search] Target Store: ${targetStore}`));

            // 2. Upload and Index
            let operation = await ai.fileSearchStores.uploadToFileSearchStore({
                file: absolutePath,
                fileSearchStoreName: targetStore,
                config: {
                    displayName: path.basename(absolutePath),
                    chunkingConfig: {
                        whiteSpaceConfig: {
                            maxTokensPerChunk: 512,
                            maxOverlapTokens: 50
                        }
                    }
                }
            });

            // 3. Wait for indexing completion by polling document state
            const documentName = operation.response?.documentName;
            if (!documentName) {
                console.log(chalk.green(`\n✅ Upload complete! (No document tracking available)`));
                console.log(chalk.gray(`Store ID: ${targetStore}\n`));
                return;
            }

            process.stdout.write(chalk.cyan('[File Search] Indexing: '));
            let doc = await ai.fileSearchStores.documents.get({ name: documentName });
            while (doc.state === 'STATE_PENDING' || doc.state === 'STATE_UNSPECIFIED') {
                process.stdout.write(chalk.cyan('.'));
                await new Promise(resolve => setTimeout(resolve, 3000));
                doc = await ai.fileSearchStores.documents.get({ name: documentName });
            }
            process.stdout.write('\n');

            if (doc.state === 'STATE_ACTIVE') {
                console.log(chalk.green(`\n✅ Successfully indexed ${path.basename(absolutePath)}!`));
            } else {
                console.log(chalk.red(`\n⚠️ Indexing finished with state: ${doc.state}`));
            }
            console.log(chalk.gray(`Store ID: ${targetStore}`));
            console.log(chalk.gray(`Document: ${documentName}\n`));

        } catch (error: any) {
            console.error(chalk.red(`\n❌ Error: ${error.message}`));
            if (error.stack) console.error(chalk.gray(error.stack));
        }
    });

/**
 * Interactive Chat Loop
 */
program
    .command('chat')
    .description('Start an interactive chat session with indexed documents')
    .option('-s, --store <name>', 'Store name to use', DEFAULT_STORE_NAME)
    .option('-m, --model <name>', 'Gemini model to use', DEFAULT_MODEL)
    .action(async (options) => {
        try {
            // Find store
            const stores = await ai.fileSearchStores.list();
            let targetStore = null;
            for await (const store of stores) {
                if (store.displayName === options.store || store.name === options.store || store.name.endsWith(options.store)) {
                    targetStore = store.name;
                    break;
                }
            }

            if (!targetStore) {
                throw new Error(`Store "${options.store}" not found. Upload some files first.`);
            }

            console.log(chalk.magenta(`\n=== Gemini File Search Chat ===`));
            console.log(chalk.gray(`Model: ${options.model}`));
            console.log(chalk.gray(`Store: ${targetStore}`));
            console.log(chalk.gray(`Type 'exit' or 'quit' to end session.\n`));

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            while (true) {
                const question = await rl.question(chalk.green('You: '));

                if (['exit', 'quit'].includes(question.toLowerCase().trim())) {
                    break;
                }

                if (!question.trim()) continue;

                process.stdout.write(chalk.yellow('Gemini: '));

                try {
                    const response = await ai.models.generateContent({
                        model: options.model,
                        contents: [{ role: 'user', parts: [{ text: question }] }],
                        config: {
                            tools: [{
                                fileSearch: {
                                    topK: 50,
                                    fileSearchStoreNames: [targetStore]
                                }
                            }]
                        }
                    });

                    console.log(response.text || chalk.red('[No response]'));
                    console.log(); // New line
                } catch (err: any) {
                    console.error(chalk.red(`\n[API Error] ${err.message}\n`));
                }
            }

            rl.close();
            console.log(chalk.magenta('\nGoodbye!\n'));

        } catch (error: any) {
            console.error(chalk.red(`\n❌ Error: ${error.message}\n`));
        }
    });

/**
 * List Stores
 */
program
    .command('list')
    .description('List all available File Search Stores')
    .action(async () => {
        try {
            console.log(chalk.blue('\n[File Search] Your Stores:'));
            const storesPager = await ai.fileSearchStores.list();

            let count = 0;
            // The pager itself is iterable in version 0.6.1
            for await (const store of storesPager) {
                console.log(chalk.white(` - ${chalk.bold(store.displayName || 'Unnamed')} (${store.name})`));
                count++;
            }

            if (count === 0) console.log(chalk.gray(' No stores found.'));
            console.log();
        } catch (error: any) {
            console.error(chalk.red(`\n❌ Error: ${error.message}`));
            if (error.message.includes('undefined')) {
                console.log(chalk.yellow('Tip: Ensure you have initialized File Search on your Google Cloud project / AI Studio account.'));
            }
        }
    });

/**
 * Get Store Info
 */
program
    .command('info')
    .description('Show details and files in a specific File Search Store')
    .argument('<name>', 'DisplayName or ID of the store')
    .action(async (name) => {
        try {
            const stores = await ai.fileSearchStores.list();
            let target = null;
            for await (const store of stores) {
                if (store.displayName === name || store.name === name || store.name.endsWith(name)) {
                    target = store;
                    break;
                }
            }

            if (!target) {
                throw new Error(`Store "${name}" not found.`);
            }

            console.log(chalk.blue(`\n[Store Info] ${chalk.bold(target.displayName)}`));
            console.log(chalk.gray(`ID: ${target.name}`));
            console.log(chalk.gray(`Created: ${target.createTime}`));

            console.log(chalk.cyan('\nFiles:'));
            const docs = await ai.fileSearchStores.documents.list({ parent: target.name });
            let docCount = 0;
            for await (const doc of docs) {
                console.log(chalk.white(` - ${doc.displayName || doc.name} (${doc.name})`));
                docCount += 1;
            }
            if (docCount === 0) console.log(chalk.gray(' No files in this store.'));
            console.log();
        } catch (error: any) {
            console.error(chalk.red(`\n❌ Error: ${error.message}\n`));
        }
    });


/**
 * Delete Store
 */
program
    .command('delete')
    .description('Delete a File Search Store')
    .argument('<name>', 'DisplayName or ID of the store')
    .action(async (name) => {
        try {
            const stores = await ai.fileSearchStores.list();
            let target = null;
            for await (const store of stores) {
                if (store.displayName === name || store.name === name || store.name.endsWith(name)) {
                    target = store.name;
                    break;
                }
            }

            if (!target) {
                throw new Error(`Store "${name}" not found.`);
            }

            console.log(chalk.yellow(`\n[File Search] Deleting store ${target}...`));
            await ai.fileSearchStores.delete({
                name: target,
                config: { force: true }
            });
            console.log(chalk.green(`✅ Deleted store successfully.\n`));
        } catch (error: any) {
            console.error(chalk.red(`\n❌ Error: ${error.message}\n`));
        }
    });

program.parse();
