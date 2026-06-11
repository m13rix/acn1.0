import { spawn } from 'child_process';
import { copyFile, mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import ffmpegStatic from '@ffmpeg-installer/ffmpeg';

export interface AudioSegment {
  start: number;
  end: number;
}

export interface AudioWindow {
  path: string;
  start: number;
  end: number;
}

const FFMPEG_PATH = ffmpegStatic.path;
const MIN_SEGMENT_SECONDS = 0.12;

function compactId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

function assertInsideDirectory(targetPath: string, directory: string): void {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedDirectory = path.resolve(directory);
  if (!resolvedTarget.startsWith(resolvedDirectory)) {
    throw new Error(`Refusing to write outside temp directory: ${resolvedTarget}`);
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg failed with code ${code}: ${stderr.trim()}`));
    });
  });
}

function runFfprobeDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobePath = FFMPEG_PATH.replace(/ffmpeg(?:\.exe)?$/i, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    const child = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}: ${stderr.trim()}`));
        return;
      }
      const duration = Number.parseFloat(stdout.trim());
      resolve(Number.isFinite(duration) ? duration : 0);
    });
  });
}

function parseFfmpegDuration(output: string): number {
  const match = output.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  if (!match) {
    return 0;
  }
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  const seconds = Number.parseFloat(match[3]!);
  const duration = (hours * 3600) + (minutes * 60) + seconds;
  return Number.isFinite(duration) ? duration : 0;
}

function runFfmpegMetadataDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-hide_banner', '-i', inputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', () => {
      resolve(parseFfmpegDuration(`${stdout}\n${stderr}`));
    });
  });
}

