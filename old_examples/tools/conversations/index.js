// Conversations tool - search through conversation transcripts
export const conversations = {
  /**
   * Search through conversation transcripts from the last 2 days
   * @param {string} query - Search query describing the situation (e.g., "13 говорит своё мнение по поводу демо нового робота")
   * @returns {Promise<string>} Search results with transcript matches
   */
  async search(query) {
    try {
      if (!query || typeof query !== 'string') {
        return 'Ошибка: запрос обязателен и должен быть строкой';
      }

      const response = await fetch('https://telos-database-6tvke.sevalla.app/v1/audio/transcripts/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: query,
          topK: 3,
          minSimilarity: 0.0
        })
      });

      if (!response.ok) {
        return `Ошибка при поиске транскрипций: ${response.status} ${response.statusText}`;
      }

      const data = await response.json();
      
      if (!data.matches || data.matches.length === 0) {
        return 'По вашему запросу не найдено подходящих транскрипций разговоров.';
      }

      // Ограничиваем результаты до 3 самых релевантных
      const topResults = data.matches.slice(0, 3);
      
      let result = `Найдено ${data.total} транскрипций, показаны ${topResults.length} наиболее релевантных:\n\n`;
      
      topResults.forEach((match, index) => {
        const timestamp = new Date(match.timestamp).toLocaleString('ru-RU');
        const similarity = (match.similarity * 100).toFixed(1);
        
        result += `${index + 1}. [${timestamp}] (схожесть: ${similarity}%)\n`;
        result += `Текст: ${match.text}\n`;
        if (match.filesCount) {
          result += `Файлов: ${match.filesCount}\n`;
        }
        result += '\n';
      });

      result += '⚠️ Внимание: Транскрипции могут содержать неточности, особенно в именах. Рекомендуется проверять информацию по смыслу.';
      
      return result;
      
    } catch (error) {
      return `Ошибка при поиске транскрипций: ${error.message}`;
    }
  }
};
