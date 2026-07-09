const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = 'D:/cloud/deepcloud/super agent/GitNexus';
const BATCHES_FILE = path.join(PROJECT_ROOT, '.understand-anything/intermediate/batches.json');
const TMP_DIR = path.join(PROJECT_ROOT, '.understand-anything/tmp');
const EXTRACT_SCRIPT =
  'D:/cloud/deepcloud/super agent/Understand-Anything/understand-anything-plugin/skills/understand/extract-structure.mjs';

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

const data = JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf8'));

[25, 26, 27, 28].forEach((batchIndex) => {
  const batch = data.batches.find((b) => b.batchIndex === batchIndex);
  if (!batch) {
    console.error('Batch not found:', batchIndex);
    return;
  }

  const inputObj = {
    projectRoot: PROJECT_ROOT,
    batchFiles: batch.files,
    batchImportData: batch.batchImportData,
  };

  const inputPath = path.join(TMP_DIR, `ua-file-analyzer-input-${batchIndex}.json`);
  fs.writeFileSync(inputPath, JSON.stringify(inputObj, null, 2));

  const outputPath = path.join(TMP_DIR, `ua-file-extract-results-${batchIndex}.json`);

  console.log(`Running extraction for batch ${batchIndex}...`);
  try {
    execSync(`node "${EXTRACT_SCRIPT}" "${inputPath}" "${outputPath}"`, { stdio: 'inherit' });
  } catch (e) {
    console.error(`Error extracting batch ${batchIndex}:`, e.message);
  }
});
