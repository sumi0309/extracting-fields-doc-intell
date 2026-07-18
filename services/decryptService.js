const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function decryptPdfBuffer(inputBuffer) {
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `in-${Date.now()}.pdf`);
  const outputPath = path.join(tmpDir, `out-${Date.now()}.pdf`);

  fs.writeFileSync(inputPath, inputBuffer);
  execSync(`qpdf --decrypt "${inputPath}" "${outputPath}"`);
  const decrypted = fs.readFileSync(outputPath);

  fs.unlinkSync(inputPath);
  fs.unlinkSync(outputPath);
  return decrypted;
}

module.exports = { decryptPdfBuffer };