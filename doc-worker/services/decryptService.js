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
      const stderr = err.stderr ? err.stderr.toString() : err.message;
      throw new Error(`qpdf failed to process the PDF: ${stderr}`);
    }

    return fs.readFileSync(outputPath);
  } finally {
    // Always clean up temp files, even if qpdf or readFileSync threw.
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
}

module.exports = { decryptPdfBuffer };