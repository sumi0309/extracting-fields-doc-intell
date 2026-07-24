const { MODEL_ROUTES, FAILSAFE_MODEL } = require('../config/modelRouting');

function resolveModelFromClassification(classifyResult) {
  const docs = classifyResult?.documents || [];
  if (docs.length === 0) {
    console.log('Classifier returned no documents. Falling back to failsafe model.');
    return { modelId: FAILSAFE_MODEL, docType: 'unknown', confidence: 0 };
  }

  const best = docs.reduce((a, b) => ((a.confidence || 0) >= (b.confidence || 0) ? a : b));
  const docType = best.docType;
  const modelId = MODEL_ROUTES[docType] || FAILSAFE_MODEL;

  console.log(`Classifier detected docType: "${docType}" (confidence: ${best.confidence}) -> routed to model: "${modelId}"`);

  return { modelId, docType, confidence: best.confidence || 0 };
}

module.exports = { resolveModelFromClassification };