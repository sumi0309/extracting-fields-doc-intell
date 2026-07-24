# Architecture

This document explains every moving part of the project, how they connect, and why each piece exists. It's written for someone who has never seen this codebase before.

## 1. The big picture

The system takes an uploaded PDF, figures out what type of document it is, extracts specific fields from it, and reports the result — but it does this **asynchronously**, using cloud infrastructure to handle the security scanning and processing rather than doing everything inside a single web request.

There are three deployable pieces:

| Piece | What it is | Where it runs |
|---|---|---|
| **API** | Express app — accepts uploads, reports job status | Azure App Service |
| **Worker** | Background processor — does the actual PDF/AI work | Azure Function App (custom Docker container) |
| **Database** | Job records and results | Supabase (hosted Postgres) |

They never call each other directly. They're connected entirely through **Azure Blob Storage** and an **Azure Storage Queue** — the API drops a file in storage, an event fires, a message lands on a queue, and the worker picks it up whenever it's ready. This means the API can return instantly instead of making the user wait for processing to finish.

## 2. Full request lifecycle, step by step

1. **User submits a PDF + required fields** through the frontend (`public/index.html` / `public/app.js`).
2. **API (`routes/documentRoutes.js`, `POST /process`)**:
   - Creates a row in Supabase's `jobs` table with `status: 'uploaded'` and the list of required fields.
   - Uploads the raw PDF bytes to Blob Storage, into the `documents-incoming` container, under a random UUID filename.
   - Immediately responds to the browser with `{ jobId, status: 'uploaded' }`. This request is finished — nothing further happens on this HTTP connection.
3. **Blob Storage** now holds the file. Because a blob was created, it automatically emits a `Microsoft.Storage.BlobCreated` event.
4. **Event Grid** is subscribed to that event on this storage account. It forwards the event as a message onto the Storage Queue (`clean-file-jobs`). *(Note: this step is meant to sit behind a malware-scan gate — see Section 6.)*
5. **The Worker (`doc-worker/`)** — an Azure Function running inside a Docker container — has a queue-triggered function (`processUpload.js`) that wakes up the moment a message appears:
   - Parses the blob's container/filename out of the event.
   - Looks up the matching row in Supabase by `blob_path` (this is how the worker knows *which* job this blob belongs to — the event itself carries no job ID).
   - Downloads the actual PDF bytes from Blob Storage.
   - Decrypts it if needed (`services/decryptService.js`, using the `qpdf` CLI).
   - Splits it into small batches of pages (`services/pdfService.js`, using `pdf-lib`).
   - For each batch, in order:
     - Classifies the document type using a custom Azure Document Intelligence classifier (`services/azureClient.js` → `classifyDocument`).
     - Maps that classification to a specific extraction model (`services/classificationService.js`, config in `config/modelRouting.js`).
     - Runs the extraction model against the batch (`services/azureClient.js` → `analyzeWithModel`).
     - Flattens Azure's response into simple `{fieldName: value}` pairs (`services/extractionService.js`).
     - **Stops early** if every required field has been found — no need to process remaining pages.
   - Writes the final result back to the same Supabase row: `status: 'done'`, extracted fields, doc type, page counts.
6. **The frontend**, which has been polling `GET /status/:jobId` every few seconds since step 2, sees `status: 'done'` and renders the results table.

## 3. Component-by-component reference

### API (Express app — repo root)

| File | Purpose |
|---|---|
| `server.js` | Entry point. Sets up Express, CORS, static file serving for the frontend, mounts routes. |
| `routes/documentRoutes.js` | `POST /process` (upload) and `GET /status/:jobId` (poll). This is the *only* thing the API does now — no PDF processing happens here. |
| `services/blobService.js` | Uploads a buffer to Blob Storage. |
| `services/supabaseClient.js` | Shared Supabase client, used to create/read job rows. |
| `public/index.html`, `public/app.js` | Frontend — file upload form, required-fields input, polling loop, results table. Served directly by the API via `express.static('public')`. |

The API's `services/` folder now contains exactly these two files. All the PDF/classification/extraction logic that used to live here before the async rewrite has been removed — that code now lives only in `doc-worker/`, which is where it actually runs.

### Worker (`doc-worker/` — separate deployable)

| File | Purpose |
|---|---|
| `src/functions/processUpload.js` | The queue-triggered function. Parses the blob-created event, finds the job in Supabase, runs the whole pipeline, writes the result. Contains two polyfills at the top of the file — see Section 5. |
| `services/decryptService.js` | Strips PDF encryption via the `qpdf` CLI. Treats qpdf's "succeeded with warnings" exit code (3) as success, not failure. |
| `services/pdfService.js` | Splits a PDF into N-page batches using `pdf-lib`. |
| `services/azureClient.js` | Talks to Azure AI Document Intelligence — one function for classification, one for field extraction. Reads its endpoint/key lazily (inside functions, not at module load) so a missing env var can't crash function discovery. |
| `services/classificationService.js` | Maps a classifier result to a specific extraction model ID, with a fallback. |
| `services/extractionService.js` | Flattens Azure's nested field response into a simple object; also handles the "have all required fields been found yet?" check. |
| `config/modelRouting.js` | Static lookup table: document type → Azure model ID, plus the fallback model and batch size, pulled from env vars. |
| `Dockerfile` | Builds the container this Function App actually runs. Installs `qpdf` via `apt-get` (not available on a plain, non-container Function App) and copies the code in. |

