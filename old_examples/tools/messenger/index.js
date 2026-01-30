// Messenger tool - Beeper Desktop API integration for exact keyword search across all chats
import chalk from 'chalk';

const DEFAULT_BASE_URL = process.env.BEEPER_BASE_URL || 'http://localhost:23373';
const ACCESS_TOKEN = process.env.BEEPER_TOKEN || process.env.BEEPER_DESKTOP_TOKEN || process.env.BEEPER_API_TOKEN;

function buildQueryVariants(query) {
  const q = String(query || '').trim();
  const variants = new Set();
  if (!q) return [];

  // Original string
  variants.add(q);

  // Split on whitespace and punctuation, try individual tokens if multi-word
  const tokens = q.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
  if (tokens.length > 1) {
    for (const t of tokens) {
      if (t.length >= 2) variants.add(t);
    }
  }

  // Try quoted exact phrase form if supported
  if (!q.startsWith('"') && !q.endsWith('"')) {
    variants.add(`"${q}"`);
  }

  return Array.from(variants).slice(0, 6); // cap attempts
}

async function beeperSearchOnce(baseUrl, token, q) {
  const url = new URL('/v0/search-messages', baseUrl);
  url.searchParams.set('query', q);
  const headers = { 'Accept': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Beeper API ${res.status} ${res.statusText}: ${text}`);
  }
  const json = await res.json();
  return json;
}

function formatResults(header, items) {
  if (!Array.isArray(items) || items.length === 0) return `${header}\n   (ничего не найдено)`;
  const lines = [header];
  for (const item of items.slice(0, 10)) {
    const ts = item.timestamp ? new Date(item.timestamp).toLocaleString() : '';
    const sender = item.sender || item.author || 'unknown';
    const room = item.roomName || item.conversationName || item.chat || '';
    const preview = (item.body || item.text || '').toString().replace(/\s+/g, ' ').trim();
    lines.push(`- [${ts}] ${room} | ${sender}: ${preview}`);
  }
  if (items.length > 10) lines.push(`... и ещё ${items.length - 10}`);
  return lines.join('\n');
}

export const messenger = {
  /**
   * Exact keyword search across all chats in Beeper Desktop
   * Not semantic. Tries multiple precise variants of the query.
   * Requires Beeper Desktop API enabled and token set in env.
   * Env: BEEPER_TOKEN (or BEEPER_DESKTOP_TOKEN/BEEPER_API_TOKEN), optional BEEPER_BASE_URL
   */
  async search(query) {
    try {
      console.log(chalk.blue('\n💬 Выполняется операция: messenger.search'));
      if (!query || typeof query !== 'string') {
        throw new Error('Требуется строковый параметр query');
      }

      if (!ACCESS_TOKEN) {
        console.log(chalk.yellow('⚠️ Не найден токен в окружении (BEEPER_TOKEN). Попытаемся без него, если API не требует.'));
      }

      const attempts = buildQueryVariants(query);
      if (attempts.length === 0) return 'Пустой запрос. Укажите ключевые слова для точного поиска.';

      console.log(chalk.gray(`Базовый URL: ${DEFAULT_BASE_URL}`));
      console.log(chalk.gray(`Попытки запроса (${attempts.length}): ${attempts.map(a => `[${a}]`).join(', ')}`));

      const aggregate = [];
      const seenIds = new Set();
      let lastError = null;

      for (const q of attempts) {
        try {
          const data = await beeperSearchOnce(DEFAULT_BASE_URL, ACCESS_TOKEN, q);
          const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []));
          const chatsById = data?.chats || {};
          for (const it of items) {
            const normalized = {
              id: it.id || it.messageID || it.eventId || it.sortKey,
              timestamp: it.timestamp || it.ts || it.time || null,
              roomName: (chatsById[it.chatID]?.title) || it.roomName || it.conversationName || it.chat || it.chatID || '',
              sender: it.senderName || it.sender || it.senderID || it.author || 'unknown',
              body: it.text || it.body || ''
            };
            const id = normalized.id || `${normalized.timestamp}-${String(normalized.body).slice(0,32)}`;
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              aggregate.push(normalized);
            }
          }
          // If we found enough, we can stop early
          if (aggregate.length >= 10) break;
        } catch (e) {
          lastError = e;
          console.log(chalk.yellow(`Попытка с запросом ${q} завершилась ошибкой: ${e.message}`));
        }
      }

      if (aggregate.length === 0) {
        if (lastError) {
          return `Ничего не найдено. Последняя ошибка API: ${lastError.message}`;
        }
        return 'Ничего не найдено. Попробуйте более точные или другие ключевые слова.';
      }

      return formatResults(`Найдено совпадений: ${aggregate.length}`, aggregate);
    } catch (error) {
      console.error(chalk.red('❌ Ошибка messenger.search:'), error.message);
      return `Ошибка: ${error.message}`;
    }
  }
  ,
  /**
   * Search chats by title using Beeper Desktop API v0 HTTP.
   * Tries /v0/search-chats first; falls back to deriving from /v0/search-messages results.
   */
  async searchChats(query) {
    try {
      console.log(chalk.blue('\n💬 Выполняется операция: messenger.searchChats'));
      if (!query || typeof query !== 'string') {
        throw new Error('Требуется строковый параметр query');
      }

      const headers = { 'Accept': 'application/json' };
      if (ACCESS_TOKEN) headers['Authorization'] = `Bearer ${ACCESS_TOKEN}`;

      // Attempt 1: dedicated chat search endpoint
      try {
        const url = new URL('/v0/search-chats', DEFAULT_BASE_URL);
        url.searchParams.set('query', query);
        const res = await fetch(url, { headers });
        if (res.ok) {
          const data = await res.json();
          const chats = Array.isArray(data?.items) ? data.items : (Array.isArray(data?.chats) ? data.chats : (Array.isArray(data) ? data : []));
          if (Array.isArray(chats) && chats.length) {
            const lines = ['Найденные чаты:'];
            for (const c of chats.slice(0, 20)) {
              const title = c.title || c.name || c.displayName || c.roomName || c.id;
              const network = c.network || c.platform || '';
              lines.push(`- ${title} (${network}) [${c.id}]`);
            }
            if (chats.length > 20) lines.push(`... и ещё ${chats.length - 20}`);
            return lines.join('\n');
          }
        }
      } catch (e) {
        console.log(chalk.yellow(`searchChats(/v0/search-chats) не удалось: ${e.message}`));
      }

      // Fallback: infer from message search
      const data = await beeperSearchOnce(DEFAULT_BASE_URL, ACCESS_TOKEN, query);
      const chatsMap = data?.chats || {};
      const items = Array.isArray(data?.items) ? data.items : [];
      // Count matches per chat
      const countByChat = new Map();
      for (const it of items) {
        const cid = it.chatID || it.roomId || it.roomID || it.room || '';
        if (!cid) continue;
        countByChat.set(cid, (countByChat.get(cid) || 0) + 1);
      }
      const sorted = Array.from(countByChat.entries()).sort((a,b) => b[1]-a[1]);
      if (sorted.length === 0 && Object.keys(chatsMap).length) {
        // If items empty but chats exist, list chats by title filter
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        for (const [cid, ch] of Object.entries(chatsMap)) {
          const title = (ch?.title || '').toLowerCase();
          if (tokens.every(t => title.includes(t))) {
            sorted.push([cid, 0]);
          }
        }
      }
      if (sorted.length === 0) return 'Чаты не найдены по заданному запросу.';

      const lines = ['Найденные чаты (по совпадениям сообщений):'];
      for (const [cid, cnt] of sorted.slice(0, 20)) {
        const ch = chatsMap[cid] || {};
        const title = ch.title || cid;
        const network = ch.network || ch.platform || '';
        lines.push(`- ${title} (${network}) [${cid}] — совпадений: ${cnt}`);
      }
      if (sorted.length > 20) lines.push(`... и ещё ${sorted.length - 20}`);
      return lines.join('\n');
    } catch (error) {
      console.error(chalk.red('❌ Ошибка messenger.searchChats:'), error.message);
      return `Ошибка: ${error.message}`;
    }
  }
  ,
  /**
   * Get recent N messages from a chat by its title (best match) using v0 HTTP.
   * Tries dedicated endpoints, falls back to message search within chat if needed.
   */
  async getRecentMessagesByChatName(chatName, limit = 20) {
    try {
      console.log(chalk.blue('\n💬 Выполняется операция: messenger.getRecentMessagesByChatName'));
      if (!chatName || typeof chatName !== 'string') {
        throw new Error('Требуется строковый параметр chatName');
      }
      const n = Math.max(1, Math.min(Number(limit) || 20, 100));

      // Step 1: find chat candidates (prefer exact case-insensitive match)
      const headers = { 'Accept': 'application/json' };
      if (ACCESS_TOKEN) headers['Authorization'] = `Bearer ${ACCESS_TOKEN}`;

      let candidates = [];
      // Try /v0/search-chats
      try {
        const url = new URL('/v0/search-chats', DEFAULT_BASE_URL);
        url.searchParams.set('query', chatName);
        const res = await fetch(url, { headers });
        if (res.ok) {
          const data = await res.json();
          const chats = Array.isArray(data?.items) ? data.items : (Array.isArray(data?.chats) ? data.chats : (Array.isArray(data) ? data : []));
          candidates = chats.map(c => ({ id: c.id, title: c.title || c.name || c.displayName || c.id, network: c.network || c.platform || '' }));
        }
      } catch {}

      if (!candidates.length) {
        // Fallback: derive from message search
        const data = await beeperSearchOnce(DEFAULT_BASE_URL, ACCESS_TOKEN, chatName);
        const chatsMap = data?.chats || {};
        candidates = Object.values(chatsMap).map(c => ({ id: c.id, title: c.title || c.id, network: c.network || '' }));
        // Filter by title match
        const lc = chatName.toLowerCase();
        candidates = candidates.filter(c => c.title && c.title.toLowerCase().includes(lc));
      }

      if (!candidates.length) return 'Чат не найден по названию.';
      const exact = candidates.find(c => (c.title || '').toLowerCase() === chatName.toLowerCase());
      const chosen = exact || candidates[0];
      console.log(chosen);

      // Step 2: fetch recent messages using v0/search-messages with chatIDs workaround
      try {
        const url = new URL('/v0/search-messages', DEFAULT_BASE_URL);
        url.searchParams.set('query', ' '); // blank query to get recent messages
        url.searchParams.append('chatIDs[]', chosen.id);
        url.searchParams.set('limit', String(n));
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.json();
        const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);

        // Normalize and order by timestamp desc
        const normalized = items.map(it => ({
          id: it.id || it.messageID || it.eventId || it.sortKey,
          timestamp: it.timestamp || it.ts || it.time || null,
          sender: it.senderName || it.sender || it.senderID || it.author || 'unknown',
          body: it.text || it.body || ''
        }))
        .sort((a,b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime())
        .slice(0, n);

        const lines = [`Последние ${normalized.length} сообщений из чата "${chosen.title}" [${chosen.id}]`];
        for (const m of normalized) {
          const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
          const preview = String(m.body || '').replace(/\s+/g, ' ').trim();
          lines.push(`- [${ts}] ${m.sender}: ${preview}`);
        }
        return lines.join('\n');
      } catch (e) {
        return `Не удалось получить сообщения через v0/search-messages: ${e.message}`;
      }
    } catch (error) {
      console.error(chalk.red('❌ Ошибка messenger.getRecentMessagesByChatName:'), error.message);
      return `Ошибка: ${error.message}`;
    }
  }
};


