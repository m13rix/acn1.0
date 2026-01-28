/**
 * LanceDB Service
 * 
 * Handles all database operations for the skills viewer.
 * Each "skill" is a separate table in LanceDB.
 */

import * as lancedb from '@lancedb/lancedb';
import { v4 as uuidv4 } from 'uuid';
import { embed, embedBatch, cosineSimilarity } from './embeddings.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', 'data', 'skills');

// Skill entry interface
export interface SkillEntry {
  id: string;
  content: string;
  examples: string[];  // Required array of example queries
  exampleVectors: number[][];  // Pre-embedded vectors for each example (stored as JSON string in DB)
  exampleVectorsJson: string;  // JSON string representation for LanceDB storage
  scoreThreshold?: number;  // Optional similarity threshold (default: 0.8)
  updatedAt: number;
}

// Search result with distance score (for manual search)
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
  // IMPORTANT: Include ALL fields that will be used in the schema, including scoreThreshold
  const initialEntry = {
    id: '__init__',
    content: '',
    examples: ['sample'],
    exampleVectorsJson: JSON.stringify([sampleVector]),
    scoreThreshold: 0.8,  // Include this field so schema includes it
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
  
  const mapped: (SkillEntry | null)[] = results.map((row, index) => {
    
    // Parse exampleVectors from JSON string
    let exampleVectors: number[][] = [];
    try {
      const vectorsJson = row.exampleVectorsJson as string | undefined;
      if (vectorsJson) {
        exampleVectors = JSON.parse(vectorsJson);
      }
    } catch (e) {
      // Invalid JSON or missing field - skip this entry (backward incompatible)
      return null;
    }
    
    // Parse examples array
    let examples: string[] = [];
    try {
      if (row.examples) {
        if (Array.isArray(row.examples)) {
          examples = row.examples as string[];
        } else if (typeof row.examples === 'string') {
          examples = JSON.parse(row.examples);
        } else if (typeof row.examples === 'object' && row.examples !== null) {
          // Handle LanceDB/Arrow arrays - they're array-like objects that need conversion
          // LanceDB returns Arrow arrays which are not native JS arrays but are iterable
          try {
            examples = Array.from(row.examples as any) as string[];
          } catch (conversionError) {
            // If Array.from() fails, try other methods
            if ('toArray' in row.examples && typeof (row.examples as any).toArray === 'function') {
              examples = (row.examples as any).toArray() as string[];
            } else {
              // Last resort: try spreading (may fail if not iterable)
              try {
                examples = [...(row.examples as any)] as string[];
              } catch (spreadError) {
                // Cannot convert - will be filtered out below
              }
            }
          }
        }
      }
    } catch (e) {
      // Invalid examples - skip this entry (backward incompatible)
      return null;
    }
    
    // Filter out entries without examples (backward incompatible)
    if (!examples || examples.length === 0 || !exampleVectors || exampleVectors.length === 0) {
      return null;
    }
    
    return {
      id: row.id as string,
      content: row.content as string,
      examples,
      exampleVectors,
      scoreThreshold: row.scoreThreshold as number | undefined,
      exampleVectorsJson: row.exampleVectorsJson as string,
      updatedAt: row.updatedAt as number
    };
  });
  
  return mapped.filter((entry): entry is SkillEntry => entry !== null);
}

/**
 * Add a new entry to a table
 */
