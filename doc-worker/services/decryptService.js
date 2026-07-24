const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function decryptPdfBuffer(inputBuffer) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const inputPath = path.join(tmpDir, `in-${id}.pdf`);
  const outputPath = path.join(tmpDir, `out-${id}.pdf`);

  try {
    fs.writeFileSync(inputPath, inputBuffer);

    try {
      execSync(`qpdf --decrypt "${inputPath}" "${outputPath}"`, { stdio: 'pipe' });
    } catch (err) {
      // qpdf exit codes: 0 = clean success, 3 = succeeded but with warnings
      // (e.g. minor structural repairs it made automatically), 2 = real
      // failure. execSync throws on any non-zero code, so we need to check
      // whether it was actually just a warning before treating it as fatal.
      const exitCode = err.status;
      const outputExists = fs.existsSync(outputPath);

      if (exitCode === 3 && outputExists) {
        console.warn(`qpdf repaired minor issues in the PDF (exit code 3): ${err.stderr ? err.stderr.toString() : ''}`);
        // fall through — treat as success, the repaired file is usable
      } else {
        const stderr = err.stderr ? err.stderr.toString() : err.message;
        throw new Error(`qpdf failed to process the PDF: ${stderr}`);
      }
    }

    return fs.readFileSync(outputPath);
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
}

module.exports = { decryptPdfBuffer };