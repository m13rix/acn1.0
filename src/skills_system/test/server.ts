/**
 * Skills System Test Server
 * 
 * Provides a web UI for testing and tuning the retrieval algorithm.
 */

import 'dotenv/config';
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import open from 'open';

import { retrieve, RetrievalResult, MessageHistory } from '../retriever.js';
import { embed, embedBatch } from '../embeddings.js';
import { extractKeywords } from '../extractor.js';
import { computeWeights, ScoringParams, DEFAULT_PARAMS } from '../scorer.js';
import { clearCache, getCacheStats } from '../embeddings.js';

// Import LanceDB service from skills-viewer
import * as lance from '../../skills-viewer/server/lance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3248;
const TEST_TABLE = 'test';

// In-memory storage for message history (keyed by session ID)
// In production, you might want to use Redis or a database
const messageHistoryStore = new Map<string, MessageHistory[]>();

async function main() {
  console.log('Connecting to LanceDB...');
  await lance.connect();
  console.log('Database connected.');
  
  // Ensure test table exists
  const tables = await lance.listTables();
  if (!tables.includes(TEST_TABLE)) {
    console.log(`Creating test table "${TEST_TABLE}"...`);
    await lance.createTable(TEST_TABLE);
  }
  
  const app = express();
  // Increase body size limit to handle larger payloads (though history is now server-side)
  app.use(express.json({ limit: '10mb' }));
  
  // Serve static files
  app.use(express.static(__dirname));
  
  // ============================================================================
  // API Endpoints
  // ============================================================================
  
  /**
   * GET /api/entries
   * Get all entries from the test table
   */
  app.get('/api/entries', async (_req, res) => {
    try {
      const entries = await lance.getEntries(TEST_TABLE);
      const sanitized = entries.map(({ vector, ...rest }) => rest);
      res.json({ entries: sanitized });
    } catch (error) {
      console.error('Error getting entries:', error);
      res.status(500).json({ error: 'Failed to get entries' });
    }
  });
  
  /**
   * POST /api/entries
   * Add a new entry to the test table
   */
  app.post('/api/entries', async (req, res) => {
    try {
      const { content } = req.body;
      if (!content) {
        return res.status(400).json({ error: 'Content is required' });
      }
      
      const entry = await lance.addEntry(TEST_TABLE, content);
      const { vector, ...sanitized } = entry;
      res.status(201).json({ entry: sanitized });
    } catch (error) {
      console.error('Error adding entry:', error);
      res.status(500).json({ error: 'Failed to add entry' });
    }
  });
  
  /**
   * DELETE /api/entries/:id
   * Delete an entry
   */
  app.delete('/api/entries/:id', async (req, res) => {
    try {
      await lance.deleteEntry(TEST_TABLE, req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting entry:', error);
      res.status(500).json({ error: 'Failed to delete entry' });
    }
  });
  
  /**
   * POST /api/extract
   * Extract keywords from a query (for debugging)
   */
  app.post('/api/extract', async (req, res) => {
    try {
      const { query, dedupeThreshold = 0.95 } = req.body;
      if (!query) {
        return res.status(400).json({ error: 'Query is required' });
      }
      
      const result = await extractKeywords(query, dedupeThreshold);
      
      // Don't send vectors to frontend
      const keywords = result.keywords.map(({ vector, ...rest }) => rest);
      
      res.json({ 
        query: result.query,
        keywords,
      });
    } catch (error) {
      console.error('Error extracting keywords:', error);
      res.status(500).json({ error: 'Failed to extract keywords' });
    }
  });
  
  /**
   * POST /api/weights
   * Compute weight distribution for given params
   */
  app.post('/api/weights', async (req, res) => {
    try {
      const { count, params = {} } = req.body;
      if (!count || count < 1) {
        return res.status(400).json({ error: 'Count is required' });
      }
      
      const weights = computeWeights(count, params);
      const fullParams = { ...DEFAULT_PARAMS, ...params };
      
      res.json({ weights, params: fullParams });
    } catch (error) {
      console.error('Error computing weights:', error);
      res.status(500).json({ error: 'Failed to compute weights' });
    }
  });
  
  /**
   * POST /api/retrieve
   * Full retrieval with detailed scoring
   * Message history is stored on the server, identified by sessionId
   */
  app.post('/api/retrieve', async (req, res) => {
    try {
      const { query, params = {}, limit = 0, sessionId = 'default', historyDecay = 0.7 } = req.body;
      if (!query) {
        return res.status(400).json({ error: 'Query is required' });
      }
      
      // Get message history from server storage
      const messageHistory = messageHistoryStore.get(sessionId) || [];
      
      // Get all entries with vectors
      const entries = await lance.getEntries(TEST_TABLE);
      
      if (entries.length === 0) {
        const queryVector = await embed(query);
        const extraction = await extractKeywords(query);
        
        // Save to history
        const newMessage: MessageHistory = {
          id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
          query,
          queryVector,
          extraction,
          timestamp: Date.now(),
        };
        messageHistoryStore.set(sessionId, [newMessage]);
        
        return res.json({
          query,
          extraction: {
            query: extraction.query,
            keywords: extraction.keywords.map(({ vector, ...rest }) => rest),
          },
          weights: [],
          params: { ...DEFAULT_PARAMS, ...params },
          entries: [],
          timing: { extractionMs: 0, scoringMs: 0, totalMs: 0 },
        });
      }
      
      // Process retrieval with history
      const result = await retrieve(query, entries, params, limit, messageHistory, historyDecay);
      
      // Save new message to history
      const newMessage: MessageHistory = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        query,
        queryVector: result.extraction.queryVector,
        extraction: result.extraction,
        timestamp: Date.now(),
      };
      messageHistory.push(newMessage);
      messageHistoryStore.set(sessionId, messageHistory);
      
      // Sanitize: remove vectors from response
      const sanitized = {
        ...result,
        extraction: {
          query: result.extraction.query,
          keywords: result.extraction.keywords.map(({ vector, ...rest }) => rest),
        },
        entries: result.entries.map(e => ({
          ...e,
          entry: {
            id: e.entry.id,
            content: e.entry.content,
          },
        })),
      };
      
      res.json(sanitized);
    } catch (error) {
      console.error('Error retrieving:', error);
      res.status(500).json({ error: 'Failed to retrieve' });
    }
  });
  
  /**
   * GET /api/history/:sessionId
   * Get message history for a session (without vectors)
   */
  app.get('/api/history/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const history = messageHistoryStore.get(sessionId) || [];
    
    // Return history without vectors
    const sanitized = history.map(msg => ({
      id: msg.id,
      query: msg.query,
      timestamp: msg.timestamp,
      keywordCount: msg.extraction.keywords.length,
    }));
    
    res.json({ messages: sanitized });
  });
  
  /**
   * DELETE /api/history/:sessionId/:messageId
   * Delete a specific message from history
   */
  app.delete('/api/history/:sessionId/:messageId', (req, res) => {
    const { sessionId, messageId } = req.params;
    const history = messageHistoryStore.get(sessionId) || [];
    
    const filtered = history.filter(msg => msg.id !== messageId);
    messageHistoryStore.set(sessionId, filtered);
    
    res.json({ success: true, remaining: filtered.length });
  });
  
  /**
   * DELETE /api/history/:sessionId
   * Clear all message history for a session
   */
  app.delete('/api/history/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    messageHistoryStore.delete(sessionId);
    res.json({ success: true });
  });
  
  /**
   * POST /api/cache/clear
   * Clear embedding cache
   */
  app.post('/api/cache/clear', (_req, res) => {
    clearCache();
    res.json({ success: true });
  });
  
  /**
   * GET /api/cache/stats
   * Get cache statistics
   */
  app.get('/api/cache/stats', (_req, res) => {
    res.json(getCacheStats());
  });
  
  /**
   * GET /api/params
   * Get default parameters
   */
  app.get('/api/params', (_req, res) => {
    res.json(DEFAULT_PARAMS);
  });
  
  // Start server
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n🧪 Skills System Test UI running at ${url}\n`);
    open(url);
  });
}

main().catch(console.error);
