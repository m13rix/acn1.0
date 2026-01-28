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

import { retrieve, RetrievalResult, DEFAULT_SCORE_THRESHOLD } from '../retriever.js';
import { embed, embedBatch, clearCache, getCacheStats } from '../embeddings.js';

// Import LanceDB service from skills-viewer
import * as lance from '../../skills-viewer/server/lance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3248;
const TEST_TABLE = 'test';

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
   * GET /api/tables
   * Get all available tables with entry counts
   */
  app.get('/api/tables', async (_req, res) => {
    try {
      const tables = await lance.listTables();
      // Get entry count for each table
      const tablesWithInfo = await Promise.all(
        tables.map(async (name) => {
          try {
            const info = await lance.getTableInfo(name);
            return { name: info.name, count: info.count };
          } catch {
            return { name, count: 0 };
          }
        })
      );
      res.json({ tables: tablesWithInfo });
    } catch (error) {
      console.error('Error getting tables:', error);
      res.status(500).json({ error: 'Failed to get tables' });
    }
  });
  
  /**
   * GET /api/entries
   * Get all entries from the specified table (defaults to 'test' table)
   */
  app.get('/api/entries', async (req, res) => {
    try {
      const tableName = (req.query.table as string) || TEST_TABLE;
      const entries = await lance.getEntries(tableName);
      // Don't send vectors to frontend (too large)
      const sanitized = entries.map(({ exampleVectors, exampleVectorsJson, ...rest }) => rest);
      res.json({ entries: sanitized, table: tableName });
    } catch (error) {
      console.error('Error getting entries:', error);
      res.status(500).json({ error: 'Failed to get entries' });
    }
  });
  
  /**
   * POST /api/entries
   * Add a new entry to the specified table (defaults to 'test' table)
   */
  app.post('/api/entries', async (req, res) => {
    try {
      const { content, examples, scoreThreshold, table } = req.body;
      const tableName = table || TEST_TABLE;
      
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'Content is required' });
      }
      
      if (!examples || !Array.isArray(examples) || examples.length === 0) {
        return res.status(400).json({ error: 'At least one example is required' });
      }
      
      // Validate all examples are strings
      for (const example of examples) {
        if (typeof example !== 'string' || !example.trim()) {
          return res.status(400).json({ error: 'All examples must be non-empty strings' });
        }
      }
      
      // Ensure table exists
      const tables = await lance.listTables();
      if (!tables.includes(tableName)) {
        await lance.createTable(tableName);
      }
      
      const entry = await lance.addEntry(tableName, content, examples, scoreThreshold);
      // Don't send vectors back
      const { exampleVectors, exampleVectorsJson, ...sanitized } = entry;
      res.status(201).json({ entry: sanitized, table: tableName });
    } catch (error: any) {
      console.error('Error adding entry:', error);
      res.status(500).json({ error: error.message || 'Failed to add entry' });
    }
  });
  
  /**
   * DELETE /api/entries/:id
   * Delete an entry from the specified table (defaults to 'test' table)
   */
  app.delete('/api/entries/:id', async (req, res) => {
    try {
      const tableName = (req.query.table as string) || TEST_TABLE;
      await lance.deleteEntry(tableName, req.params.id);
      res.json({ success: true, table: tableName });
    } catch (error) {
      console.error('Error deleting entry:', error);
      res.status(500).json({ error: 'Failed to delete entry' });
    }
  });
  
  /**
   * POST /api/extract
   * Extract keywords from a query (DEPRECATED - no longer used in example-based system)
   */
  app.post('/api/extract', async (_req, res) => {
    res.status(410).json({ error: 'Keyword extraction is deprecated. The system now uses example-based matching.' });
  });

  /**
   * POST /api/weights
   * Compute weight distribution (DEPRECATED - no longer used in example-based system)
   */
  app.post('/api/weights', async (_req, res) => {
    res.status(410).json({ error: 'Weight computation is deprecated. The system now uses simple semantic similarity.' });
  });
  
  /**
   * POST /api/retrieve
   * Example-based retrieval with semantic similarity matching
   */
  app.post('/api/retrieve', async (req, res) => {
    try {
      const { query, minThreshold = DEFAULT_SCORE_THRESHOLD, table } = req.body;
      if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'Query is required' });
      }
      
      const tableName = table || TEST_TABLE;
      
      // Get all entries from the specified table
      const entries = await lance.getEntries(tableName);
      
      if (entries.length === 0) {
        return res.json({
          query,
          queryVector: [],
          table: tableName,
          minThreshold: minThreshold,
          totalEntries: 0,
          matchedEntries: 0,
          entries: [],
          timing: {
            embeddingMs: 0,
            scoringMs: 0,
            totalMs: 0
          }
        });
      }
      
      // Use example-based retrieval (include all entries for debugging)
      const result = await retrieve(query, entries, minThreshold, true);
      
      // Sanitize: remove vectors from response but keep all debug info
      const sanitized = {
        query: result.query,
        queryVector: [],  // Don't send vector to frontend
        table: tableName,
        minThreshold: minThreshold,
        totalEntries: entries.length,
        matchedEntries: result.entries.filter(e => e.matched).length,
        entries: result.entries.map(e => ({
          entry: {
            id: e.entry.id,
            content: e.entry.content,
            examples: e.entry.examples,
            scoreThreshold: e.entry.scoreThreshold ?? minThreshold
          },
          score: e.score,
          threshold: e.threshold,
          matched: e.matched,
          bestExampleIndex: e.bestExampleIndex,
          bestExample: e.bestExample,
          exampleScores: e.exampleScores.map(es => ({
            example: es.example,
            exampleIndex: es.exampleIndex,
            similarity: es.similarity,
            similarityPercent: (es.similarity * 100).toFixed(2)
          }))
        })),
        timing: result.timing
      };
      
      res.json(sanitized);
    } catch (error) {
      console.error('Error retrieving:', error);
      res.status(500).json({ error: 'Failed to retrieve' });
    }
  });
  
  /**
   * GET /api/history/:sessionId
   * Message history (DEPRECATED - no longer used in example-based system)
   */
  app.get('/api/history/:sessionId', (_req, res) => {
    res.json({ messages: [] });  // Always return empty (history removed)
  });

  /**
   * DELETE /api/history/:sessionId/:messageId
   * Delete message history (DEPRECATED - no longer used)
   */
  app.delete('/api/history/:sessionId/:messageId', (_req, res) => {
    res.json({ success: true, remaining: 0 });
  });

  /**
   * DELETE /api/history/:sessionId
   * Clear message history (DEPRECATED - no longer used)
   */
  app.delete('/api/history/:sessionId', (_req, res) => {
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
   * Get default parameters (simplified for example-based system)
   */
  app.get('/api/params', (_req, res) => {
    res.json({
      defaultScoreThreshold: DEFAULT_SCORE_THRESHOLD,
      note: 'Example-based system uses simple semantic similarity matching'
    });
  });
  
  // Start server
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n🧪 Skills System Test UI running at ${url}\n`);
    open(url);
  });
}

main().catch(console.error);
