/**
 * LanceDB Service
 * 
 * Handles all database operations for the skills viewer.
 * Each "skill" is a separate table in LanceDB.
 */

import * as lancedb from '@lancedb/lancedb';
import { v4 as uuidv4 } from 'uuid';
import { embed } from './embeddings.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', 'data', 'skills');

// Skill entry interface
export interface SkillEntry {
  id: string;
  content: string;
  vector: number[];
  updatedAt: number;
}

// Search result with distance score
export interface SearchResult extends SkillEntry {
  _distance?: number;
}

let db: lancedb.Connection | null = null;

/**
 * Initialize/connect to the database
 */
export async function connect(): Promise<lancedb.Connection> {
  if (!db) {
    db = await lancedb.connect(DATA_DIR);
  }
  return db;
}

/**
 * List all tables (skills)
 */
export async function listTables(): Promise<string[]> {
  const connection = await connect();
  return connection.tableNames();
}

/**
 * Get table info (name + entry count)
 */
export async function getTableInfo(name: string): Promise<{ name: string; count: number }> {
  const connection = await connect();
  const table = await connection.openTable(name);
  const count = await table.countRows();
  return { name, count };
}

/**
 * Create a new table (skill category)
 */
export async function createTable(name: string): Promise<void> {
  const connection = await connect();
  
  // Get a real embedding to ensure correct dimension (768 for Gemini)
  const sampleVector = await embed('sample');
  
  // Create with an initial dummy entry (LanceDB requires at least one row to infer schema)
  // We'll delete it immediately
  const initialEntry: SkillEntry = {
    id: '__init__',
    content: '',
    vector: sampleVector,
    updatedAt: Date.now()
  };
  
  const table = await connection.createTable(name, [initialEntry]);
  
  // Delete the dummy entry
  await table.delete('id = "__init__"');
}

/**
 * Delete a table
 */
export async function deleteTable(name: string): Promise<void> {
  const connection = await connect();
  await connection.dropTable(name);
}

/**
 * Get all entries from a table
 */
export async function getEntries(tableName: string): Promise<SkillEntry[]> {
  const connection = await connect();
  const table = await connection.openTable(tableName);
  const results = await table.query().toArray();
  
  return results.map(row => {
    // Convert LanceDB Vector to regular array
    const vector = row.vector;
    const vectorArray = Array.isArray(vector) 
      ? vector 
      : Array.from(vector as ArrayLike<number>);
    
    return {
      id: row.id as string,
      content: row.content as string,
      vector: vectorArray,
      updatedAt: row.updatedAt as number
    };
  });
}

/**
 * Add a new entry to a table
 */
export async function addEntry(tableName: string, content: string): Promise<SkillEntry> {
  const connection = await connect();
  const table = await connection.openTable(tableName);
  
  const vector = await embed(content);
  
  const entry: SkillEntry = {
    id: uuidv4(),
    content,
    vector,
    updatedAt: Date.now()
  };
  
  await table.add([entry]);
  
  return entry;
}

/**
 * Update an entry
 */
export async function updateEntry(
  tableName: string, 
  id: string, 
  content: string
): Promise<SkillEntry> {
  const connection = await connect();
  const table = await connection.openTable(tableName);
  
  // Generate new embedding for updated content
  const vector = await embed(content);
  const updatedAt = Date.now();
  
  // LanceDB doesn't have native update, so we delete and re-add
  await table.delete(`id = "${id}"`);
  
  const entry: SkillEntry = {
    id,
    content,
    vector,
    updatedAt
  };
  
  await table.add([entry]);
  
  return entry;
}

/**
 * Delete an entry
 */
export async function deleteEntry(tableName: string, id: string): Promise<void> {
  const connection = await connect();
  const table = await connection.openTable(tableName);
  await table.delete(`id = "${id}"`);
}

/**
 * Semantic search in a table
 */
export async function search(
  tableName: string, 
  query: string, 
  limit: number = 10
): Promise<SearchResult[]> {
  const connection = await connect();
  const table = await connection.openTable(tableName);
  
  // Embed the query
  const queryVector = await embed(query);
  
  // Vector search using the correct API method
  const results = await table
    .vectorSearch(queryVector)
    .limit(limit)
    .toArray();
  
  return results.map(row => {
    // Convert LanceDB Vector to regular array
    const vector = row.vector;
    const vectorArray = Array.isArray(vector) 
      ? vector 
      : Array.from(vector as ArrayLike<number>);
    
    return {
      id: row.id as string,
      content: row.content as string,
      vector: vectorArray,
      updatedAt: row.updatedAt as number,
      _distance: row._distance as number | undefined
    };
  });
}
