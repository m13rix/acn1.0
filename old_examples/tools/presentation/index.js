// tools/presentation/index.js
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const presentation = {
    name: 'PresentationGenerator',
    description: 'Генерирует качественные презентации в PowerPoint по текстовому описанию. Создает презентации с любым оформлением и содержанием.\n' +
        '"prompt" - Подробное описание презентации: тема, стиль, содержание, оформление, специальные элементы\n' +
        '"filename" - Имя файла презентации (без расширения)',

    execute: async (promptOrObject, filename) => {
        // Handle both calling styles: execute({prompt, filename}) and execute(prompt, filename)
        const prompt = typeof promptOrObject === 'object' ? promptOrObject.prompt : promptOrObject;
        filename = typeof promptOrObject === 'object' ? promptOrObject.filename : filename;
        try {
            // 1. Читаем системный промпт из файла
            const systemPromptPath = path.join(__dirname, 'system_prompt.txt');
            const systemPrompt = await fs.readFile(systemPromptPath, 'utf-8');

            // 2. Логика генерации AI
            const ai = new GoogleGenAI({apiKey: "AIzaSyDBJueuMEVVb5bim4lsIrdWFXboCfiOMqY"});
            let fullResponse = '';

            const response = await ai.models.generateContentStream({
                model: "gemini-flash-latest",
                contents: prompt,
                config: {
                    systemInstruction: systemPrompt,
                }
            });

            for await (const chunk of response) {
                if (chunk.text) {
                    const textPart = chunk.text;
                    fullResponse += textPart;
                    console.log(textPart);
                }
            }

            const xmlMatch = fullResponse.match(/```xml\s*([\s\S]*?)\s*```|(<presentation[\s\S]*<\/presentation>)/);
            if (!xmlMatch) {
                throw new Error('AI не вернул корректный XML код презентации.');
            }
            const xmlCode = xmlMatch[1] || xmlMatch[2];
            console.log(xmlCode);

            // 3. Конвертация в PPTX
            const { convertPPTXMLtoPPTX } = await import('./pptxmlConverter.js');
            const outputPath = path.join('./context', `${filename}.pptx`);
            await fs.mkdir('./context', { recursive: true });
            await convertPPTXMLtoPPTX(xmlCode, outputPath);

            return `✅ Презентация "${filename}.pptx" успешно создана и сохранена.`;

        } catch (error) {
            console.error("Ошибка в PresentationGenerator:", error);
            return `❌ Ошибка создания презентации: ${error.message}`;
        }
    }
};
