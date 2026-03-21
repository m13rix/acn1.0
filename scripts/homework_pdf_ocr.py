import json
import subprocess
import sys
import tempfile
from pathlib import Path

import fitz


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    if len(sys.argv) != 4:
        print(json.dumps({"ok": False, "error": "Usage: homework_pdf_ocr.py <pdf_path> <start_page> <end_page>"}))
        return 1

    pdf_path = sys.argv[1]
    start_page = int(sys.argv[2])
    end_page = int(sys.argv[3])
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent
    tessdata_dir = project_root / "data" / "tessdata"
    tesseract_path = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")

    doc = fitz.open(pdf_path)
    pages = []

    for page_index in range(start_page - 1, end_page):
        page = doc.load_page(page_index)
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp_file:
            temp_path = Path(tmp_file.name)
        pix.save(temp_path)

        try:
            result = subprocess.run(
                [
                    str(tesseract_path),
                    str(temp_path),
                    "stdout",
                    "--tessdata-dir",
                    str(tessdata_dir),
                    "-l",
                    "rus+eng",
                    "--psm",
                    "3",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="ignore",
                check=True,
            )
            text = result.stdout.strip()
            pages.append({"page": page_index + 1, "text": text})
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:
                pass

    print(json.dumps({"ok": True, "pages": pages}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
