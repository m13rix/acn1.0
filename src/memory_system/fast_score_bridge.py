import json
import os
import sys
import numpy as np


def load_matrix(root, name, count, dimensions):
    if count <= 0:
        return np.empty((0, dimensions), dtype=np.float32), np.empty((0,), dtype=np.int32)
    matrix = np.memmap(os.path.join(root, f"{name}.f32"), dtype="<f4", mode="r", shape=(count, dimensions))
    facts = np.memmap(os.path.join(root, f"{name}.fact_i32"), dtype="<i4", mode="r", shape=(count,))
    return matrix, facts


root = sys.argv[1]
with open(os.path.join(root, "manifest.json"), "r", encoding="utf-8") as handle:
    manifest = json.load(handle)

dims = int(manifest["dimensions"])
fact_count = int(manifest["factCount"])
globals_matrix, globals_facts = load_matrix(root, "globals", int(manifest["globalCount"]), dims)
phrase_matrices = {}
for phrase_type in ("np", "vp", "adjp"):
    phrase_matrices[phrase_type] = load_matrix(root, f"phrases_{phrase_type}", int(manifest["phraseCounts"].get(phrase_type, 0)), dims)

print(json.dumps({"ready": True, "facts": fact_count}), flush=True)

for line in sys.stdin:
    try:
        request = json.loads(line)
        global_query = np.asarray(request["globalEmbedding"], dtype=np.float32)
        scores = np.zeros((fact_count,), dtype=np.float32)
        global_values = globals_matrix @ global_query
        global_best = np.zeros((fact_count,), dtype=np.float32)
        np.maximum.at(global_best, globals_facts, np.maximum(global_values, 0))
        scores += global_best * float(request["overallEmbeddingWeight"])

        aggregation = request.get("aggregation", "max")
        phrases = request.get("phrases", [])
        for phrase_type in ("np", "vp", "adjp"):
            selected = [item for item in phrases if item.get("type") == phrase_type]
            if not selected:
                continue
            matrix, fact_indices = phrase_matrices[phrase_type]
            query_matrix = np.asarray([item["embedding"] for item in selected], dtype=np.float32).T
            similarities = matrix @ query_matrix
            similarities = np.maximum(similarities, 0)
            for column, item in enumerate(selected):
                aggregated = np.zeros((fact_count,), dtype=np.float32)
                if aggregation == "sum":
                    np.add.at(aggregated, fact_indices, similarities[:, column])
                else:
                    np.maximum.at(aggregated, fact_indices, similarities[:, column])
                scores += aggregated * float(item["weight"])

        print(json.dumps({"id": request.get("id"), "scores": scores.tolist()}, separators=(",", ":")), flush=True)
    except Exception as error:
        print(json.dumps({"id": request.get("id") if "request" in locals() else None, "error": str(error)}), flush=True)