### Database (Supabase)

One table, `jobs`:

```sql
create table jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'uploaded',       -- uploaded | processing | done | failed
  blob_path text not null,
  required_fields jsonb not null,
  extracted_fields jsonb,
  doc_type text,
  model_used text,
  total_pages int,
  pages_processed int,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Both the API and the worker talk to this table using the Supabase **service role key**, which bypasses row-level security — appropriate here since both are trusted backend services, not user-facing clients.

## 4. Azure resources involved

| Resource | Purpose |
|---|---|
| **Storage Account** | Hosts the `documents-incoming` blob container and the `clean-file-jobs` queue. |
| **Event Grid System Topic** (on the storage account) | Watches for blob-created events and routes them to the queue. |
| **Container Registry (ACR)** | Hosts the worker's Docker image. |
| **Function App (Premium/container plan)** | Runs the worker's Docker image. Required because Consumption-plan Function Apps can't run custom containers, and this worker needs `qpdf` installed at the OS level. |
| **App Service** | Runs the Express API + serves the frontend. Deployed via GitHub Actions (Deployment Center, Basic Authentication). |
| **Document Intelligence resource** | The actual AI service doing classification and field extraction. |

## 5. Non-obvious things worth knowing (lessons learned the hard way)

These aren't obvious from reading the code once — they were each the cause of a real deployment failure during development, and are worth understanding if you're modifying the worker.

- **Environment variables must be read lazily, not at module load time.** Early versions read things like `process.env.AZURE_DOC_INTEL_ENDPOINT` directly in top-level `const` statements. If that variable isn't yet populated in the process's environment at the exact moment the Functions host indexes the file (which can happen before all settings are fully wired up in a custom container), the whole file throws on `require()` and the function silently fails to register — with no function shown in the Azure Portal and no obvious error. All env-dependent client/config setup in the worker is now wrapped in functions that only run when actually invoked.
- **Node 18 (the runtime this container uses) doesn't have `globalThis.crypto` or a native `WebSocket` by default.** `@supabase/supabase-js` and `@azure/storage-blob` both expect these to exist globally. Both are polyfilled explicitly at the top of `processUpload.js`:
  ```javascript
  const { webcrypto } = require('crypto');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  if (!global.WebSocket) global.WebSocket = require('ws');
  ```
- **qpdf's exit code 3 means "succeeded, but I had to fix something minor"** — not failure. Node's `execSync` throws on any non-zero exit code by default, so this needs to be checked explicitly (see `decryptService.js`) or every slightly-imperfect real-world PDF gets rejected even though qpdf actually handled it fine.
- **The worker discovers functions via `package.json`'s `"main"` field.** A glob pattern (`"src/functions/*.js"`) proved unreliable for function discovery in this custom-container setup; pointing directly at the file (`"src/functions/processUpload.js"`) is what actually works.
- **`FUNCTIONS_WORKER_RUNTIME=node` must be set explicitly** on a custom-container Function App — it's not inferred automatically the way it is on non-container Function Apps. Without it, the host runs but never initializes the Node worker process, so it finds zero functions.

## 6. What's designed in but not yet turned on

**Malware scanning.** The architecture assumes uploaded files get scanned by Microsoft Defender for Storage before the worker ever touches them — that's *why* the pipeline is event-driven through Blob Storage + Event Grid instead of a direct call. Right now, Event Grid is configured to forward on `BlobCreated` (any upload) rather than on a scan-result event, so every upload gets processed regardless of a security scan. Turning scanning on is purely a configuration change:
1. Enable Defender for Storage's Malware Scanning add-on on the storage account.
2. Change the Event Grid subscription's event type from `Blob Created` to `Microsoft.Security.MalwareScanningResult`, with an advanced filter on `data.scanResultType` = `"No threats found"`.

No code changes are required in either the API or the worker for this.

**Infected file handling.** Currently, if a scan verdict came back "malicious," that file would simply never generate a queue message (per the filter above) — it wouldn't be actively deleted or flagged, just left in storage until a lifecycle policy eventually cleans it up. Explicit handling (e.g. deleting it immediately and marking the job `failed`) is a reasonable next addition but isn't built yet.

## 7. Remaining known items

- Two Function Apps may exist from the development process — an early Consumption-plan one (which can't run `qpdf` and was superseded) and the current container-based one. Confirm only the container-based one is running to avoid duplicate queue consumers.
- No AKS deployment exists yet; the worker runs as a standalone Azure Function App container rather than in a Kubernetes cluster. This was deliberately deferred during development.