// Search tool - Web search with Exa Answer API and Gemini Google Search
// Supports automatic custom UI interfaces when toolUI is available
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import chalk from 'chalk';
import Exa from "exa-js";
import { encode } from '@toon-format/toon';

// ============================================
// Custom UI HTML Templates - Modern Dark Glassmorphism
// ============================================

const SEARCH_UI_TEMPLATE = `
<div class="container">
    <!-- Search Header -->
    <div class="header">
        <div class="icon-box">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
        </div>
        <div class="header-content">
            <div id="query-text" class="query">Initializing search...</div>
            <div id="engine-text" class="engine">System</div>
        </div>
    </div>

    <!-- Active Status / Stages -->
    <div id="status-bar" class="status-bar">
        <div class="spinner"></div>
        <span id="status-text">Connecting...</span>
    </div>
    
    <!-- Found Results (Horizontal Scroll) -->
    <div id="results-section" class="section" style="display: none;">
        <div class="section-title">FOUND SOURCES <span id="result-count" class="count-badge">0</span></div>
        <div id="results" class="results-row"></div>
    </div>

    <!-- Answer Area (Streaming) -->
    <div id="answer-section" class="section" style="display: none;">
        <div class="section-title">ANSWER</div>
        <div id="answer" class="answer-content"></div>
    </div>
</div>

<style>
    /* Base Fonts & Colors */
    body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        margin: 0;
        padding: 16px;
        color: #e4e4e7;
        /* No background here, parent handles it */
    }

    /* Layout */
    .container {
        display: flex;
        flex-direction: column;
        gap: 16px;
    }

    /* Header */
    .header {
        display: flex;
        align-items: center;
        gap: 12px;
    }
    .icon-box {
        width: 40px;
        height: 40px;
        background: linear-gradient(135deg, #06b6d4, #3b82f6);
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(6, 182, 212, 0.2);
    }
    .header-content {
        flex: 1;
        min-width: 0;
    }
    .query {
        font-size: 15px;
        font-weight: 600;
        color: #fff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .engine {
        font-size: 11px;
        color: #a1a1aa;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-top: 2px;
    }

    /* Status Bar */
    .status-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.05);
        padding: 10px 14px;
        border-radius: 10px;
    }
    .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(6, 182, 212, 0.2);
        border-top-color: #06b6d4;
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }
    #status-text {
        font-size: 13px;
        color: #d4d4d8;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Sections */
    .section {
        animation: slideUp 0.4s ease-out;
    }
    .section-title {
        font-size: 10px;
        font-weight: 600;
        color: #71717a;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .count-badge {
        background: rgba(6, 182, 212, 0.1);
        color: #06b6d4;
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 9px;
    }

    /* Results Row */
    .results-row {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        padding-bottom: 8px; /* Space for scrollbar */
        scrollbar-width: none; /* Firefox */
    }
    .results-row::-webkit-scrollbar {
        height: 0px; /* Chrome/Safari/Webkit - hidden */
    }
    .result-card {
        flex: 0 0 auto;
        width: 200px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        padding: 10px;
        transition: all 0.2s;
        cursor: default;
    }
    .result-card:hover {
        background: rgba(255, 255, 255, 0.06);
        border-color: rgba(255, 255, 255, 0.15);
        transform: translateY(-2px);
    }
    .result-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
    }
    .favicon {
        width: 16px;
        height: 16px;
        border-radius: 3px;
        background: rgba(255,255,255,0.1);
    }
    .result-title {
        font-size: 12px;
        font-weight: 500;
        color: #22d3ee;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .result-domain {
        font-size: 10px;
        color: #71717a;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    /* Answer Content */
    .answer-content {
        font-size: 14px;
        line-height: 1.6;
        color: #e4e4e7;
        background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        padding: 14px;
        max-height: 200px;
        overflow-y: auto;
    }
    .answer-content::-webkit-scrollbar {
        width: 4px;
    }
    .answer-content::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 2px;
    }

    /* Animations */
    @keyframes slideUp {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
    }
</style>

<script>
    function renderResults(results) {
        if (!results || results.length === 0) return;
        document.getElementById('results-section').style.display = 'block';
        document.getElementById('result-count').textContent = results.length;
        
        var container = document.getElementById('results');
        container.innerHTML = results.map(function(r) {
            var domain = '';
            try { domain = new URL(r.url).hostname.replace('www.', ''); } catch(e) {}
            var favicon = 'https://www.google.com/s2/favicons?domain=' + domain + '&sz=32';
            
            return '<div class="result-card" title="' + (r.title || '') + '">' +
                '<div class="result-header">' +
                    '<img class="favicon" src="' + favicon + '" onerror="this.style.opacity=0">' +
                    '<div class="result-title">' + (r.title || domain) + '</div>' +
                '</div>' +
                '<div class="result-domain">' + domain + '</div>' +
            '</div>';
        }).join('');
    }

    toolUI.onUpdate = function(data) {
        if (data.query) document.getElementById('query-text').textContent = data.query;
        if (data.engine) document.getElementById('engine-text').textContent = data.engine;
        if (data.status) document.getElementById('status-text').textContent = data.status;
        
        if (data.results) renderResults(data.results);
        
        if (data.answer !== undefined) {
            document.getElementById('answer-section').style.display = 'block';
            // Simple markdown-like line breaks
            document.getElementById('answer').innerHTML = data.answer.replace(/\\n/g, '<br>');
            // Auto-scroll to bottom
            var el = document.getElementById('answer');
            el.scrollTop = el.scrollHeight;
        }
        
        if (data.hideSpinner) {
            document.querySelector('.spinner').style.display = 'none';
            document.getElementById('status-bar').style.borderColor = 'rgba(34, 197, 94, 0.2)';
            document.getElementById('status-bar').style.background = 'rgba(34, 197, 94, 0.05)';
            document.getElementById('status-text').style.color = '#86efac';
        }
    };
</script>
`;

