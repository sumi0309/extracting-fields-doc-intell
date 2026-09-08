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

  // Last resort: if neither fields nor keyValuePairs produced anything (e.g.
  // a document with no clean key-value structure), fall back to the raw
  // extracted text so the result is never just an empty object. Tables get
  // included separately since flattened table cells rarely read well as text.
  if (Object.keys(output).length === 0) {
    if (analyzeResult?.content) {
      output.extractedText = analyzeResult.content.slice(0, 5000);
    }
    const tables = analyzeResult?.tables || [];
    if (tables.length > 0) {
      output.tables = tables.map((table) => {
        const grid = Array.from({ length: table.rowCount }, () => Array(table.columnCount).fill(''));
        (table.cells || []).forEach((cell) => {
          grid[cell.rowIndex][cell.columnIndex] = cell.content || '';
        });
        return grid;
      });
    }
  }

  return output;
}

function getFieldContent(fieldValue) {
  if (!fieldValue) return null;

  // Arrays: recurse into each item and return a plain array of simplified values.
  if (fieldValue.valueArray) {
    return fieldValue.valueArray.map((item) => getFieldContent(item));
  }

  // Objects: recurse into each nested field and return a plain object.
  if (fieldValue.valueObject) {
    const obj = {};
    Object.entries(fieldValue.valueObject).forEach(([k, v]) => {
      obj[k] = getFieldContent(v);
    });
    return obj;
  }

  return (
    fieldValue.content ??
    fieldValue.valueString ??
    fieldValue.valueNumber ??
    fieldValue.valueInteger ??
    fieldValue.valueDate ??
    fieldValue.valueTime ??
    fieldValue.valuePhoneNumber ??
    fieldValue.valueSelectionMark ??
    fieldValue.valueSignature ??
    fieldValue.valueCountryRegion ??
    fieldValue.valueBoolean ??
    (fieldValue.valueCurrency ? fieldValue.valueCurrency.amount : undefined) ??
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