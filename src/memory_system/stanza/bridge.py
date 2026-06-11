from __future__ import annotations

import json
import re
import sys
from functools import lru_cache
from typing import Any

import stanza
from stanza.pipeline.core import DownloadMethod


def parse_request(raw: str) -> dict[str, Any]:
    if not raw.strip():
        raise ValueError("Empty stanza bridge request")
    return json.loads(raw)


def count_cyrillic(text: str) -> int:
    return len(re.findall(r"[\u0400-\u04FF]", text))


def count_latin(text: str) -> int:
    return len(re.findall(r"[A-Za-z]", text))


def detect_language(text: str, preferred: str | None) -> str:
    preferred_clean = (preferred or "").strip().lower()
    if preferred_clean in {"en", "ru"}:
        return preferred_clean
    if count_cyrillic(text) > count_latin(text):
        return "ru"
    return "en"


def processor_string(lang: str) -> str:
    if lang == "en":
        return "tokenize,pos,lemma,depparse,constituency"
    return "tokenize,pos,lemma,depparse"


def ensure_download(lang: str, model_dir: str) -> None:
    processors = processor_string(lang)
    stanza.download(
        lang,
        processors=processors,
        model_dir=model_dir,
        logging_level="WARN",
        verbose=False,
    )


@lru_cache(maxsize=4)
def get_pipeline(lang: str, model_dir: str):
    ensure_download(lang, model_dir)
    return stanza.Pipeline(
        lang=lang,
        processors=processor_string(lang),
        model_dir=model_dir,
        download_method=DownloadMethod.REUSE_RESOURCES,
        logging_level="WARN",
        verbose=False,
        use_gpu=False,
    )


def serialize_dependencies(sentence) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for word in sentence.words:
        rows.append(
            {
                "id": int(word.id),
                "text": word.text,
                "lemma": word.lemma,
                "upos": word.pos,
                "xpos": word.xpos,
                "head": int(word.head) if word.head is not None else 0,
                "deprel": word.deprel,
            }
        )
    return rows


def analyze_text(text: str, preferred_language: str | None, model_dir: str) -> dict[str, Any]:
    lang = detect_language(text, preferred_language)
    pipeline = get_pipeline(lang, model_dir)
    doc = pipeline(text)

    sentences: list[dict[str, Any]] = []
    for index, sentence in enumerate(doc.sentences):
        constituency = None
        if hasattr(sentence, "constituency") and sentence.constituency is not None:
            constituency = str(sentence.constituency)
        sentences.append(
            {
                "sentenceIndex": index,
                "text": sentence.text,
                "constituency": constituency,
                "dependencies": serialize_dependencies(sentence),
            }
        )

    return {
        "language": lang,
        "parserMode": "constituency" if lang == "en" else "ud",
        "sentences": sentences,
    }


def warm_pipelines(languages: list[str], model_dir: str) -> dict[str, Any]:
    warmed: list[str] = []
    for lang in languages:
        normalized = detect_language(lang, lang)
        get_pipeline(normalized, model_dir)
        if normalized not in warmed:
            warmed.append(normalized)
    return {
        "languages": warmed,
    }


def handle_request(request: dict[str, Any]) -> dict[str, Any]:
    action = str(request.get("action") or "").strip()
    model_dir = str(request.get("modelDir") or "").strip()
    if not model_dir:
        raise ValueError("modelDir is required")

    if action == "analyze_text":
        return analyze_text(
            text=str(request.get("text") or ""),
            preferred_language=request.get("language"),
            model_dir=model_dir,
        )

    if action == "warm_pipelines":
        raw_languages = request.get("languages")
        languages = raw_languages if isinstance(raw_languages, list) else ["en", "ru"]
        return warm_pipelines([str(item or "") for item in languages], model_dir)

    raise ValueError(f"Unsupported stanza bridge action: {action}")


def process_payload(raw: str) -> str:
    try:
        request = parse_request(raw)
        result = handle_request(request)
        return json.dumps({"ok": True, "result": result}, ensure_ascii=False)
    except Exception as exc:  # pragma: no cover - bridge error path
        return json.dumps(
            {
                "ok": False,
                "error": {
                    "message": str(exc),
                },
            },
            ensure_ascii=False,
        )


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--stdio-loop":
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            sys.stdout.write(process_payload(line))
            sys.stdout.write("\n")
            sys.stdout.flush()
        return

    raw = sys.stdin.read()
    sys.stdout.write(process_payload(raw))


if __name__ == "__main__":
    main()
