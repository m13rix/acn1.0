/**
 * API Client
 * 
 * Fetch wrapper for communicating with the skills viewer backend.
 */

const BASE_URL = '/api';

export interface TableInfo {
  name: string;
  count: number;
}

export interface SkillEntry {
  id: string;
  content: string;
  updatedAt: number;
  _distance?: number;
}

async function request<T>(
  endpoint: string, 
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  
  return response.json();
}

// Tables
export async function getTables(): Promise<TableInfo[]> {
  const data = await request<{ tables: TableInfo[] }>('/tables');
  return data.tables;
}

export async function createTable(name: string): Promise<void> {
  await request('/tables', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function deleteTable(name: string): Promise<void> {
  await request(`/tables/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

// Entries
export async function getEntries(tableName: string): Promise<SkillEntry[]> {
  const data = await request<{ entries: SkillEntry[] }>(
    `/tables/${encodeURIComponent(tableName)}/entries`
  );
  return data.entries;
}

export async function addEntry(tableName: string, content: string): Promise<SkillEntry> {
  const data = await request<{ entry: SkillEntry }>(
    `/tables/${encodeURIComponent(tableName)}/entries`,
    {
      method: 'POST',
      body: JSON.stringify({ content }),
    }
  );
  return data.entry;
}

export async function updateEntry(
  tableName: string, 
  id: string, 
  content: string
): Promise<SkillEntry> {
  const data = await request<{ entry: SkillEntry }>(
    `/tables/${encodeURIComponent(tableName)}/entries/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }
  );
  return data.entry;
}

export async function deleteEntry(tableName: string, id: string): Promise<void> {
  await request(
    `/tables/${encodeURIComponent(tableName)}/entries/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
}

export async function searchEntries(
  tableName: string, 
  query: string, 
  limit: number = 10
): Promise<SkillEntry[]> {
  const data = await request<{ results: SkillEntry[] }>(
    `/tables/${encodeURIComponent(tableName)}/search`,
    {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    }
  );
  return data.results;
}