export async function addEntry(
  tableName: string, 
  content: string, 
  examples: string[], 
  scoreThreshold?: number
): Promise<SkillEntry> {
  const connection = await connect();
  
  // Validate examples
  if (!examples || examples.length === 0) {
    throw new Error('At least one example is required');
  }
  
  // Embed all examples
  const exampleVectors = await embedBatch(examples);
  
  // Store entry with examples and exampleVectors (as JSON string for LanceDB)
  const entry = {
    id: uuidv4(),
    content,
    examples: examples,  // Store as array (LanceDB should handle this)
    exampleVectorsJson: JSON.stringify(exampleVectors),  // Store vectors as JSON string
    scoreThreshold: scoreThreshold ?? 0.8,
    updatedAt: Date.now()
  };
  
  try {
    // Try to open existing table and add entry
    const table = await connection.openTable(tableName);
    await table.add([entry]);
  } catch (error: any) {
    // Check for schema mismatch errors (old schema missing new fields)
    const errorMessage = error?.message || String(error) || '';
    const isSchemaError = 
      errorMessage.includes('schema') || 
      errorMessage.includes('field') || 
      errorMessage.includes('Found field not in schema') ||
      errorMessage.includes('scoreThreshold') ||
      errorMessage.includes('exampleVectorsJson') ||
      errorMessage.includes('examples');
    
    if (isSchemaError) {
      console.log(`Schema mismatch detected for table "${tableName}". Recreating table with new schema...`);
      
      // The old schema doesn't have required fields (examples, exampleVectorsJson, scoreThreshold)
      // We cannot migrate old entries as they're missing required data (examples are required)
      // Drop the table and recreate with new schema
      console.warn(`⚠️  Old entries in table "${tableName}" cannot be migrated as they lack required fields (examples).`);
      console.warn(`   The table will be recreated. Old entries will be lost.`);
      console.warn(`   Please re-add any important entries with examples using the new system.`);
      
      // Drop the old table (ignore errors if table doesn't exist)
      try {
        await connection.dropTable(tableName);
        console.log(`   Dropped old table "${tableName}"`);
        
        // Check if table still exists in the list (LanceDB might cache)
        const tablesAfterDrop = await connection.tableNames();
        if (tablesAfterDrop.includes(tableName)) {
          console.warn(`   Warning: Table "${tableName}" still exists after drop. This might be a caching issue.`);
          // Try to drop again with force, or try to delete all data
          try {
            const table = await connection.openTable(tableName);
            // Try to delete all rows
            const allRows = await table.query().toArray();
            if (allRows.length > 0) {
              const ids = allRows.map(row => `"${row.id}"`).join(', ');
              await table.delete(`id IN (${ids})`);
            }
            await connection.dropTable(tableName);
          } catch (retryError) {
            console.warn('   Could not force-drop table, will try to create anyway:', retryError);
          }
        }
      } catch (dropError: any) {
        const dropMsg = dropError?.message || String(dropError) || '';
        if (!dropMsg.includes('not found') && !dropMsg.includes('does not exist') && !dropMsg.includes('Unknown table')) {
          console.warn('   Warning: Error dropping table (will try to create anyway):', dropError);
        }
      }
      
      // Create new table with new schema
      // Check if table exists first
      const tablesBeforeCreate = await connection.tableNames();
      if (tablesBeforeCreate.includes(tableName)) {
        console.warn(`   Warning: Table "${tableName}" still exists. Attempting to force recreate...`);
        // Try one more time to drop
        try {
          await connection.dropTable(tableName);
        } catch (finalDropError) {
          console.error(`   Error: Could not drop table "${tableName}". Please manually delete it.`, finalDropError);
          throw new Error(`Cannot create table "${tableName}" - existing table with incompatible schema cannot be dropped. Please manually delete the table first.`);
        }
      }
      
      await createTable(tableName);
      console.log(`   Created new table "${tableName}" with correct schema`);
      
      // Verify table was created and add the new entry
      const tablesAfterCreate = await connection.tableNames();
      if (!tablesAfterCreate.includes(tableName)) {
        throw new Error(`Failed to create table "${tableName}"`);
      }
      
      const newTable = await connection.openTable(tableName);
      await newTable.add([entry]);
      
      console.log(`✓ Table "${tableName}" recreated successfully. New entry added.`);
    } else if (errorMessage.includes('Table') && (errorMessage.includes('not found') || errorMessage.includes('does not exist') || errorMessage.includes('Unknown table'))) {
      // Table doesn't exist, create it
      console.log(`Table "${tableName}" does not exist. Creating new table...`);
      await createTable(tableName);
      const newTable = await connection.openTable(tableName);
      await newTable.add([entry]);
      
      console.log(`✓ Created new table "${tableName}" and added entry.`);
    } else {
      // Re-throw if it's a different error
      console.error(`Unexpected error adding entry to table "${tableName}":`, error);
      throw error;
    }
  }
  
  // Return entry with parsed vectors
  return {
    id: entry.id,
    content: entry.content,
    examples: entry.examples,
    exampleVectors,
    scoreThreshold: entry.scoreThreshold,
    exampleVectorsJson: entry.exampleVectorsJson,
    updatedAt: entry.updatedAt
  };
}

/**
 * Update an entry
 */
