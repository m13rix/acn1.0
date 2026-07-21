from __future__ import annotations

import hashlib
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx


REVISION = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af"
MODEL_DIR = Path(__file__).resolve().parents[1] / "data" / "memory-v2" / "qwen3-embedding-8b"
DOWNLOAD_DIR = MODEL_DIR / ".cache" / "huggingface" / "download"
CHUNK_SIZE = 8 * 1024 * 1024
FILES = (
    ("model-00001-of-00004.safetensors", 4_900_037_024, "99b343597fe840706146144699a8b9188dd3387e43eb61faf0231b70b249d451"),
    ("model-00002-of-00004.safetensors", 4_915_959_512, "dff635b0f6dbbaad2a2d633ef037ec0a39bc165cc1806c712fbd6fcbcb4526c0"),
    ("model-00003-of-00004.safetensors", 4_983_067_656, "30b1d4c53d84eb018f642cad7b373f0aabf79699872d8702c1f38577c0a59a2f"),
    ("model-00004-of-00004.safetensors", 335_570_376, "36cbc9c60375693629f25743c1e77ebb1724af58e671b2376463193c7fd21ef6"),
)
print_lock = threading.Lock()


def log(message: str) -> None:
    with print_lock:
        print(message, flush=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(16 * 1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def adopt_largest_partial(part: Path, expected_sha: str, expected_size: int) -> None:
    if part.exists() or not DOWNLOAD_DIR.exists():
        return
    candidates = [
        item for item in DOWNLOAD_DIR.glob(f"*.{expected_sha}.*.incomplete")
        if item.is_file() and 0 < item.stat().st_size <= expected_size
    ]
    if not candidates:
        return
    source = max(candidates, key=lambda item: item.stat().st_size)
    os.replace(source, part)
    log(f"{part.name}: resumed {part.stat().st_size / (1024 ** 3):.2f} GiB from the Hub partial")


def download_file(name: str, expected_size: int, expected_sha: str) -> None:
    target = MODEL_DIR / name
    part = MODEL_DIR / f"{name}.part"
    if target.exists() and target.stat().st_size == expected_size and sha256(target) == expected_sha:
        log(f"{name}: already verified")
        return

    adopt_largest_partial(part, expected_sha, expected_size)
    if part.exists() and part.stat().st_size > expected_size:
        part.unlink()
    downloaded = part.stat().st_size if part.exists() else 0
    origin_url = f"https://huggingface.co/Qwen/Qwen3-Embedding-8B/resolve/{REVISION}/{name}?download=true"
    download_url = origin_url
    last_report = time.monotonic()
    next_report = downloaded + 256 * 1024 * 1024

    timeout = httpx.Timeout(45.0, connect=15.0, read=45.0, write=45.0, pool=45.0)
    with httpx.Client(follow_redirects=True, timeout=timeout, headers={"Accept-Encoding": "identity"}) as client:
        with part.open("ab") as handle:
            while downloaded < expected_size:
                end = min(expected_size - 1, downloaded + CHUNK_SIZE - 1)
                expected = end - downloaded + 1
                error: Exception | None = None
                for attempt in range(10):
                    try:
                        response = client.get(download_url, headers={"Range": f"bytes={downloaded}-{end}"})
                        response.raise_for_status()
                        content_range = response.headers.get("content-range", "")
                        if response.status_code != 206 or not content_range.startswith(f"bytes {downloaded}-{end}/"):
                            raise RuntimeError(f"unexpected range response {response.status_code} {content_range!r}")
                        if len(response.content) != expected:
                            raise RuntimeError(f"short range: expected {expected}, received {len(response.content)}")
                        handle.write(response.content)
                        handle.flush()
                        downloaded += expected
                        # The Hub origin redirects immutable model blobs to a signed CDN
                        # URL. Reusing it avoids one rate-limited Hub request per chunk.
                        download_url = str(response.url)
                        error = None
                        break
                    except Exception as exc:  # network retry path
                        error = exc
                        if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in {401, 403}:
                            download_url = origin_url
                        time.sleep(min(10.0, 0.5 * (2 ** attempt)))
                if error is not None:
                    raise RuntimeError(f"{name}: range {downloaded}-{end} failed after retries: {error}")
                now = time.monotonic()
                if downloaded >= next_report or now - last_report >= 30:
                    log(f"{name}: {downloaded / (1024 ** 3):.2f}/{expected_size / (1024 ** 3):.2f} GiB")
                    next_report = downloaded + 256 * 1024 * 1024
                    last_report = now

    log(f"{name}: verifying SHA-256")
    actual_sha = sha256(part)
    if actual_sha != expected_sha:
        raise RuntimeError(f"{name}: SHA-256 mismatch: {actual_sha} != {expected_sha}")
    os.replace(part, target)
    log(f"{name}: complete and verified")


def main() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=len(FILES), thread_name_prefix="qwen-shard") as pool:
        futures = [pool.submit(download_file, *item) for item in FILES]
        for future in futures:
            future.result()
    log(f"All Qwen3-Embedding-8B shards verified in {(time.monotonic() - started) / 60:.1f} minutes")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr, flush=True)
        raise
