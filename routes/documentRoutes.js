const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();

const { uploadBuffer } = require('../services/blobService');
const { supabase } = require('../services/supabaseClient');

const upload = multer({ storage: multer.memoryStorage() });
const CONTAINER_NAME = 'documents-incoming';

router.post('/process', upload.single('file'), async (req, res) => {
  try {
    const requiredFieldsRaw = req.body.requiredFields;
    if (!requiredFieldsRaw) {
      return res.status(400).json({ error: 'requiredFields is mandatory (array of field names).' });
    }
    const requiredFields = JSON.parse(requiredFieldsRaw);

    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    const blobName = `${crypto.randomUUID()}.pdf`;
    const blobPath = `${CONTAINER_NAME}/${blobName}`;

    // Create the job row BEFORE uploading the blob, so it already exists
    // by the time the blob-created event fires and the worker looks it up.
    const { data: jobRow, error: insertError } = await supabase
      .from('jobs')
      .insert({
        status: 'uploaded',
        blob_path: blobPath,
        required_fields: requiredFields,
      })
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ error: `Failed to create job record: ${insertError.message}` });
    }

    await uploadBuffer(CONTAINER_NAME, blobName, req.file.buffer);

    return res.json({ success: true, jobId: jobRow.id, status: 'uploaded' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

router.get('/status/:jobId', async (req, res) => {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', req.params.jobId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return res.json(data);
});

module.exports = router;