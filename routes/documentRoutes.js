const express = require('express');
const multer = require('multer');
const router = express.Router();

const { splitPdfIntoBatches } = require('../services/pdfService');
const { classifyDocument, analyzeWithModel } = require('../services/azureClient');
const { resolveModelFromClassification } = require('../services/classificationService');
const { extractSimpleFields, allRequiredFieldsFound } = require('../services/extractionService');
const { decryptPdfBuffer } = require('../services/decryptService'); // import stays at top
const { PAGES_PER_BATCH, CLASSIFIER_ID } = require('../config/modelRouting');

const upload = multer({ storage: multer.memoryStorage() });

router.post('/process', upload.single('file'), async (req, res) => {
  try {
    const requiredFieldsRaw = req.body.requiredFields;
    if (!requiredFieldsRaw) {
      return res.status(400).json({ error: 'requiredFields is mandatory (array of field names).' });
    }
    const requiredFields = JSON.parse(requiredFieldsRaw);

    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    const cleanBuffer = decryptPdfBuffer(req.file.buffer);
    const { batches, totalPages } = await splitPdfIntoBatches(cleanBuffer, PAGES_PER_BATCH);

    let extractedFields = {};
    let docType = null;
    let modelUsed = null;
    let pagesProcessed = 0;
    let stoppedEarly = false;

    // --- Call/page tracking counters ---
    let classifyCallCount = 0;
    let analyzeCallCount = 0;
    let foundAtPage = null; // page number at which all required fields were satisfied

    

    for (const batch of batches) {
      const base64Source = batch.buffer.toString('base64');

      // Classify this batch of pages
      const classifyResult = await classifyDocument(CLASSIFIER_ID, base64Source);
      classifyCallCount += 1;
      console.log(
        `[Azure Call #${classifyCallCount + analyzeCallCount}] Classifier call on pages ${batch.startPage}-${batch.endPage}`
      );

      const { modelId, docType: detectedType, confidence } = resolveModelFromClassification(classifyResult);

      // Route to the matched prebuilt model (or failsafe)
          const analyzeResult = await analyzeWithModel(modelId, base64Source, requiredFields);
          console.log('RAW ANALYZE RESULT:', JSON.stringify(analyzeResult, null, 2));
      analyzeCallCount += 1;
      console.log(
        `[Azure Call #${classifyCallCount + analyzeCallCount}] Analyze call (${modelId}) on pages ${batch.startPage}-${batch.endPage}`
      );

      const batchFields = extractSimpleFields(analyzeResult);

      extractedFields = { ...extractedFields, ...batchFields };
      docType = detectedType;
      modelUsed = modelId;
      pagesProcessed = batch.endPage;

      console.log(
        `Processed pages ${batch.startPage}-${batch.endPage} | type=${detectedType} (${confidence}) | model=${modelId}`
      );
      console.log('Fields found so far:', extractedFields);

      if (allRequiredFieldsFound(extractedFields, requiredFields)) {
        foundAtPage = pagesProcessed;
        stoppedEarly = pagesProcessed < totalPages;
        break;
      }
    }

    const totalAzureCalls = classifyCallCount + analyzeCallCount;

    // --- Final summary print to console ---
    console.log('----- Processing Summary -----');
    console.log(`Total Azure calls made: ${totalAzureCalls} (classify: ${classifyCallCount}, analyze: ${analyzeCallCount})`);
    console.log(`Total pages in document: ${totalPages}`);
    console.log(`Pages actually processed: ${pagesProcessed}`);
    if (foundAtPage) {
      console.log(`All required fields found after processing ${foundAtPage} page(s).`);
    } else {
      console.log(`Required fields NOT fully found after processing all ${pagesProcessed} page(s) sent.`);
    }
    console.log('-------------------------------');

    return res.json({
      success: true,
      totalPages,
      pagesProcessed,
      stoppedEarly,
      docType,
      modelUsed,
      requiredFields,
      extractedFields,
      allRequiredFound: allRequiredFieldsFound(extractedFields, requiredFields),
      azureCallStats: {
        classifyCalls: classifyCallCount,
        analyzeCalls: analyzeCallCount,
        totalCalls: totalAzureCalls,
        foundAtPage,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;