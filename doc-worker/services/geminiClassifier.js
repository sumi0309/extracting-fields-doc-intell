// Classifies a document using Gemini instead of Azure's custom classifier.
// The model list (doc_type -> model_id) is pulled from Supabase's
// document_models table so it stays in sync with a single source of truth —
// add a new row there and Gemini will start considering it automatically,
// no code change needed.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// Short descriptions to help Gemini distinguish visually/structurally similar
// document types. Keyed by the doc_type string stored in Supabase — must
// match exactly.
const DOC_TYPE_DESCRIPTIONS = {
  'bank check': 'A bank check (personal or business), showing a check number, payee, amount, date, and the issuing bank name.',
  'bank statement': 'A periodic bank account statement showing an account balance, statement date/month, account holder details, and transaction history.',
  paystub: "An employee pay stub / payslip showing a pay period, employee name, amount paid, and employer/company name.",
  contract: 'A legal contract or agreement between two or more parties, with a title, effective/expiration dates, and jurisdiction.',
  'health insurance card': "A health insurance member ID card showing the member's name, insurance company, plan name, and expiry date.",
  'id document': 'A government-issued identity document — driver license, passport, or national ID card — with a person\'s name, ID number, and issuing state/country.',
  invoice: 'A commercial invoice billing a customer for goods or services, showing an amount due, invoice date, tax amount, and the billing company name.',
  receipt: 'A purchase receipt from a retailer or vendor, showing a receipt number, date, amount due, and tax amount.',
  'tax form w2': "A U.S. IRS Form W-2 Wage and Tax Statement, showing an employee's wages, withheld taxes, and employer information.",
  'credit card': 'A physical credit or debit card image showing a card number, cardholder name, issuing bank, and expiry date.',
};

let _cachedModelList = null;
async function getModelList(supabase) {
  if (_cachedModelList) return _cachedModelList;

  const { data, error } = await supabase
    .from('document_models')
    .select('doc_type, model_id, is_fallback');

  if (error) throw new Error(`Failed to load document_models: ${error.message}`);

  const known = data.filter((r) => !r.is_fallback);
  const fallback = data.find((r) => r.is_fallback);

  if (!fallback) throw new Error('No fallback row found in document_models (is_fallback = true).');

  _cachedModelList = { known, fallback };
  return _cachedModelList;
}

function buildPrompt(known, fallback) {
  const lines = known.map((row) => {
    const desc = DOC_TYPE_DESCRIPTIONS[row.doc_type] || row.doc_type;
    return `- "${row.doc_type}" (model_id: "${row.model_id}"): ${desc}`;
  });

  return `You are a document classification assistant. You will be shown a PDF document. Your job is to decide which single category it belongs to, from the list below, and return the exact model_id string for that category.

Categories:
${lines.join('\n')}

Rules:
- Return exactly one model_id from the list above, copied character-for-character — never invent, abbreviate, or modify a model_id.
- Base your decision on the document's actual structure and content (layout, labeled fields, typical wording), not just the filename or incidental text.
- If the document does not clearly and confidently match any category above, return "${fallback.model_id}" instead of guessing.
- Respond with only the structured JSON output — no explanation, no extra text.`;
}

async function classifyWithGemini(supabase, base64Pdf) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const { known, fallback } = await getModelList(supabase);
  const allowedModelIds = [...known.map((r) => r.model_id), fallback.model_id];

  const systemPrompt = buildPrompt(known, fallback);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'application/pdf', data: base64Pdf } },
          { text: 'Classify this document and return its model_id.' },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          model_id: { type: 'STRING', enum: allowedModelIds },
        },
        required: ['model_id'],
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini classification request failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textOut) {
    throw new Error(`Gemini returned no usable output: ${JSON.stringify(data)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(textOut);
  } catch (err) {
    throw new Error(`Gemini output was not valid JSON: ${textOut}`);
  }

  const modelId = parsed.model_id;
  if (!allowedModelIds.includes(modelId)) {
    // Defensive fallback — shouldn't happen given the enum constraint, but
    // don't let a malformed response propagate an unknown model_id downstream.
    console.warn(`Gemini returned an unrecognized model_id "${modelId}", falling back.`);
    return { modelId: fallback.model_id, docType: fallback.doc_type };
  }

  const matched = known.find((r) => r.model_id === modelId);
  const docType = matched ? matched.doc_type : fallback.doc_type;

  return { modelId, docType };
}

module.exports = { classifyWithGemini };