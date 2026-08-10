'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');

const app = express();
app.use(express.json());
app.use(healthRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`orders on ${port}`));