export async function updateEntry(
  tableName: string, 
  id: string, 
  content: string,
  examples: string[],
  scoreThreshold?: number
): Promise<SkillEntry> {
  const connection = await connect();
  const table = await connection.openTable(tableName);
  
  // Validate examples
  if (!examples || examples.length === 0) {
    throw new Error('At least one example is required');
  }
  
  // Embed all examples
  const exampleVectors = await embedBatch(examples);
  const updatedAt = Date.now();
  
  // LanceDB doesn't have native update, so we delete and re-add
  await table.delete(`id = "${id}"`);
  
  const entry = {
    id,
    content,
    examples: examples,
    exampleVectorsJson: JSON.stringify(exampleVectors),
    scoreThreshold: scoreThreshold ?? 0.8,
    updatedAt
  };
  
  try {
    await table.add([entry]);
  } catch (error: any) {
    // Check if error is due to schema mismatch (missing scoreThreshold field)
    if (error?.message?.includes('schema') || error?.message?.includes('Found field not in schema') || error?.message?.includes('scoreThreshold')) {
      console.log(`Schema mismatch detected for table "${tableName}". Attempting to migrate...`);
      
      // Try to read existing entries before recreating table
      let existingEntries: any[] = [];
      try {
        const results = await table.query().toArray();
        existingEntries = results.map(row => {
          // Try to extract what we can from old schema
          try {
            let exampleVectors: number[][] = [];
            const vectorsJson = row.exampleVectorsJson as string | undefined;
            if (vectorsJson) {
              exampleVectors = JSON.parse(vectorsJson);
            }
            
            let examples: string[] = [];
            if (row.examples) {
              if (Array.isArray(row.examples)) {
                examples = row.examples as string[];
              } else if (typeof row.examples === 'string') {
                examples = JSON.parse(row.examples);
              }
            }
            
            if (examples.length > 0 && exampleVectors.length > 0 && exampleVectors.length === examples.length) {
              return {
                id: row.id as string,
                content: row.content as string,
                examples,
                exampleVectorsJson: JSON.stringify(exampleVectors),
                scoreThreshold: 0.8, // Default for migrated entries
                updatedAt: row.updatedAt as number || Date.now()
              };
            }
          } catch (e) {
            // Skip entries that can't be parsed
          }
          return null;
        }).filter((e): e is any => e !== null);
      } catch (readError) {
        console.warn('Could not read existing entries during migration:', readError);
        existingEntries = [];
      }
      
      // Drop and recreate table with new schema
      try {
        await connection.dropTable(tableName);
      } catch (dropError) {
        // Table might already be dropped
      }
      
      await createTable(tableName);
      
      // Re-add all entries (existing + new)
      const newTable = await connection.openTable(tableName);
      const allEntries = [...existingEntries, entry];
      await newTable.add(allEntries);
      
      console.log(`Table "${tableName}" migrated successfully. Preserved ${existingEntries.length} existing entries.`);
    } else {
      // Re-throw other errors
      throw error;
    }
  }
  
  // Return entry with parsed vectors
  return {
    id: entry.id,
    content: entry.content,
    examples: entry.examples,
    exampleVectors,
    scoreThreshold: entry.scoreThreshold,
    exampleVectorsJson: entry.exampleVectorsJson,
    updatedAt: entry.updatedAt
  };
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
 * Semantic search in a table (manual search - compares against content directly)
 * Note: This is for the system.search tool. Automatic retrieval uses example-based matching.
 */
export async function search(
  tableName: string, 
  query: string, 
  limit: number = 10
): Promise<SearchResult[]> {
  const connection = await connect();
  const table = await connection.openTable(tableName);
  
  // For manual search, we compare against the first example's vector (or content)
  // Actually, for manual search, we'll use a simpler approach - compare to first example
  // But since we don't have content vectors anymore, we'll use the first example vector
  // This is a simplified implementation - the actual SkillsService will handle this better
  
  const entries = await getEntries(tableName);
  if (entries.length === 0) {
    return [];
  }
  
  const queryVector = await embed(query);
  
  // Calculate similarity to first example of each entry (for manual search simplicity)
  const scored = entries.map(entry => {
    if (entry.exampleVectors.length === 0 || !entry.exampleVectors[0]) return null;
    const similarity = cosineSimilarity(queryVector, entry.exampleVectors[0]);
    return {
      entry,
      similarity
    };
  }).filter((item): item is { entry: SkillEntry; similarity: number } => item !== null);
  
  // Sort by similarity descending
  scored.sort((a, b) => b.similarity - a.similarity);
  
  // Return top results
  return scored.slice(0, limit).map(item => ({
    ...item.entry,
    _distance: 1 - item.similarity  // Distance is inverse of similarity
  }));
}
