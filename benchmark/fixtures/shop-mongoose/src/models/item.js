'use strict';
const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  sku:         { type: String, required: true, unique: true },
  title:       { type: String, required: true },
  notes:       { type: String },
  price:       { type: Number, required: true, min: 0 },
  stock:       { type: Number, required: true, min: 0 },
  condition:   { type: String, required: true, enum: ['NEW', 'USED', 'REFURBISHED'] },
  listed:      { type: Boolean, default: true },
  seller:      { type: mongoose.Schema.Types.ObjectId, ref: 'Seller' },
  createdAt:   { type: Date, default: Date.now },
});

module.exports = mongoose.models.Item || mongoose.model('Item', itemSchema);
