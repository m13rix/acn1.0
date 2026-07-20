from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import torch
from sentence_transformers import SentenceTransformer


def load_model(model_dir: Path) -> SentenceTransformer:
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    return SentenceTransformer(
        str(model_dir),
        device="cuda",
        model_kwargs={"torch_dtype": torch.bfloat16},
        processor_kwargs={"padding_side": "left"},
    )


def run_stdio(model: SentenceTransformer) -> None:
    for raw in sys.stdin:
        request: dict[str, Any] = {}
        try:
            request = json.loads(raw)
            texts = [str(item or "") for item in request.get("texts", [])]
            vectors = model.encode(texts, batch_size=max(1, min(32, len(texts))), normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
            result: dict[str, Any] = {"id": request.get("id"), "vectors": vectors.astype("float32").tolist()}
        except Exception as exc:
            result = {"id": request.get("id"), "error": str(exc)}
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def run_http(model_dir: Path, port: int) -> None:
    inference_lock = threading.Lock()
    model: SentenceTransformer | None = None

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def respond(self, status: int, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:
            if self.path == "/health":
                if model is None:
                    self.respond(503, {"ready": False})
                else:
                    self.respond(200, {"ready": True, "device": str(model.device)})
            else:
                self.respond(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/embed":
                self.respond(404, {"error": "not found"})
                return
            try:
                if model is None:
                    self.respond(503, {"error": "model is still loading"})
                    return
                length = int(self.headers.get("Content-Length", "0"))
                request = json.loads(self.rfile.read(length))
                texts = [str(item or "") for item in request.get("texts", [])]
                with inference_lock:
                    vectors = model.encode(texts, batch_size=max(1, min(32, len(texts))), normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
                self.respond(200, {"vectors": vectors.astype("float32").tolist()})
            except Exception as exc:
                self.respond(500, {"error": str(exc)})

    # Bind before loading the 8B model. A concurrent launcher then fails cheaply
    # at bind time instead of consuming a second copy of VRAM during model load.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    model = load_model(model_dir)
    server.serve_forever()


def main() -> None:
    if len(sys.argv) < 2:
        raise ValueError("model directory is required")
    if sys.argv[1] == "--http":
        if len(sys.argv) < 4:
            raise ValueError("--http requires port and model directory")
        run_http(Path(sys.argv[3]).resolve(), int(sys.argv[2]))
        return
    run_stdio(load_model(Path(sys.argv[1]).resolve()))


if __name__ == "__main__":
    main()
