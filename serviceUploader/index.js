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

let isServerReady = false;

async function warmUpServer() {
  if (isServerReady) return true;
  
  console.log("Warming up server...");
  
  try {
    const testCanvas = createCanvas(100, 100);
    console.log("✓ Canvas initialized");
    
    const testPdf = await PDFDocument.create();
    console.log("✓ PDF-lib ready");
    
    if (pdfjsLib) {
      console.log("✓ pdfjs-dist ready");
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second buffer
    
    isServerReady = true;
    console.log("✓ Server is fully ready!");
    return true;
  } catch (err) {
    console.error("Server warm-up failed:", err);
    return false;
  }
}

app.get("/wakeup", async (req, res) => {
  console.log("Wakeup request received");
  
  try {
    const ready = await warmUpServer();
    
    if (ready) {
      res.status(200).json({ 
        status: "ready",
        message: "PDF Compression API is fully initialized and ready"
      });
    } else {
      res.status(503).json({ 
        status: "warming_up",
        message: "Server is still initializing, please try again"
      });
    }
  } catch (err) {
    console.error("Wakeup error:", err);
    res.status(500).json({ 
      status: "error",
      message: "Server initialization failed"
    });
  }
});

app.post("/compress", async (req, res) => {
  if (!isServerReady) {
    await warmUpServer();
  }
  
  const { basicurl, contverid, parentid, quality = 50, scaleFactor = 100 } = req.body;

  if (!basicurl || !contverid) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: basicurl, contverid"
    });
  }

  try {
    console.log(`Compressing PDF — ContentVersion: ${contverid}, quality: ${quality}%, scale: ${scaleFactor}%`);

    const [fileInfo, pdfBuffer] = await Promise.all([
      salesforce.getFileInfo(basicurl, contverid),
      salesforce.getFile(basicurl, contverid)
    ]);

    const originalSize = pdfBuffer.byteLength;
    console.log(`Original size: ${(originalSize / 1024).toFixed(1)} KB`);

    // Check if file is too large for free tier (will timeout)
    const estimatedTime = (originalSize / 1024 / 1024) * 3; // ~3 seconds per MB
    if (estimatedTime > 25) {
      return res.status(413).json({
        success: false,
        error: "File too large for free tier (will timeout)",
        suggestion: "Try reducing quality/scale or use smaller files",
        estimatedTime: `${estimatedTime.toFixed(0)}s`,
        maxTime: "25s"
      });
    }

    const compressedBytes = await compressPdf(
      new Uint8Array(pdfBuffer),
      quality / 100,
      scaleFactor / 100
    );
    const compressedSize = compressedBytes.length;
    const reductionPercent = ((1 - compressedSize / originalSize) * 100).toFixed(1);

    console.log(`Compressed: ${(compressedSize / 1024).toFixed(1)} KB (${reductionPercent}% reduction)`);

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

    // Explicitly clean up canvas to free memory
    canvasFactory.destroy({ canvas, context });

    console.log(`  Page ${i}/${numPages} done`);
  }

  pdfDoc.destroy();
  return await newPdf.save({ useObjectStreams: true });
}

app.listen(port, () => {
  console.log(`PDF Compression API running on port ${port}`);
  console.log(`  GET  /wakeup   — Health check & warm-up`);
  console.log(`  POST /compress — Compress a Salesforce PDF`);
});
