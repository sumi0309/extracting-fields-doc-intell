# Doc Intel Backend

A service that takes in a PDF, figures out what kind of document it is, and pulls out the specific fields you ask for — automatically, without a human reading the file.

## What it does

You upload a PDF (which may be encrypted) along with a list of field names you care about (e.g. `invoiceNumber`, `totalAmount`, `dueDate`). Behind the scenes:

1. The file lands in cloud storage, and you immediately get back a job ID — this is an async pipeline, not an instant request/response.
2. A background worker picks it up: unlocks the PDF if needed, breaks it into small page batches, and sends each batch to Azure AI Document Intelligence to figure out what *type* of document it is (invoice, receipt, ID, contract, etc.).
3. Each batch gets routed to the right specialized extraction model based on the detected type.
4. Fields get collected and checked off against your requested list.
5. **Processing stops early** as soon as everything you asked for has been found — it won't keep scanning a 50-page document if your answers were on page 2.
6. The result lands in a database. Your frontend polls for it and shows you the extracted fields once the job completes.

## Why it's built this way

- **Async, not synchronous** — processing can take anywhere from seconds to a couple of minutes depending on document size, so the upload request returns immediately with a job ID instead of holding the connection open.
- **Batching + early exit** keeps Document Intelligence costs and processing time down — you only pay for as much of the document as you actually need.
- **Classify-then-route** means the same pipeline can handle several different document types without hardcoding logic per type.
- **A fallback model** catches anything the classifier doesn't recognize, so the pipeline degrades gracefully instead of failing outright.
- **Event-driven, not polling** — the worker is triggered by the upload itself rather than checking "is there new work?" on a timer, which is both faster and cheaper.

## Where things stand

The full pipeline is live and cloud-deployed, end to end: upload → cloud storage → automatic trigger → decrypt → batch → classify → extract → early-stop → results saved → frontend shows them. Both the API and the background worker run in Azure; nothing needs to be running locally for it to work.

Security scanning of uploads (malware detection before processing) is designed into the architecture but not yet switched on — every upload is currently processed regardless of a scan verdict. Turning it on is a configuration change, not a code change.

See `ARCHITECTURE.md` for a full breakdown of every component, how they connect, and the file-by-file structure of the project.