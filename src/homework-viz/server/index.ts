import express from 'express';
import multer from 'multer';
import open from 'open';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  createHomeworkDocument,
  getHomeworkDocumentPdfPath,
  getStoredSectionText,
  listStoredDocuments,
} from '../../homework-library/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLIENT_DIR = join(__dirname, '../client');
const PORT = Number(process.env['HOMEWORK_VIZ_PORT'] || 3011);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

function asInteger(input: unknown, fallback: number): number {
  const value = Number(input);
  if (!Number.isFinite(value)) return fallback;
  return Math.trunc(value);
}

async function startServer(): Promise<void> {
  const app = express();
  const server = createServer(app);

  app.use(express.static(CLIENT_DIR));
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/documents', async (_req, res) => {
    try {
      const documents = await listStoredDocuments();
      res.json({ ok: true, documents });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list documents';
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.get('/api/documents/:id/pdf', async (req, res) => {
    try {
      const filePath = await getHomeworkDocumentPdfPath(req.params.id);
      res.sendFile(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open PDF';
      res.status(404).json({ ok: false, error: message });
    }
  });

  app.get('/api/documents/:id/sections/:sectionNumber', async (req, res) => {
    try {
      const sectionNumber = asInteger(req.params.sectionNumber, NaN);
      if (!Number.isFinite(sectionNumber) || sectionNumber < 1) {
        res.status(400).json({ ok: false, error: 'sectionNumber must be a positive integer' });
        return;
      }

      const text = await getStoredSectionText(req.params.id, sectionNumber);
      res.json({ ok: true, text });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get section text';
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post('/api/documents', upload.single('pdf'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ ok: false, error: 'pdf file is required' });
        return;
      }

      const tocPagePdf = asInteger(req.body?.tocPagePdf, NaN);
      const tocText = String(req.body?.tocText || '').trim();
      const pageOffset = asInteger(req.body?.pageOffset, 0);
      const sectionType = String(req.body?.sectionType || '').trim() || 'paragraphs';
      const title = String(req.body?.title || '').trim();

      if (!tocText && (!Number.isFinite(tocPagePdf) || tocPagePdf < 1)) {
        res.status(400).json({ ok: false, error: 'Provide either tocPagePdf or tocText.' });
        return;
      }

      const document = await createHomeworkDocument({
        title,
        originalFilename: file.originalname,
        pdfBuffer: file.buffer,
        tocPagePdf: Number.isFinite(tocPagePdf) ? tocPagePdf : undefined,
        tocText,
        pageOffset,
        sectionType,
      });

      res.json({ ok: true, document });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to ingest document';
      res.status(500).json({ ok: false, error: message });
    }
  });

  server.listen(PORT, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Homework Library UI running at ${url}`);
    await open(url);
  });
}

startServer().catch((error) => {
  console.error('Failed to start Homework Library UI:', error);
  process.exitCode = 1;
});
