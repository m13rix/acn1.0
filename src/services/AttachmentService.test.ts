import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { v7 as uuidv7 } from "uuid";

import type { ThreadLaunchProfile } from "@telos/code-contracts/telos";
import { AttachmentService } from "./AttachmentService.js";
import { ThreadStore } from "./thread-store/ThreadStore.js";

async function fixture(
  run: (
    attachments: AttachmentService,
    store: ThreadStore,
    threadId: string,
    directory: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = join(tmpdir(), `telos-attachments-${uuidv7()}`);
  await mkdir(directory, { recursive: true });
  const store = await ThreadStore.open({
    databasePath: join(directory, "threads.db"),
  });
  const project = store.createProject({ path: directory });
  const profile: ThreadLaunchProfile = {
    projectId: project.id as ThreadLaunchProfile["projectId"],
    workspacePath: directory,
    worktreePath: null,
    agentName: "executor",
    resolvedAgentConfig: { preserveSession: true },
    providerId: "openai-codex",
    modelId: "gpt-5.6-codex",
    reasoning: "high",
  };
  const thread = store.createThread({ launchProfile: profile });
  const attachments = new AttachmentService(
    store,
    join(directory, "attachment-store"),
  );
  try {
    await run(attachments, store, thread.id, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("copies immutable file bytes with MIME and content hash metadata", async () => {
  await fixture(async (attachments, store, threadId, directory) => {
    const source = join(directory, "result.txt");
    await writeFile(source, "original");
    const attachment = await attachments.createFromFile({
      threadId,
      sourcePath: source,
    });
    await writeFile(source, "changed");

    assert.equal(attachment.mimeType, "text/plain");
    assert.equal(attachment.size, 8);
    assert.equal(
      attachment.sha256,
      "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5",
    );
    assert.equal(await readFile(attachment.storagePath, "utf8"), "original");
    assert.deepEqual(
      store.listAttachments(threadId).map((item) => item.id),
      [attachment.id],
    );
  });
});

test("stores byte uploads and removes both metadata and immutable bytes", async () => {
  await fixture(async (attachments, store, threadId) => {
    const attachment = await attachments.createFromBytes({
      threadId,
      name: "../recording.ogg",
      mimeType: "audio/ogg",
      bytes: Buffer.from("voice"),
    });
    assert.equal(attachment.name, "recording.ogg");
    assert.equal(
      attachments.get(attachment.id, threadId).mimeType,
      "audio/ogg",
    );
    await attachments.delete(attachment.id, threadId);
    assert.equal(store.getAttachment(attachment.id), null);
    assert.equal(existsSync(attachment.storagePath), false);
  });
});
