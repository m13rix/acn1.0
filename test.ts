import "dotenv/config";
import CloudConvert from "cloudconvert";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const apiKey = process.env.CLOUDCONVERT_API_KEY;

if (!apiKey) {
    throw new Error("Missing CLOUDCONVERT_API_KEY in .env");
}

const inputPath = process.argv[2];
const outputDir = process.argv[3] ?? "./out";

if (!inputPath) {
    console.error("Usage:");
    console.error("  npx tsx convert-pptx-to-jpg.ts ./presentation.pptx ./out");
    process.exit(1);
}

if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
}

const cloudConvert = new CloudConvert(apiKey);

async function downloadFile(url: string, outputPath: string): Promise<void> {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fsp.writeFile(outputPath, buffer);
}

async function convertPptxToJpg(inputPath: string, outputDir: string): Promise<void> {
    await fsp.mkdir(outputDir, { recursive: true });

    console.log("Creating CloudConvert job...");

    let job = await cloudConvert.jobs.create({
        tasks: {
            "upload-pptx": {
                operation: "import/upload",
            },

            "convert-to-jpg": {
                operation: "convert",
                input: "upload-pptx",
                input_format: "pptx",
                output_format: "jpg",

                // Optional:
                // engine: "office",
                // pixel_density: 200,
            },

            "export-jpgs": {
                operation: "export/url",
                input: "convert-to-jpg",
            },
        },
    });

    const uploadTask = job.tasks?.find((task: any) => task.name === "upload-pptx");

    if (!uploadTask) {
        throw new Error("Could not find CloudConvert upload task.");
    }

    console.log("Uploading PPTX...");

    await cloudConvert.tasks.upload(
        uploadTask,
        fs.createReadStream(inputPath),
        path.basename(inputPath),
    );

    console.log("Waiting for conversion...");

    job = await cloudConvert.jobs.wait(job.id);

    const failedTask = job.tasks?.find((task: any) => task.status === "error");

    if (failedTask) {
        console.error("CloudConvert task failed:");
        console.error(JSON.stringify(failedTask, null, 2));
        throw new Error(`CloudConvert task failed: ${failedTask.name}`);
    }

    const exportedFiles = cloudConvert.jobs.getExportUrls(job);

    if (!exportedFiles.length) {
        throw new Error("No exported JPG files found.");
    }

    console.log(`Downloading ${exportedFiles.length} JPG file(s)...`);

    for (let i = 0; i < exportedFiles.length; i++) {
        const file = exportedFiles[i];

        // CloudConvert usually returns good filenames, but we normalize fallback names just in case.
        const safeFilename = file.filename || `slide-${String(i + 1).padStart(3, "0")}.jpg`;
        const outputPath = path.join(outputDir, safeFilename);

        await downloadFile(file.url, outputPath);

        console.log(`Saved: ${outputPath}`);
    }

    console.log("Done.");
}

convertPptxToJpg(inputPath, outputDir).catch((error) => {
    console.error(error);
    process.exit(1);
});
