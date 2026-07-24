const BACKEND_BASE = 'https://doc-intel-api-sumi-c5f3amf6bubedudf.southcentralus-01.azurewebsites.net/api/documents';

const POLL_INTERVAL_MS = 3000;

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

  output.innerHTML = 'Uploading...';

  try {
    const res = await fetch(`${BACKEND_BASE}/process`, { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      output.innerHTML = `<span class="error">Error: ${escapeHtml(data.error)}</span>`;
      return;
    }

    output.innerHTML = `Uploaded. Job ID: ${escapeHtml(data.jobId)}<br/>Waiting for the scan and processing to finish...`;
    pollStatus(data.jobId);
  } catch (err) {
    output.innerHTML = `<span class="error">Upload failed: ${escapeHtml(err.message)}</span>`;
  }
});

function pollStatus(jobId) {
  const output = document.getElementById('output');

  const intervalId = setInterval(async () => {
    try {
      const res = await fetch(`${BACKEND_BASE}/status/${jobId}`);
      const job = await res.json();

      if (!res.ok) {
        clearInterval(intervalId);
        output.innerHTML = `<span class="error">Error checking status: ${escapeHtml(job.error)}</span>`;
        return;
      }

      if (job.status === 'done') {
        clearInterval(intervalId);
        renderResults(job);
      } else if (job.status === 'failed') {
        clearInterval(intervalId);
        output.innerHTML = `<span class="error">Processing failed: ${escapeHtml(job.error || 'unknown error')}</span>`;
      } else {
        // uploaded | processing — keep waiting
        output.innerHTML = `Status: ${escapeHtml(job.status)}... (Job ID: ${escapeHtml(jobId)})`;
      }
    } catch (err) {
      clearInterval(intervalId);
      output.innerHTML = `<span class="error">Status check failed: ${escapeHtml(err.message)}</span>`;
    }
  }, POLL_INTERVAL_MS);
}

function renderResults(job) {
  const output = document.getElementById('output');

  const totalPages = job.total_pages ?? 0;
  const pagesProcessed = job.pages_processed ?? 0;
  const savedPages = Math.max(totalPages - pagesProcessed, 0);
  const savedPct = totalPages ? ((savedPages / totalPages) * 100).toFixed(1) : '0.0';
  const stoppedEarly = totalPages > 0 && pagesProcessed < totalPages;

  const requiredFields = job.required_fields || [];
  const extractedFields = job.extracted_fields || {};

  const html = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Pages Processed</div>
        <div class="stat-value">${pagesProcessed} / ${totalPages}</div>
        <div class="stat-sub">${savedPages} page(s) skipped (${savedPct}% saved)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Stopped Early</div>
        <div class="stat-value">${stoppedEarly ? 'Yes ✅' : 'No'}</div>
        <div class="stat-sub">${stoppedEarly ? 'Required fields found before the end' : 'Processed until end or ran out of pages'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Document Type</div>
        <div class="stat-value">${escapeHtml(job.doc_type || 'unknown')}</div>
        <div class="stat-sub">Model: ${escapeHtml(job.model_used || '-')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Status</div>
        <div class="stat-value">${escapeHtml(job.status)}</div>
        <div class="stat-sub">Job ID: ${escapeHtml(job.id)}</div>
      </div>
    </div>

    <h3>Required Fields Status</h3>
    <table class="fields-table">
      <thead>
        <tr><th>Field</th><th>Value Found</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${requiredFields
          .map((f) => {
            const val = extractedFields[f];
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
    <pre class="raw-json">${escapeHtml(JSON.stringify(extractedFields, null, 2))}</pre>
  `;

  output.innerHTML = html;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}