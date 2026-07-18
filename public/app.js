const BACKEND_URL = 'http://localhost:5000/api/documents/process';

document.getElementById('submitBtn').addEventListener('click', async () => {
  const output = document.getElementById('output');
  const fieldsRaw = document.getElementById('fieldsInput').value.trim();
  const fileInput = document.getElementById('fileInput');

  if (!fieldsRaw) {
    output.innerHTML = 'Please enter at least one required field.';
    return;
  }
  if (!fileInput.files.length) {
    output.innerHTML = 'Please select a PDF file.';
    return;
  }

  const requiredFields = fieldsRaw.split(',').map((f) => f.trim()).filter(Boolean);

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('requiredFields', JSON.stringify(requiredFields));

  output.innerHTML = 'Processing... this may take a moment.';

  try {
    const res = await fetch(BACKEND_URL, { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      output.innerHTML = `<span class="error">Error: ${escapeHtml(data.error)}</span>`;
      return;
    }

    renderResults(data);
  } catch (err) {
    output.innerHTML = `<span class="error">Request failed: ${escapeHtml(err.message)}</span>`;
  }
});

function renderResults(data) {
  const output = document.getElementById('output');
  const stats = data.azureCallStats || {};

  const savedPages = Math.max(data.totalPages - data.pagesProcessed, 0);
  const savedPct = data.totalPages
    ? ((savedPages / data.totalPages) * 100).toFixed(1)
    : '0.0';

  const html = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Azure Calls</div>
        <div class="stat-value">${stats.totalCalls ?? '-'}</div>
        <div class="stat-sub">${stats.classifyCalls ?? 0} classify + ${stats.analyzeCalls ?? 0} analyze</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pages Processed</div>
        <div class="stat-value">${data.pagesProcessed} / ${data.totalPages}</div>
        <div class="stat-sub">${savedPages} page(s) skipped (${savedPct}% saved)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Found At Page</div>
        <div class="stat-value">${stats.foundAtPage ?? 'N/A'}</div>
        <div class="stat-sub">${data.stoppedEarly ? 'Stopped early ✅' : 'Processed until end'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Document Type</div>
        <div class="stat-value">${escapeHtml(data.docType || 'unknown')}</div>
        <div class="stat-sub">Model: ${escapeHtml(data.modelUsed || '-')}</div>
      </div>
    </div>

    <h3>Required Fields Status</h3>
    <table class="fields-table">
      <thead>
        <tr><th>Field</th><th>Value Found</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${data.requiredFields
          .map((f) => {
            const val = data.extractedFields[f];
            const found = val !== undefined && val !== null && val !== '';
            return `<tr>
              <td>${escapeHtml(f)}</td>
              <td>${found ? escapeHtml(String(val)) : '-'}</td>
              <td class="${found ? 'ok' : 'missing'}">${found ? 'Found' : 'Missing'}</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>

    <h3>All Extracted Fields</h3>
    <pre class="raw-json">${escapeHtml(JSON.stringify(data.extractedFields, null, 2))}</pre>
  `;

  output.innerHTML = html;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}