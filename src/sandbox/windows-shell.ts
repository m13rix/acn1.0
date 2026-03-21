export function normalizeCliCommand(command: string, platform: NodeJS.Platform = process.platform): string {
  const lines = (command || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));

  if (lines.length === 0) {
    return '';
  }

  let normalized = lines.length > 1
    ? lines.join(platform === 'win32' ? '; ' : ' && ')
    : (lines[0] ?? '');

  if (platform === 'win32') {
    // Avoid creating a literal "-p" directory on Windows.
    normalized = normalized.replace(/\bmkdir\s+-p\s+/g, 'mkdir ');
  }

  return normalized;
}

export function buildPowerShellCommand(command: string): string {
  return `$ErrorActionPreference = 'Stop'; ${command}`;
}

export function shouldFallbackToCmd(stderr: string, startError?: string): boolean {
  const text = `${startError || ''}\n${stderr || ''}`.toLowerCase();
  if (!text.trim()) return false;

  const fallbackSignals = [
    'commandnotfoundexception',
    'is not recognized as the name of a cmdlet',
    'parsererror',
    'unexpected token',
    'missing terminator',
    'failed to start process',
  ];

  return fallbackSignals.some(signal => text.includes(signal));
}
