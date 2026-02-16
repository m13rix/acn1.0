import WebSocket from "ws";
import fs from "fs";
import path from "path";

const COMFY_HTTP = "http://127.0.0.1:8000";
const COMFY_WS = "ws://127.0.0.1:8000/ws";

// ComfyUI output folder for audio
const COMFY_AUDIO_OUTPUT = "G:/ComfyUI/output/audio";

// 🔁 PUT YOUR WORKFLOW HERE
import workflow from "./audio_workflow.json";

// Путь к reference audio
const REFERENCE_AUDIO = "G:/agent0/acn1.0/tools/editor/Recording.m4a";

const promptNodeId = "42";
const loadAudioNodeId = "24";

/**
 * Загружает файл в ComfyUI input folder через API
 */
async function uploadFile(filePath: string): Promise<string> {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\n`),
        Buffer.from(`Content-Disposition: form-data; name="image"; filename="${fileName}"\r\n`),
        Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`),
        fileBuffer,
        Buffer.from(`\r\n--${boundary}\r\n`),
        Buffer.from(`Content-Disposition: form-data; name="type"\r\n\r\n`),
        Buffer.from(`input\r\n`),
        Buffer.from(`--${boundary}--\r\n`),
    ]);

    const res = await fetch(`${COMFY_HTTP}/upload/image`, {
        method: "POST",
        headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: body,
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upload failed: ${res.status} - ${text}`);
    }

    const result = await res.json() as { name: string };
    console.log("Uploaded file:", result);
    return result.name;
}

/**
 * Получает список .mp3 файлов в папке
 */
function getMp3Files(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.mp3'))
        .map(f => path.join(dir, f));
}

/**
 * Ждёт появления нового .mp3 файла в папке
 */
async function waitForNewMp3(dir: string, existingFiles: Set<string>, timeoutMs: number = 120000): Promise<string | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const currentFiles = getMp3Files(dir);

        for (const file of currentFiles) {
            if (!existingFiles.has(file)) {
                await sleep(500);
                return file;
            }
        }

        await sleep(1000);
        process.stdout.write(".");
    }

    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    // 0. Запоминаем существующие файлы ДО генерации
    const existingFiles = new Set(getMp3Files(COMFY_AUDIO_OUTPUT));
    console.log(`Found ${existingFiles.size} existing mp3 files in output folder`);

    // 1. Загружаем reference audio (если нужно)
    console.log("Uploading reference audio...");
    const uploadedFileName = await uploadFile(REFERENCE_AUDIO);

    // 2. Обновляем workflow
    workflow[promptNodeId].inputs.value = "Привет! Это тестовое сообщение синтезированное через ComfyUI API.";
    workflow[loadAudioNodeId].inputs.audio = uploadedFileName;

    console.log("Workflow to send:", JSON.stringify(workflow, null, 2));
    console.log("\nQueueing prompt...");

    // 3. Queue prompt
    const promptRes = await fetch(`${COMFY_HTTP}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            prompt: workflow,
            client_id: "node-client",
        }),
    });

    const result = await promptRes.json();
    console.log("Full API response:", JSON.stringify(result, null, 2));

    // Проверяем на ошибки валидации
    if (result.error) {
        console.error("❌ ComfyUI API Error:", result.error);
        if (result.node_errors) {
            console.error("Node errors:", JSON.stringify(result.node_errors, null, 2));
        }
        process.exit(1);
    }

    const prompt_id = result.prompt_id;
    console.log("Queued prompt_id:", prompt_id);

    // 4. Подключаемся к WebSocket для мониторинга
    console.log("\nConnecting to WebSocket...");
    const ws = new WebSocket(`${COMFY_WS}?clientId=node-client`);

    ws.on("open", () => {
        console.log("WS connected, waiting for execution...");
    });

    ws.on("message", (data, isBinary) => {
        if (isBinary) return;

        const msg = JSON.parse(data.toString());
        console.log("WS message:", msg.type, JSON.stringify(msg.data || {}).substring(0, 200));

        if (msg.type === "execution_error") {
            console.error("❌ Execution error:", JSON.stringify(msg.data, null, 2));
        }

        if (msg.type === "executing" && msg.data?.node === null) {
            console.log("✅ Execution finished via WS");
        }
    });

    ws.on("error", (err) => {
        console.error("WS error:", err);
    });

    // 5. Ждём появления нового .mp3 файла
    console.log("\nWaiting for audio generation (timeout: 2 min)");

    const newFile = await waitForNewMp3(COMFY_AUDIO_OUTPUT, existingFiles);

    ws.close();

    if (!newFile) {
        console.error("\n❌ Timeout: no new mp3 file appeared");

        // Проверим историю
        console.log("\nChecking history...");
        const histRes = await fetch(`${COMFY_HTTP}/history/${prompt_id}`);
        const history = await histRes.json();
        console.log("History:", JSON.stringify(history, null, 2));

        process.exit(1);
    }

    console.log(`\n✅ New audio file detected: ${newFile}`);

    // 6. Копируем файл к себе
    const outputPath = path.join(process.cwd(), `output_${Date.now()}.mp3`);
    fs.copyFileSync(newFile, outputPath);
    console.log(`✅ Saved to: ${outputPath}`);

    // 7. Удаляем оригинал из ComfyUI output
    fs.unlinkSync(newFile);
    console.log(`🗑️ Deleted original: ${newFile}`);

    console.log("\nDone!");
    process.exit(0);
}

main().catch(console.error);
