if (!global.WebSocket) {
  global.WebSocket = require('ws');
}

const { webcrypto } = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

if (!global.WebSocket) {
  global.WebSocket = require('ws');
}

const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { createClient } = require('@supabase/supabase-js');

const { decryptPdfBuffer } = require('../../services/decryptService');
const { splitPdfIntoBatches } = require('../../services/pdfService');
const { classifyDocument, analyzeWithModel } = require('../../services/azureClient');
const { resolveModelFromClassification } = require('../../services/classificationService');
const { extractSimpleFields, allRequiredFieldsFound } = require('../../services/extractionService');
const { PAGES_PER_BATCH, CLASSIFIER_ID } = require('../../config/modelRouting');

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _supabase;
}

let _blobServiceClient = null;
function getBlobServiceClient() {
  if (_blobServiceClient) return _blobServiceClient;
  _blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
  return _blobServiceClient;
}

app.storageQueue('processUpload', {
  queueName: 'clean-file-jobs',
  connection: 'AzureWebJobsStorage',
  handler: async (queueItem, context) => {
    const supabase = getSupabase();
    const blobServiceClient = getBlobServiceClient();

    if (queueItem.eventType !== 'Microsoft.Storage.BlobCreated') {
      context.log(`Ignoring event type: ${queueItem.eventType}`);
      return;
    }

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

      throw err;
    }
  },
});