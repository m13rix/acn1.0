#!/usr/bin/env python
from __future__ import annotations

import json
import math
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


MODEL_ID = "speechbrain/spkrec-ecapa-voxceleb"
np = None
torch = None
F = None
classifier = None
device = None
settings: dict[str, object] = {}


@dataclass(frozen=True)
class EmbeddingResult:
    path: Path
    embedding: object
    duration_sec: float
    chunks: int


def load_runtime_deps() -> None:
    global F, np, torch
    import numpy as numpy_module
    import torch as torch_module
    import torch.nn.functional as functional_module

    np = numpy_module
    torch = torch_module
    F = functional_module


def configure_torch(runtime_device, fp16: bool) -> None:
    if runtime_device.type != "cuda" or not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available. Install CUDA-enabled PyTorch and check your NVIDIA driver.")

    torch.backends.cudnn.benchmark = True
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True

    if hasattr(torch, "set_float32_matmul_precision"):
        torch.set_float32_matmul_precision("high")

    if fp16:
        torch.set_default_dtype(torch.float32)


def load_audio(path: Path, runtime_device, target_sr: int):
    import torchaudio

    if not path.exists():
        raise FileNotFoundError(f"audio file does not exist: {path}")

    wav, sample_rate = torchaudio.load(str(path))
    wav = wav.to(runtime_device, non_blocking=True)

    if wav.ndim != 2:
        raise RuntimeError(f"expected audio tensor with shape [channels, samples], got {tuple(wav.shape)}")

    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)

    wav = wav.squeeze(0).contiguous()

    if sample_rate != target_sr:
        wav = torchaudio.functional.resample(wav, sample_rate, target_sr)
        sample_rate = target_sr

    if wav.numel() < target_sr // 4:
        raise RuntimeError(f"audio is too short for a useful speaker embedding: {path}")

    return wav, sample_rate


def split_chunks(wav, sample_rate: int, chunk_seconds: float, overlap_seconds: float):
    if chunk_seconds <= 0:
        return wav.unsqueeze(0), torch.ones(1, device=wav.device)

    chunk_samples = max(1, int(round(chunk_seconds * sample_rate)))
    overlap_samples = max(0, int(round(overlap_seconds * sample_rate)))

    if overlap_samples >= chunk_samples:
        raise RuntimeError("overlap_seconds must be smaller than chunk_seconds")

    if wav.numel() <= chunk_samples:
        padded = F.pad(wav, (0, chunk_samples - wav.numel()))
        lengths = torch.tensor([wav.numel() / chunk_samples], device=wav.device)
        return padded.unsqueeze(0), lengths

    hop = chunk_samples - overlap_samples
    starts = list(range(0, max(1, wav.numel() - chunk_samples + 1), hop))
    last_start = max(0, wav.numel() - chunk_samples)
    if starts[-1] != last_start:
        starts.append(last_start)

    chunks = torch.empty((len(starts), chunk_samples), device=wav.device, dtype=wav.dtype)
    lengths = torch.ones(len(starts), device=wav.device)

    for index, start in enumerate(starts):
        end = min(start + chunk_samples, wav.numel())
        piece = wav[start:end]
        chunks[index, : piece.numel()] = piece
        if piece.numel() < chunk_samples:
            chunks[index, piece.numel() :] = 0
            lengths[index] = piece.numel() / chunk_samples

    return chunks.contiguous(), lengths


def batched(items, lengths, batch_size: int) -> Iterable[tuple[object, object]]:
    for start in range(0, items.shape[0], batch_size):
        yield items[start : start + batch_size], lengths[start : start + batch_size]


def load_classifier(savedir: Path):
    try:
        from speechbrain.inference.speaker import EncoderClassifier
        from speechbrain.utils.fetching import LocalStrategy
    except Exception:
        from speechbrain.pretrained import EncoderClassifier
        from speechbrain.utils.fetching import LocalStrategy

    loaded = EncoderClassifier.from_hparams(
        source=MODEL_ID,
        savedir=str(savedir),
        local_strategy=LocalStrategy.COPY,
        run_opts={"device": str(device)},
    )
    loaded.eval()
    return loaded


