const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { createClient } = require('@supabase/supabase-js');

const { decryptPdfBuffer } = require('../../services/decryptService');
const { splitPdfIntoBatches } = require('../../services/pdfService');
const { classifyDocument, analyzeWithModel } = require('../../services/azureClient');
const { resolveModelFromClassification } = require('../../services/classificationService');
const { extractSimpleFields, allRequiredFieldsFound } = require('../../services/extractionService');
const { PAGES_PER_BATCH, CLASSIFIER_ID } = require('../../config/modelRouting');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING
);

app.storageQueue('processUpload', {
  queueName: 'clean-file-jobs',
  connection: 'AzureWebJobsStorage',
  handler: async (queueItem, context) => {
    if (queueItem.eventType !== 'Microsoft.Storage.BlobCreated') {
      context.log(`Ignoring event type: ${queueItem.eventType}`);
      return;
    }

    // subject looks like: /blobServices/default/containers/documents-incoming/blobs/<blobname>
    const subject = decodeURIComponent(queueItem.subject);
    const match = subject.match(/containers\/([^/]+)\/blobs\/(.+)/);
    if (!match) {
      context.error(`Could not parse container/blob from subject: ${subject}`);
      return;
    }
    const [, containerName, blobName] = match;
    const blobPath = `${containerName}/${blobName}`;

    context.log(`Blob created: ${blobPath}`);

    const { data: jobRow, error: findError } = await supabase
      .from('jobs')
      .select('*')
      .eq('blob_path', blobPath)
      .single();

    if (findError || !jobRow) {
      // Expected for anything uploaded outside your API (e.g. manual portal
      // uploads during testing) — there's no job record to attach results to.
      context.warn(`No job found for blob_path "${blobPath}". Skipping.`);
      return;
    }

    const jobId = jobRow.id;

    try {
      await supabase.from('jobs').update({ status: 'processing' }).eq('id', jobId);

      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);
      const downloadBuffer = await blobClient.downloadToBuffer();

      const cleanBuffer = decryptPdfBuffer(downloadBuffer);
      const { batches, totalPages } = await splitPdfIntoBatches(cleanBuffer, PAGES_PER_BATCH);

      const requiredFields = jobRow.required_fields;
      let extractedFields = {};
      let docType = null;
      let modelUsed = null;
      let pagesProcessed = 0;

      for (const batch of batches) {
        const base64Source = batch.buffer.toString('base64');

        const classifyResult = await classifyDocument(CLASSIFIER_ID, base64Source);
        const { modelId, docType: detectedType } = resolveModelFromClassification(classifyResult);
        const analyzeResult = await analyzeWithModel(modelId, base64Source, requiredFields);
        const batchFields = extractSimpleFields(analyzeResult);

        extractedFields = { ...extractedFields, ...batchFields };
        docType = detectedType;
        modelUsed = modelId;
        pagesProcessed = batch.endPage;

        context.log(`Processed pages ${batch.startPage}-${batch.endPage} | model=${modelId}`);

        if (allRequiredFieldsFound(extractedFields, requiredFields)) break;
      }

      await supabase
        .from('jobs')
        .update({
          status: 'done',
          extracted_fields: extractedFields,
          doc_type: docType,
          model_used: modelUsed,
          total_pages: totalPages,
          pages_processed: pagesProcessed,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      context.log(`Job ${jobId} completed successfully.`);
    } catch (err) {
      context.error(`Job ${jobId} failed:`, err);

      await supabase
        .from('jobs')
        .update({
          status: 'failed',
          error: err.message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      // Rethrow so the Functions runtime's built-in retry/poison-queue
      // behavior applies instead of silently swallowing the failure.
      throw err;
    }
  },
});