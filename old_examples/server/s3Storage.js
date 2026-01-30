/**
 * S3 Storage Module for Chat Persistence
 * Handles JSON files and binary attachments separately in S3
 * Configuration EXACTLY like memory tool
 */

import 'dotenv/config';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Local fallback directory - exactly like memory
const LOCAL_DATA_DIR = path.join(__dirname, '../../data');

// S3 конфигурация точь-в-точь как в memory
const bucketName = process.env.S3_BUCKET_NAME;
const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

if (!bucketName || !process.env.S3_ENDPOINT || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
  console.warn('[s3Storage] S3 env is not fully configured; falling back to local storage when S3 ops fail.');
}

// toBuffer точь-в-точь как в memory
function toBuffer(streamOrBuffer) {
  if (Buffer.isBuffer(streamOrBuffer)) return Promise.resolve(streamOrBuffer);
  if (streamOrBuffer instanceof Readable) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      streamOrBuffer.on('data', (d) => chunks.push(d));
      streamOrBuffer.on('end', () => resolve(Buffer.concat(chunks)));
      streamOrBuffer.on('error', reject);
    });
  }
  return Promise.resolve(Buffer.from(String(streamOrBuffer || '')));
}

// ensureDataDir точь-в-точь как в memory
async function ensureLocalDir(subDir = '') {
  const dir = subDir ? path.join(LOCAL_DATA_DIR, subDir) : LOCAL_DATA_DIR;
  try { 
    await fs.access(dir); 
  } catch { 
    await fs.mkdir(dir, { recursive: true }); 
  }
  return dir;
}

// Fallback path helper
function localPath(key) {
  return path.join(LOCAL_DATA_DIR, key);
}

// ==========================================
// JSON STORAGE (Chats) - точь-в-точь как loadDataset/saveDataset в memory
// ==========================================

/**
 * Load JSON data - точь-в-точь как loadDataset в memory
 */
export async function loadJson(key) {
  // Try S3
  try {
    const head = new HeadObjectCommand({ Bucket: bucketName, Key: key });
    await s3Client.send(head);
    const get = new GetObjectCommand({ Bucket: bucketName, Key: key });
    const res = await s3Client.send(get);
    const buf = await toBuffer(res.Body);
    return JSON.parse(buf.toString('utf-8'));
  } catch {
    // Fallback local
    try {
      const txt = await fs.readFile(localPath(key), 'utf-8');
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }
}

/**
 * Save JSON data - точь-в-точь как saveDataset в memory
 */
export async function saveJson(key, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  try {
    const put = new PutObjectCommand({ 
      Bucket: bucketName, 
      Key: key, 
      Body: body, 
      ContentType: 'application/json', 
      CacheControl: 'no-cache' 
    });
    await s3Client.send(put);
    return { success: true, location: 's3' };
  } catch (e) {
    // Fallback local
    await ensureLocalDir(path.dirname(key));
    await fs.writeFile(localPath(key), body);
    return { success: true, location: 'local' };
  }
}

/**
 * Delete JSON
 */
export async function deleteJson(key) {
  // Try S3
  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key
    }));
  } catch {
    // Ignore S3 errors
  }
  
  // Also try local
  try {
    await fs.unlink(localPath(key));
  } catch {
    // File doesn't exist locally
  }
  
  return true;
}

/**
 * List objects with prefix
 */
export async function listObjects(prefix) {
  // Try S3
  try {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix
    }));
    
    if (response.Contents && response.Contents.length > 0) {
      return response.Contents.map(obj => obj.Key);
    }
  } catch {
    // Fallback to local
  }
  
  // Local fallback
  try {
    const dir = path.join(LOCAL_DATA_DIR, prefix);
    const files = await fs.readdir(dir);
    return files.map(f => path.join(prefix, f));
  } catch {
    return [];
  }
}

// ==========================================
// BINARY STORAGE (Attachments)
// ==========================================

/**
 * Generate unique attachment ID
 */
export function generateAttachmentId() {
  return `att_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Save attachment - same pattern as saveDataset
 */
export async function saveAttachment(userId, chatId, attachmentId, base64Data, mimeType) {
  const key = `chats/attachments/${userId}/${chatId}/${attachmentId}`;
  const buffer = Buffer.from(base64Data, 'base64');
  
  try {
    const put = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      CacheControl: 'max-age=31536000'
    });
    await s3Client.send(put);
    return { id: attachmentId, key, location: 's3' };
  } catch (e) {
    // Fallback local
    await ensureLocalDir(`chats/attachments/${userId}/${chatId}`);
    await fs.writeFile(localPath(key), buffer);
    return { id: attachmentId, key, location: 'local' };
  }
}

/**
 * Load attachment - same pattern as loadDataset
 */
export async function loadAttachment(userId, chatId, attachmentId) {
  const key = `chats/attachments/${userId}/${chatId}/${attachmentId}`;
  
  // Try S3
  try {
    const head = new HeadObjectCommand({ Bucket: bucketName, Key: key });
    await s3Client.send(head);
    const get = new GetObjectCommand({ Bucket: bucketName, Key: key });
    const response = await s3Client.send(get);
    const buffer = await toBuffer(response.Body);
    return {
      data: buffer.toString('base64'),
      mimeType: response.ContentType || 'application/octet-stream'
    };
  } catch {
    // Fallback local
    try {
      const buffer = await fs.readFile(localPath(key));
      return {
        data: buffer.toString('base64'),
        mimeType: 'application/octet-stream'
      };
    } catch {
      return null;
    }
  }
}

/**
 * Delete all attachments for a chat
 */
export async function deleteAttachments(userId, chatId) {
  const prefix = `chats/attachments/${userId}/${chatId}/`;
  
  // Try S3
  try {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix
    }));
    
    if (response.Contents) {
      for (const obj of response.Contents) {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: bucketName,
          Key: obj.Key
        }));
      }
    }
  } catch {
    // Ignore S3 errors
  }
  
  // Local fallback
  try {
    const dir = localPath(prefix);
    const files = await fs.readdir(dir);
    for (const file of files) {
      await fs.unlink(path.join(dir, file));
    }
    await fs.rmdir(dir);
  } catch {
    // Directory doesn't exist
  }
}