def embed_file(path: Path) -> EmbeddingResult:
    sample_rate = int(settings.get("sample_rate", 16000))
    batch_size = int(settings.get("batch_size", 32))
    chunk_seconds = float(settings.get("chunk_seconds", 0.0))
    overlap_seconds = float(settings.get("overlap_seconds", 0.0))
    fp16 = bool(settings.get("fp16", False))

    with torch.inference_mode():
        wav, sr = load_audio(path, device, sample_rate)
        chunks, lengths = split_chunks(wav, sr, chunk_seconds, overlap_seconds)

        embeddings = []
        autocast = torch.autocast(device_type="cuda", dtype=torch.float16, enabled=fp16)
        with autocast:
            for chunk_batch, len_batch in batched(chunks, lengths, batch_size):
                emb = classifier.encode_batch(chunk_batch, wav_lens=len_batch)
                emb = emb.squeeze(1) if emb.ndim == 3 else emb
                embeddings.append(F.normalize(emb.float(), dim=-1))

        stacked = torch.cat(embeddings, dim=0)
        if stacked.shape[0] == 1:
            embedding = stacked[0]
        else:
            embedding = F.normalize(stacked.mean(dim=0), dim=-1)

        return EmbeddingResult(
            path=path,
            embedding=embedding.detach().cpu(),
            duration_sec=wav.numel() / sr,
            chunks=stacked.shape[0],
        )


def write_response(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle_init(request: dict[str, object]) -> None:
    global classifier, device, settings
    settings = dict(request.get("settings") or {})
    load_runtime_deps()
    device = torch.device(str(settings.get("device", "cuda:0")))
    configure_torch(device, bool(settings.get("fp16", False)))
    classifier = load_classifier(Path(str(settings.get("model_cache", "models/speechbrain-spkrec-ecapa-voxceleb"))))
    classifier.eval()

    sample_rate = int(settings.get("sample_rate", 16000))
    with torch.inference_mode():
        wav = torch.zeros(sample_rate, device=device)
        chunks, lengths = split_chunks(wav, sample_rate, 0.0, 0.0)
        emb = classifier.encode_batch(chunks, wav_lens=lengths)
        _ = F.normalize((emb.squeeze(1) if emb.ndim == 3 else emb).float(), dim=-1).detach().cpu()

    write_response({"id": request.get("id"), "ok": True, "model": MODEL_ID})


def handle_embed(request: dict[str, object]) -> None:
    if classifier is None:
        raise RuntimeError("ECAPA sidecar is not initialized.")

    paths = [Path(str(item)) for item in request.get("paths", [])]
    results = []
    audio_total = 0.0
    for audio_path in paths:
        result = embed_file(audio_path)
        embedding = result.embedding.numpy().astype(np.float32)
        norm = float(np.linalg.norm(embedding))
        if norm > 0 and math.isfinite(norm):
            embedding = embedding / norm
        audio_total += result.duration_sec
        results.append({
            "path": str(result.path),
            "embedding": embedding.tolist(),
            "durationSec": result.duration_sec,
            "chunks": result.chunks,
            "model": MODEL_ID,
        })

    write_response({"id": request.get("id"), "ok": True, "results": results, "audioTotalSec": audio_total})


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            command = request.get("command")
            if command == "init":
                handle_init(request)
            elif command == "embed":
                handle_embed(request)
            elif command == "shutdown":
                write_response({"id": request.get("id"), "ok": True})
                return
            else:
                raise RuntimeError(f"unknown command: {command}")
        except Exception as exc:
            write_response({
                "id": locals().get("request", {}).get("id") if isinstance(locals().get("request"), dict) else None,
                "ok": False,
                "error": str(exc),
                "trace": traceback.format_exc(),
            })


if __name__ == "__main__":
    main()
