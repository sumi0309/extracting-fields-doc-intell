const DocumentIntelligence = require('@azure-rest/ai-document-intelligence').default;
const { getLongRunningPoller, isUnexpected } = require('@azure-rest/ai-document-intelligence');
const { AzureKeyCredential } = require('@azure/core-auth');

const endpoint = process.env.AZURE_DOC_INTEL_ENDPOINT.replace(/\/$/, '');
const key = process.env.AZURE_DOC_INTEL_KEY;
const API_VERSION = '2024-11-30';

const client = DocumentIntelligence(process.env.AZURE_DOC_INTEL_ENDPOINT, new AzureKeyCredential(key), {
  apiVersion: API_VERSION,
});

async function classifyDocument(classifierId, base64Source) {
  const initialResponse = await client
    .path('/documentClassifiers/{classifierId}:analyze', classifierId)
    .post({ contentType: 'application/json', body: { base64Source } });

  if (isUnexpected(initialResponse)) {
    throw new Error(`Classification failed: ${JSON.stringify(initialResponse.body)}`);
  }
  const poller = getLongRunningPoller(client, initialResponse);
  const result = await poller.pollUntilDone();
  return result.body.analyzeResult;
}

// Raw fetch-based analyze call, bypassing the SDK so custom preview
// params like "features" and "queryFields" actually reach Azure.
async function analyzeWithModel(modelId, base64Source, queryFields = []) {
    console.log('>>> USING RAW FETCH VERSION, queryFields:', queryFields);

  const useQueryFields = queryFields.length > 0;

  let url = `${endpoint}/documentintelligence/documentModels/${modelId}:analyze?api-version=${API_VERSION}`;
  if (useQueryFields) {
    url += `&features=queryFields&queryFields=${encodeURIComponent(queryFields.join(','))}`;
  }

  const submitRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ base64Source }),
  });

  if (!submitRes.ok) {
    const errBody = await submitRes.text();
    throw new Error(`Analysis submit failed: ${errBody}`);
  }

  const operationLocation = submitRes.headers.get('operation-location');
  if (!operationLocation) {
    throw new Error('No Operation-Location header returned from analyze call.');
  }

  return pollAnalyzeResult(operationLocation);
}

async function pollAnalyzeResult(operationLocation) {
  while (true) {
    const res = await fetch(operationLocation, {
      headers: { 'Ocp-Apim-Subscription-Key': key },
    });
    const data = await res.json();

    if (data.status === 'succeeded') {
      return data.analyzeResult;
    }
    if (data.status === 'failed') {
      throw new Error(`Analysis failed: ${JSON.stringify(data)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

module.exports = { classifyDocument, analyzeWithModel };