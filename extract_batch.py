import json
import sys
import os

batch_index = int(sys.argv[1])
base_dir = "D:/cloud/deepcloud/super agent/GitNexus/.understand-anything"
tmp_dir = os.path.join(base_dir, "tmp")
os.makedirs(tmp_dir, exist_ok=True)

with open(os.path.join(base_dir, "intermediate/batches.json"), "r", encoding="utf-8") as f:
    data = json.load(f)

batch = next((b for b in data.get("batches", []) if b.get("batchIndex") == batch_index), None)
if batch is None:
    print(f"Batch {batch_index} not found!")
    sys.exit(1)

# Step 1 input format for extract-structure.mjs
input_data = {
    "projectRoot": "D:/cloud/deepcloud/super agent/GitNexus",
    "batchFiles": batch.get("files", []),
    "batchImportData": batch.get("imports", {})
}

input_path = os.path.join(tmp_dir, f"ua-file-analyzer-input-{batch_index}.json")
with open(input_path, "w", encoding="utf-8") as f:
    json.dump(input_data, f, indent=2)

print(f"Wrote input for batch {batch_index} to {input_path}")
