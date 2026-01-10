/**
 * REST API Routes
 * 
 * Provides endpoints for managing skill tables and entries.
 */

import { Router, Request, Response } from 'express';
import * as lance from './lance.js';

const router = Router();

// ============================================================================
// Tables (Skills)
// ============================================================================

/**
 * GET /api/tables
 * List all skill tables with their entry counts
 */
router.get('/tables', async (_req: Request, res: Response) => {
  try {
    const tableNames = await lance.listTables();
    
    // Get info for each table
    const tables = await Promise.all(
      tableNames.map(name => lance.getTableInfo(name))
    );
    
    res.json({ tables });
  } catch (error) {
    console.error('Error listing tables:', error);
    res.status(500).json({ error: 'Failed to list tables' });
  }
});

/**
 * POST /api/tables
 * Create a new skill table
 */
router.post('/tables', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Table name is required' });
    }
    
    // Validate name (alphanumeric, underscores, hyphens only)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return res.status(400).json({ 
        error: 'Table name can only contain letters, numbers, underscores, and hyphens' 
      });
    }
    
    await lance.createTable(name);
    res.status(201).json({ success: true, name });
  } catch (error) {
    console.error('Error creating table:', error);
    res.status(500).json({ error: 'Failed to create table' });
  }
});

/**
 * DELETE /api/tables/:name
 * Delete a skill table
 */
router.delete('/tables/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    await lance.deleteTable(name);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting table:', error);
    res.status(500).json({ error: 'Failed to delete table' });
  }
});

// ============================================================================
// Entries
// ============================================================================

/**
 * GET /api/tables/:name/entries
 * Get all entries from a table
 */
router.get('/tables/:name/entries', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const entries = await lance.getEntries(name);
    
    // Don't send vectors to frontend (too large)
    const sanitized = entries.map(({ vector, ...rest }) => rest);
    
    res.json({ entries: sanitized });
  } catch (error) {
    console.error('Error getting entries:', error);
    res.status(500).json({ error: 'Failed to get entries' });
  }
});

/**
 * POST /api/tables/:name/entries
 * Add a new entry
 */
router.post('/tables/:name/entries', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { content } = req.body;
    
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Content is required' });
    }
    
    const entry = await lance.addEntry(name, content);
    
    // Don't send vector back
    const { vector, ...sanitized } = entry;
    
    res.status(201).json({ entry: sanitized });
  } catch (error) {
    console.error('Error adding entry:', error);
    res.status(500).json({ error: 'Failed to add entry' });
  }
});

/**
 * PUT /api/tables/:name/entries/:id
 * Update an entry
 */
router.put('/tables/:name/entries/:id', async (req: Request, res: Response) => {
  try {
    const { name, id } = req.params;
    const { content } = req.body;
    
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Content is required' });
    }
    
    const entry = await lance.updateEntry(name, id, content);
    
    // Don't send vector back
    const { vector, ...sanitized } = entry;
    
    res.status(200).json({ entry: sanitized });
  } catch (error) {
    console.error('Error updating entry:', error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

/**
 * DELETE /api/tables/:name/entries/:id
 * Delete an entry
 */
router.delete('/tables/:name/entries/:id', async (req: Request, res: Response) => {
  try {
    const { name, id } = req.params;
    await lance.deleteEntry(name, id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting entry:', error);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

/**
 * POST /api/tables/:name/search
 * Semantic search in a table
 */
router.post('/tables/:name/search', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { query, limit = 10 } = req.body;
    
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    const results = await lance.search(name, query, limit);
    
    // Don't send vectors back
    const sanitized = results.map(({ vector, ...rest }) => rest);
    
    res.json({ results: sanitized });
  } catch (error) {
    console.error('Error searching:', error);
    res.status(500).json({ error: 'Failed to search' });
  }
});

export default router;
