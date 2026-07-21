import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { lookup } from "mime-types";
import { v7 as uuidv7 } from "uuid";

import { ThreadStore } from "./thread-store/ThreadStore.js";
import type { StoredAttachment } from "./thread-store/types.js";

export class AttachmentService {
  private readonly root: string;

  constructor(
    private readonly store: ThreadStore,
    storageRoot: string,
  ) {
    this.root = resolve(storageRoot);
  }

  async createFromFile(input: {
    threadId: string;
    sourcePath: string;
    name?: string;
    mimeType?: string;
  }): Promise<StoredAttachment> {
    const sourcePath = resolve(input.sourcePath);
    const source = await stat(sourcePath);
    if (!source.isFile())
      throw new Error(`Attachment source is not a regular file: ${sourcePath}`);
    const name = safeName(input.name || basename(sourcePath));
    const id = uuidv7();
    const directory = join(this.root, input.threadId);
    const destination = join(directory, id);
    const temporary = `${destination}.partial`;
    await mkdir(directory, { recursive: true });
    try {
      await copyFile(sourcePath, temporary);
      const [sha256, copied] = await Promise.all([
        hashFile(temporary),
        stat(temporary),
      ]);
      await rename(temporary, destination);
      return this.store.createAttachment({
        id,
        threadId: input.threadId,
        name,
        mimeType: input.mimeType || lookup(name) || "application/octet-stream",
        size: copied.size,
        sha256,
        storagePath: destination,
      });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async createFromBytes(input: {
    threadId: string;
    bytes: Uint8Array;
    name: string;
    mimeType?: string;
  }): Promise<StoredAttachment> {
    const name = safeName(input.name);
    const id = uuidv7();
    const directory = join(this.root, input.threadId);
    const destination = join(directory, id);
    const temporary = `${destination}.partial`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, input.bytes, { flag: "wx" });
      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      await rename(temporary, destination);
      return this.store.createAttachment({
        id,
        threadId: input.threadId,
        name,
        mimeType: input.mimeType || lookup(name) || "application/octet-stream",
        size: input.bytes.byteLength,
        sha256,
        storagePath: destination,
      });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  get(id: string, threadId?: string): StoredAttachment {
    const attachment = this.store.getAttachment(id);
    if (!attachment || (threadId && attachment.threadId !== threadId)) {
      throw new Error(`Attachment not found: ${id}`);
    }
    return attachment;
  }

  list(threadId: string): StoredAttachment[] {
    return this.store.listAttachments(threadId);
  }

  async delete(id: string, threadId?: string): Promise<void> {
    const attachment = this.get(id, threadId);
    this.store.deleteAttachment(id);
    await rm(attachment.storagePath, { force: true });
  }
}

function safeName(value: string): string {
  const name = basename(value).trim();
  if (!name || name === "." || name === "..")
    throw new Error("Attachment name is invalid.");
  return name.slice(0, 255) || `attachment${extname(value)}`;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}
