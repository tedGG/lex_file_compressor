const express = require("express");
require("dotenv").config();

const { createCanvas } = require("canvas");
const { PDFDocument } = require("pdf-lib");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

const app = express();
app.use(express.json({ limit: "100mb" }));
const port = process.env.PORT || 4000;

const salesforce = require("./salesforce");

app.get("/wakeup", (req, res) => {
  res.send("PDF Compression API is running");
});

app.post("/compress", async (req, res) => {
  const { basicurl, contverid, parentid, quality = 50, scaleFactor = 100 } = req.body;

  if (!basicurl || !contverid) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: basicurl, contverid"
    });
  }

  try {
    console.log(`Compressing PDF — ContentVersion: ${contverid}, quality: ${quality}%, scale: ${scaleFactor}%`);

    // Get file info (title, ContentDocumentId) and file data in parallel
    const [fileInfo, pdfBuffer] = await Promise.all([
      salesforce.getFileInfo(basicurl, contverid),
      salesforce.getFile(basicurl, contverid)
    ]);

    const originalSize = pdfBuffer.byteLength;
    console.log(`Original size: ${(originalSize / 1024).toFixed(1)} KB`);

    const compressedBytes = await compressPdf(
      new Uint8Array(pdfBuffer),
      quality / 100,
      scaleFactor / 100
    );
    const compressedSize = compressedBytes.length;
    const reductionPercent = ((1 - compressedSize / originalSize) * 100).toFixed(1);

    console.log(`Compressed: ${(compressedSize / 1024).toFixed(1)} KB (${reductionPercent}% reduction)`);

    // Save compressed file back to Salesforce
    const title = fileInfo.Title + '_compressed';
    const saved = await salesforce.saveFile(
      basicurl,
      title,
      compressedBytes,
      {
        contentDocumentId: parentid ? undefined : fileInfo.ContentDocumentId,
        parentId: parentid
      }
    );

    res.json({
      success: true,
      originalSize,
      compressedSize,
      reductionPercent: parseFloat(reductionPercent),
      contentVersionId: saved.id
    });
  } catch (err) {
    console.error("Compression error:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

async function compressPdf(pdfBytes, quality, scale) {
  const canvasFactory = new NodeCanvasFactory();
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes, useSystemFonts: true, canvasFactory });
  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;
  console.log(`Processing ${numPages} page(s)`);

  const newPdf = await PDFDocument.create();

  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const originalViewport = page.getViewport({ scale: 1.0 });
    const viewport = page.getViewport({ scale });

    const { canvas, context } = canvasFactory.create(
      Math.floor(viewport.width),
      Math.floor(viewport.height)
    );

    await page.render({
      canvasContext: context,
      viewport
    }).promise;

    const jpegBuffer = canvas.toBuffer("image/jpeg", { quality });

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