// ============================================
// Internal Functions with UI Support
// ============================================

/**
 * Get answer using Exa Answer API
 */
async function getAnswerFromExa(query, ui = null) {
    try {
        const apiKey = process.env.EXA_API_KEY;
        if (!apiKey) {
            throw new Error('Необходимо установить переменную окружения EXA_API_KEY');
        }

        console.log(chalk.blue(`\n🔍 Поиск через Exa Answer API: "${query}"`));

        if (ui) {
            ui.update({ data: {
                query,
                engine: 'Exa Answer API',
                status: 'Connecting to Exa...',
                // Initial state
            }});
        }

        const exa = new OpenAI({
            baseURL: 'https://api.exa.ai',
            apiKey
        });

        if (ui) {
            ui.update({ data: { status: 'Generating answer...' }});
        }

        const completion = await exa.chat.completions.create({
            model: 'exa',
            messages: [{ role: 'user', content: query }],
            stream: true
        });

        let response = '';
        let chunkCount = 0;

        if (ui) {
            ui.update({ data: { status: 'Streaming answer...' }});
        }

        for await (const chunk of completion) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
                response += content;
                process.stdout.write(chalk.gray(content));
                chunkCount++;

                // Update UI with streaming answer
                if (ui && chunkCount % 3 === 0) {
                    ui.update({ data: { answer: response } });
                }
            }
        }

        if (ui) {
            ui.update({ data: {
                answer: response,
                status: 'Complete',
                hideSpinner: true
            }});
        }

        console.log(chalk.green('\n✅ Ответ получен от Exa'));
        return response.trim();
    } catch (error) {
        console.error(chalk.red('❌ Ошибка Exa API:'), error.message);
        throw error;
    }
}

/**
 * Perform web search using Exa API, convert to TOON, and process with Gemini
 */