function concatListLine(filePath: string): string {
  return `file '${filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

export async function getAudioDurationSeconds(inputPath: string): Promise<number> {
  try {
    return await runFfprobeDuration(inputPath);
  } catch {
    return runFfmpegMetadataDuration(inputPath);
  }
}

export async function convertToSpeakerSampleWav(inputPath: string, outputPath: string, maxSeconds: number): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const trimArgs = Number.isFinite(maxSeconds) && maxSeconds > 0 && maxSeconds < 86_400
    ? ['-t', String(maxSeconds)]
    : [];
  await runFfmpeg([
    '-y',
    '-i', inputPath,
    ...trimArgs,
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    outputPath,
  ]);
}

export async function concatAudioFilesToWav(inputPaths: string[], outputPath: string, tempDir: string): Promise<void> {
  if (inputPaths.length === 0) {
    throw new Error('Cannot concatenate an empty audio list.');
  }
  if (inputPaths.length === 1) {
    await convertToSpeakerSampleWav(inputPaths[0]!, outputPath, Number.MAX_SAFE_INTEGER);
    return;
  }

  const workDir = path.join(tempDir, `concat-${compactId()}`);
  await mkdir(workDir, { recursive: true });

  try {
    const normalizedPaths: string[] = [];
    for (const [index, inputPath] of inputPaths.entries()) {
      const normalizedPath = path.join(workDir, `part-${index}.wav`);
      assertInsideDirectory(normalizedPath, workDir);
      await convertToSpeakerSampleWav(inputPath, normalizedPath, Number.MAX_SAFE_INTEGER);
      normalizedPaths.push(normalizedPath);
    }

    const listPath = path.join(workDir, 'concat.txt');
    assertInsideDirectory(listPath, workDir);
    await writeFile(listPath, normalizedPaths.map(concatListLine).join('\n'), 'utf8');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      outputPath,
    ]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function extractSegmentsToWav(
  inputPath: string,
  segments: AudioSegment[],
  outputPath: string,
  _tempDir: string,
  maxSeconds: number,
): Promise<number> {
  const cleanSegments = segments
    .map((segment) => ({
      start: Math.max(0, Number(segment.start) || 0),
      end: Math.max(0, Number(segment.end) || 0),
    }))
    .filter((segment) => segment.end - segment.start >= MIN_SEGMENT_SECONDS)
    .sort((a, b) => a.start - b.start);

  if (cleanSegments.length === 0) {
    throw new Error('No usable audio segments to extract.');
  }

  const selectedSegments: AudioSegment[] = [];
  let collectedSeconds = 0;
  for (const segment of cleanSegments) {
    if (collectedSeconds >= maxSeconds) {
      break;
    }
    const duration = Math.min(segment.end - segment.start, maxSeconds - collectedSeconds);
    if (duration < MIN_SEGMENT_SECONDS) {
      continue;
    }
    selectedSegments.push({ start: segment.start, end: segment.start + duration });
    collectedSeconds += duration;
  }

  if (selectedSegments.length === 0) {
    throw new Error('No usable audio segments to extract.');
  }

  if (selectedSegments.length === 1) {
    const segment = selectedSegments[0]!;
    await mkdir(path.dirname(outputPath), { recursive: true });
    await runFfmpeg([
      '-y',
      '-ss', segment.start.toFixed(3),
      '-t', (segment.end - segment.start).toFixed(3),
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      outputPath,
    ]);
    return collectedSeconds;
  }

  const filterParts = selectedSegments.map((segment, index) =>
    `[0:a]atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},asetpts=PTS-STARTPTS[s${index}]`
  );
  const concatInputs = selectedSegments.map((_segment, index) => `[s${index}]`).join('');
  const filter = `${filterParts.join(';')};${concatInputs}concat=n=${selectedSegments.length}:v=0:a=1[out]`;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-filter_complex', filter,
    '-map', '[out]',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    outputPath,
  ]);
  return collectedSeconds;
}

export async function splitAudioIntoWindowsToWav(
  inputPath: string,
  tempDir: string,
  options: {
    windowSeconds: number;
    minWindowSeconds: number;
    maxWindows: number;
  },
): Promise<AudioWindow[]> {
  const duration = await getAudioDurationSeconds(inputPath);
  if (duration <= 0) {
    return [];
  }

  const windowSeconds = Math.max(options.minWindowSeconds, options.windowSeconds);
  const maxWindows = Math.max(1, Math.floor(options.maxWindows));
  const windows: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < duration && windows.length < maxWindows) {
    const end = Math.min(duration, start + windowSeconds);
    if (end - start >= options.minWindowSeconds) {
      windows.push({ start, end });
    }
    start += windowSeconds;
  }

  if (windows.length === 1 && duration - windows[0]!.end >= options.minWindowSeconds) {
    windows.push({ start: windows[0]!.end, end: duration });
  }

  const workDir = path.join(tempDir, `windows-${compactId()}`);
  await mkdir(workDir, { recursive: true });
  const output: AudioWindow[] = [];
  try {
    for (const [index, window] of windows.entries()) {
      const outputPath = path.join(workDir, `window-${index}.wav`);
      assertInsideDirectory(outputPath, workDir);
      await runFfmpeg([
        '-y',
        '-ss', window.start.toFixed(3),
        '-t', (window.end - window.start).toFixed(3),
        '-i', inputPath,
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'pcm_s16le',
        outputPath,
      ]);
      output.push({ path: outputPath, start: window.start, end: window.end });
    }
    return output;
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

export async function appendAndTrimVoiceSample(
  existingSamplePath: string,
  newSamplePath: string,
  outputPath: string,
  tempDir: string,
  maxSeconds: number,
): Promise<void> {
  const mergedPath = path.join(tempDir, `merged-${compactId()}.wav`);
  assertInsideDirectory(mergedPath, tempDir);
  await concatAudioFilesToWav([existingSamplePath, newSamplePath], mergedPath, tempDir);

  try {
    const duration = await getAudioDurationSeconds(mergedPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    if (duration > maxSeconds) {
      await runFfmpeg([
        '-y',
        '-sseof', `-${maxSeconds}`,
        '-i', mergedPath,
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'pcm_s16le',
        outputPath,
      ]);
    } else {
      await copyFile(mergedPath, outputPath);
    }
  } finally {
    await rm(mergedPath, { force: true });
  }
}
