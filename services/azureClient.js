const DocumentIntelligence = require('@azure-rest/ai-document-intelligence').default;
const { getLongRunningPoller, isUnexpected } = require('@azure-rest/ai-document-intelligence');
const { AzureKeyCredential } = require('@azure/core-auth');

const endpoint = process.env.AZURE_DOC_INTEL_ENDPOINT.replace(/\/$/, '');
const key = process.env.AZURE_DOC_INTEL_KEY;
const API_VERSION = '2024-11-30';

// Max time to wait for an analyze operation to finish before giving up.
const POLL_TIMEOUT_MS = parseInt(process.env.AZURE_POLL_TIMEOUT_MS || '180000', 10); // 3 min default
const POLL_INTERVAL_MS = parseInt(process.env.AZURE_POLL_INTERVAL_MS || '1500', 10);

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
  const startTime = Date.now();

  while (true) {
    if (Date.now() - startTime > POLL_TIMEOUT_MS) {
      throw new Error(
        `Analyze operation timed out after ${POLL_TIMEOUT_MS}ms waiting on ${operationLocation}`
      );
    }

    const res = await fetch(operationLocation, {
      headers: { 'Ocp-Apim-Subscription-Key': key },
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Polling request failed (${res.status}): ${errBody}`);
    }

    const data = await res.json();

    if (data.status === 'succeeded') {
      return data.analyzeResult;
    }
    if (data.status === 'failed') {
      throw new Error(`Analysis failed: ${JSON.stringify(data)}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = { classifyDocument, analyzeWithModel };