async function performWebSearch(query, ui = null) {
    try {
        console.log(chalk.blue(`\n🌐 Веб-поиск через Exa (Deep) + Gemini Flash Lite: "${query}"`));

        if (ui) {
            ui.update({ data: {
                query,
                engine: 'Exa Deep + Gemini Flash',
                status: 'Initializing deep search...'
            }});
        }

        const apiKey = process.env.EXA_API_KEY;
        if (!apiKey) {
            throw new Error('Необходимо установить переменную окружения EXA_API_KEY');
        }
        const exa = new Exa(apiKey);

        console.log(chalk.gray('🔍 Запрос к Exa API...'));

        if (ui) {
            ui.update({ data: { status: 'Searching the web...' } });
        }

        const searchResult = await exa.searchAndContents(
            query,
            {
                context: true,
                text: true,
                type: "deep"
            }
        );

        // Extract results for UI
        const results = searchResult.results?.map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.text?.substring(0, 150)
        })) || [];

        if (ui) {
            ui.update({ data: {
                status: 'Processing results...',
                results
            }});
        }

        // Convert to TOON format
        console.log(chalk.gray('🔄 Конвертация данных в формат TOON...'));
        const optimizedData = encode(searchResult);

        if (ui) {
            ui.update({ data: { status: 'Analyzing with AI...' }});
        }

        // Process with Gemini
        const geminiKey = process.env.GEMINI_API_KEY;
        if (!geminiKey) {
            throw new Error('Необходимо установить переменную окружения GEMINI_API_KEY');
        }

        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const model = 'models/gemini-flash-lite-latest';

        const prompt = `Based on the provided information, answer the query "${query}"\n\nHere is the information:\n${optimizedData}`;

        const contents = [{ role: 'user', parts: [{ text: prompt }] }];

        console.log(chalk.gray(`🤖 Генерация ответа через ${model}...`));

        if (ui) {
            ui.update({ data: { status: 'Generating response...' }});
        }

        const responseStream = await ai.models.generateContentStream({ model, contents });

        let fullResponse = '';
        let chunkCount = 0;

        for await (const chunk of responseStream) {
            const content = chunk.text || '';
            if (content) {
                fullResponse += content;
                process.stdout.write(chalk.gray(content));
                chunkCount++;

                if (ui && chunkCount % 5 === 0) {
                    ui.update({ data: { answer: fullResponse } });
                }
            }
        }

        if (ui) {
            ui.update({ data: {
                answer: fullResponse,
                status: 'Complete',
                hideSpinner: true
            }});
        }

        console.log(chalk.green('\n✅ Ответ получен'));
        return fullResponse.trim();

    } catch (error) {
        console.error(chalk.red('❌ Ошибка Web Search (Exa+Gemini):'), error.message);
        throw error;
    }
}

// ============================================
// Tool Factory - Creates UI-enabled version
// ============================================

function createSearchTool(toolUIManager) {
    return {
        getAnswer: async (query) => {
            console.log(chalk.blue('\n🔍 Выполняется операция: search.getAnswer'));
            if (!query) throw new Error('Требуется параметр query');

            let ui = null;
            if (toolUIManager) {
                ui = toolUIManager.create({
                    label: 'Getting answer...',
                    labelFinished: 'Got answer',
                    html: SEARCH_UI_TEMPLATE,
                    height: 350
                });
            }

            try {
                const result = await getAnswerFromExa(query, ui);
                if (ui) ui.finish();
                return result;
            } catch (error) {
                if (ui) ui.finish();
                console.error(chalk.red('❌ Ошибка в search.getAnswer:'), error.message);
                return `Ошибка: ${error.message}`;
            }
        },

        webSearch: async (query) => {
            console.log(chalk.blue('\n🌐 Выполняется операция: search.webSearch'));
            if (!query) throw new Error('Требуется параметр query');

            let ui = null;
            if (toolUIManager) {
                ui = toolUIManager.create({
                    label: 'Searching the web...',
                    labelFinished: 'Searched the web',
                    html: SEARCH_UI_TEMPLATE,
                    height: 400
                });
            }

            try {
                const result = await performWebSearch(query, ui);
                if (ui) ui.finish();
                return result;
            } catch (error) {
                if (ui) ui.finish();
                console.error(chalk.red('❌ Ошибка в search.webSearch:'), error.message);
                return `Ошибка: ${error.message}`;
            }
        }
    };
}

// ============================================
// Exported Tool API
// ============================================

export const search = {
    _initUI: (toolUIManager) => createSearchTool(toolUIManager),
    getAnswer: async (query) => {
        if (!query) throw new Error('Требуется параметр query');
        return await getAnswerFromExa(query, null);
    },
    webSearch: async (query) => {
        if (!query) throw new Error('Требуется параметр query');
        return await performWebSearch(query, null);
    }
};
