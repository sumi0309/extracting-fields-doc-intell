// Flattens Azure's "documents[].fields" object into simple key:value pairs
// and checks whether all required fields have been found.

function extractSimpleFields(analyzeResult) {
  const output = {};

  const documents = analyzeResult?.documents || [];
  documents.forEach((doc) => {
    const fields = doc.fields || {};
    Object.entries(fields).forEach(([fieldName, fieldValue]) => {
      output[fieldName] = getFieldContent(fieldValue);
    });
  });

  // Fallback: general document model returns keyValuePairs instead of fields
  const kvPairs = analyzeResult?.keyValuePairs || [];
  kvPairs.forEach((pair) => {
    const key = pair.key?.content;
    const value = pair.value?.content;
    if (key) output[key.trim()] = value ? value.trim() : null;
  });

  return output;
}

function getFieldContent(fieldValue) {
  if (!fieldValue) return null;
  return (
    fieldValue.content ??
    fieldValue.valueString ??
    fieldValue.valueNumber ??
    fieldValue.valueDate ??
    fieldValue.valuePhoneNumber ??
    null
  );
}

function allRequiredFieldsFound(extractedFields, requiredFields) {
  if (!requiredFields || requiredFields.length === 0) return false;
  return requiredFields.every(
    (rf) => extractedFields[rf] !== undefined && extractedFields[rf] !== null && extractedFields[rf] !== ''
  );
}

module.exports = { extractSimpleFields, allRequiredFieldsFound };