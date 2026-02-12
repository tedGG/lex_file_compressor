const express = require("express");
require("dotenv").config();

const { createCanvas } = require("canvas");
const { PDFDocument } = require("pdf-lib");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const app = express();
app.use(express.json({ limit: "100mb" }));
const port = process.env.PORT || 4000;

const salesforce = require("./salesforce");

// Health check
app.get("/wakeup", (req, res) => {
  res.send("PDF Compression API is running");
});

// PDF Compression endpoint
app.post("/compress", async (req, res) => {
  const { basicurl, contverid, quality = 50, scaleFactor = 100 } = req.body;

  if (!basicurl || !contverid) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: basicurl, contverid"
    });
  }

  try {
    console.log(`Compressing PDF — ContentVersion: ${contverid}, quality: ${quality}%, scale: ${scaleFactor}%`);

    // Fetch PDF from Salesforce
    const pdfBuffer = await salesforce.getFile(basicurl, contverid);
    const originalSize = pdfBuffer.byteLength;
    console.log(`Original size: ${(originalSize / 1024).toFixed(1)} KB`);

    // Compress
    const compressedBytes = await compressPdf(
      new Uint8Array(pdfBuffer),
      quality / 100,
      scaleFactor / 100
    );
    const compressedSize = compressedBytes.length;
    const reductionPercent = ((1 - compressedSize / originalSize) * 100).toFixed(1);

    console.log(`Compressed: ${(compressedSize / 1024).toFixed(1)} KB (${reductionPercent}% reduction)`);

    // Convert to base64
    const base64Data = Buffer.from(compressedBytes).toString("base64");

    res.json({
      success: true,
      originalSize,
      compressedSize,
      reductionPercent: parseFloat(reductionPercent),
      base64Data
    });
  } catch (err) {
    console.error("Compression error:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Core compression: rasterize each page to JPEG, rebuild PDF
async function compressPdf(pdfBytes, quality, scale) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes, useSystemFonts: true });
  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;
  console.log(`Processing ${numPages} page(s)`);

  const newPdf = await PDFDocument.create();

  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const originalViewport = page.getViewport({ scale: 1.0 });
    const viewport = page.getViewport({ scale });

    // Render page to node-canvas
    const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    const ctx = canvas.getContext("2d");

    await page.render({
      canvasContext: ctx,
      viewport
    }).promise;

    // Convert to JPEG buffer
    const jpegBuffer = canvas.toBuffer("image/jpeg", { quality });

    // Add to new PDF at original dimensions
    const img = await newPdf.embedJpg(jpegBuffer);
    const newPage = newPdf.addPage([originalViewport.width, originalViewport.height]);
    newPage.drawImage(img, {
      x: 0,
      y: 0,
      width: originalViewport.width,
      height: originalViewport.height
    });

    console.log(`  Page ${i}/${numPages} done`);
  }

  pdfDoc.destroy();
  return await newPdf.save({ useObjectStreams: true });
}

app.listen(port, () => {
  console.log(`PDF Compression API running on port ${port}`);
  console.log(`  GET  /wakeup   — Health check`);
  console.log(`  POST /compress — Compress a Salesforce PDF`);
});
