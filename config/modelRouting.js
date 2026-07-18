// Maps a classifier's output "docType" label to an Azure prebuilt model ID.

module.exports = {
  MODEL_ROUTES: {
    invoice: 'prebuilt-invoice',
    receipt: 'prebuilt-receipt',
    idDocument: 'prebuilt-idDocument',
    businessCard: 'prebuilt-businessCard',
    taxForm: 'prebuilt-tax.us.w2',
    contract: 'prebuilt-contract',
  },
  FAILSAFE_MODEL: 'prebuilt-layout', 
  CLASSIFIER_ID: process.env.AZURE_CLASSIFIER_ID,
  PAGES_PER_BATCH: parseInt(process.env.PAGES_PER_BATCH || '2', 10),
};