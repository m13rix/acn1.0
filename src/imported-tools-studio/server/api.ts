import { Router } from 'express';
import { ImportedToolsService } from '../../imported-tools/index.js';

const router = Router();
const service = new ImportedToolsService();

router.get('/imports', async (_req, res) => {
  try {
    const imports = await service.listInstalled();
    res.json({ imports });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list imported tools.';
    res.status(500).json({ error: message });
  }
});

router.get('/imports/:id', async (req, res) => {
  try {
    const entry = await service.getInstalled(req.params.id);
    res.json({ import: entry });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load imported tool.';
    res.status(404).json({ error: message });
  }
});

router.post('/imports/inspect', async (req, res) => {
  try {
    const draft = await service.inspect(req.body);
    res.json({ draft });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to inspect source.';
    res.status(400).json({ error: message });
  }
});

router.post('/imports/apply', async (req, res) => {
  try {
    const manifest = await service.apply(req.body?.draft);
    res.status(201).json({ import: manifest });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to apply import.';
    res.status(400).json({ error: message });
  }
});

router.post('/imports/:id/reinstall', async (req, res) => {
  try {
    const manifest = await service.reinstall(req.params.id);
    res.json({ import: manifest });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reinstall import.';
    res.status(400).json({ error: message });
  }
});

router.post('/imports/:id/refresh', async (req, res) => {
  try {
    const draft = await service.refresh(req.params.id);
    res.json({ draft });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh import.';
    res.status(400).json({ error: message });
  }
});

router.delete('/imports/:id', async (req, res) => {
  try {
    await service.delete(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete import.';
    res.status(400).json({ error: message });
  }
});

export default router;
