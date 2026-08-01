// Model routing now lives in the document_models Supabase table, looked up
// via services/modelLookupService.js. This file just holds the one setting
// that isn't per-document: how many pages go in each processing batch.

module.exports = {
  PAGES_PER_BATCH: parseInt(process.env.PAGES_PER_BATCH || '2', 10),
};