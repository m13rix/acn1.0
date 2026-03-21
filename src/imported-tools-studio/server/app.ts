import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import apiRoutes from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(__dirname, '..', 'client');

export function createImportedToolsStudioApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', apiRoutes);
  app.use(express.static(CLIENT_DIR));
  app.get('*path', (_req, res) => {
    res.sendFile(join(CLIENT_DIR, 'index.html'));
  });
  return app;
}

export default createImportedToolsStudioApp;
