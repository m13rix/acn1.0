import open from 'open';

export async function openAuthUrlInBrowser(url: string): Promise<void> {
  await open(url);
}
