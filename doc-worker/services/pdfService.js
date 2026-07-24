const { PDFDocument } = require('pdf-lib');

// Splits a PDF buffer into an array of smaller PDF buffers (batches of pages).
async function splitPdfIntoBatches(pdfBuffer, pagesPerBatch) {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const totalPages = srcDoc.getPageCount();
  const batches = [];

  for (let start = 0; start < totalPages; start += pagesPerBatch) {
    const end = Math.min(start + pagesPerBatch, totalPages);
    const newDoc = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const copiedPages = await newDoc.copyPages(srcDoc, indices);
    copiedPages.forEach((p) => newDoc.addPage(p));
    const bytes = await newDoc.save();
    batches.push({
      buffer: Buffer.from(bytes),
      startPage: start + 1,
      endPage: end,
    });
  }

  return { batches, totalPages };
}

module.exports = { splitPdfIntoBatches };