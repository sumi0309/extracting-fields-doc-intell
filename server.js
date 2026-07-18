require('dotenv').config();
const express = require('express');
const cors = require('cors');
const documentRoutes = require('./routes/documentRoutes');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/documents', documentRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));