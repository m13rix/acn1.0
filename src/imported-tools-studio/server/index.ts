import 'dotenv/config';
import open from 'open';
import { createImportedToolsStudioApp } from './app.js';

const PORT = Number(process.env['IMPORTED_TOOLS_STUDIO_PORT'] || 3261);

async function main(): Promise<void> {
  const app = createImportedToolsStudioApp();
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Imported Tools Studio running at ${url}`);
    open(url).catch(() => {});
  });
}

main().catch((error) => {
  console.error('Failed to start Imported Tools Studio:', error);
  process.exitCode = 1;
});
