# Doc Intel Backend

A Node.js/Express service that takes in a PDF, figures out what kind of document it is, and pulls out the specific fields you ask for — automatically, without a human reading the file.

## What it does

You upload a PDF (which may be password-protected) along with a list of field names you care about (e.g. `invoiceNumber`, `totalAmount`, `dueDate`). The service:

1. Unlocks the PDF if it's encrypted.
2. Breaks it into small page batches instead of processing the whole thing at once.
3. Sends each batch to Azure AI Document Intelligence to figure out what *type* of document it is (invoice, receipt, ID, contract, etc.).
4. Routes that batch to the right specialized extraction model based on the detected type.
5. Collects the fields it finds and checks them off against your requested list.
6. **Stops early** as soon as everything you asked for has been found — it won't keep scanning a 50-page document if your answers were on page 2.

The result is a JSON response with the extracted fields, the detected document type, and some stats on how much work was actually done to get there.

## Why it's built this way

- **Batching + early exit** keeps costs and processing time down — you only pay for as much of the document as you actually need.
- **Classify-then-route** means the same pipeline can handle several different document types without hardcoding logic per type.
- **A fallback model** catches anything the classifier doesn't recognize, so the pipeline degrades gracefully instead of failing outright.

## Where things stand

The core pipeline is working end-to-end: upload → decrypt → batch → classify → extract → early-stop → respond. Recent work has focused on making it more robust (safe handling of temporary files, not hanging forever if a call to Azure stalls, and reading more of the data types Azure can return). Frontend and further hardening are still in progress.