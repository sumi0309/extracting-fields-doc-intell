if (!global.WebSocket) {
  global.WebSocket = require('ws');
}

const { webcrypto } = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { createClient } = require('@supabase/supabase-js');

const { decryptPdfBuffer } = require('../../services/decryptService');
const { splitPdfIntoBatches } = require('../../services/pdfService');
const { analyzeWithModel } = require('../../services/azureClient');
const { classifyWithGemini } = require('../../services/geminiClassifier');
const { getModelFields } = require('../../services/modelLookupService');
const { extractSimpleFields, allRequiredFieldsFound } = require('../../services/extractionService');
const { PAGES_PER_BATCH } = require('../../config/modelRouting');

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

      if (batches.length === 0) {
        throw new Error('PDF produced no pages to process.');
      }

      // --- Classify once, using the first batch, then reuse for the whole document ---
      const firstBatchBase64 = batches[0].buffer.toString('base64');
      const { modelId, docType: classifierDocType } = await classifyWithGemini(supabase, firstBatchBase64);
      context.log(`Gemini classified document as "${classifierDocType}" -> model "${modelId}"`);

      const { docType, queryFields } = await getModelFields(supabase, modelId);
      const resolvedDocType = docType || classifierDocType;

      context.log(`Extracting fields for "${resolvedDocType}": ${JSON.stringify(queryFields)}`);

      // Update the job now, before extraction finishes, so the UI can show
      // "here's what we're pulling out of this document" while it works.
      await supabase
        .from('jobs')
        .update({
          doc_type: resolvedDocType,
          model_used: modelId,
          required_fields: queryFields,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      // --- Extraction loop, same shape as before, just DB-sourced fields ---
      let extractedFields = {};
      let pagesProcessed = 0;

      for (const batch of batches) {
        const base64Source = batch.buffer.toString('base64');
        const analyzeResult = await analyzeWithModel(modelId, base64Source, queryFields);
        const batchFields = extractSimpleFields(analyzeResult);

        extractedFields = { ...extractedFields, ...batchFields };
        pagesProcessed = batch.endPage;

        context.log(`Processed pages ${batch.startPage}-${batch.endPage} | model=${modelId}`);

        if (allRequiredFieldsFound(extractedFields, queryFields)) break;
      }

      await supabase
        .from('jobs')
        .update({
          status: 'done',
          extracted_fields: extractedFields,
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