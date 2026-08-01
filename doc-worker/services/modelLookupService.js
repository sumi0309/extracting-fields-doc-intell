// Looks up which fields to extract for a given model, from the
// document_models table — this replaces the old flow where the client had
// to type in requiredFields manually.

async function getModelFields(supabase, modelId) {
  const { data, error } = await supabase
    .from('document_models')
    .select('doc_type, model_id, query_fields')
    .eq('model_id', modelId)
    .single();

  if (error || !data) {
    console.warn(`No document_models row found for model_id "${modelId}", using empty field list.`);
    return { docType: null, queryFields: [] };
  }

  return { docType: data.doc_type, queryFields: data.query_fields || [] };
}

module.exports = { getModelFields };