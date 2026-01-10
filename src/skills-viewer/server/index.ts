/**
 * Skills Viewer Server
 * 
 * Express server that serves the skills viewer UI and API.
 */

import 'dotenv/config';
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import apiRoutes from './api.js';
import { connect } from './lance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3247;

async function main() {
  // Initialize database connection
  console.log('Connecting to LanceDB...');
  await connect();
  console.log('Database connected.');
  
  const app = express();
  
  // Middleware
  app.use(express.json());
  
  // API routes
  app.use('/api', apiRoutes);
  
  // Serve static files from client directory
  const clientDir = join(__dirname, '..', 'client');
  app.use(express.static(clientDir));
  
  // SPA fallback - serve index.html for all non-API routes
  // Express 5 requires named parameter syntax for wildcards
  app.get('*path', (_req, res) => {
    res.sendFile(join(clientDir, 'index.html'));
  });
  
  // Start server
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n🚀 Skills Viewer running at ${url}\n`);
    
    // Auto-open browser
    open(url);
  });
}

main().catch(console.error);
