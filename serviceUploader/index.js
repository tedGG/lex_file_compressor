const express = require("express");
require("dotenv").config();

const { createCanvas } = require("canvas");
const { PDFDocument } = require("pdf-lib");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const crypto = require("crypto");

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

// Job queue for async processing
const jobs = new Map();

function createJobId() {
  return crypto.randomBytes(8).toString("hex");
}

function updateJobStatus(jobId, updates) {
  const job = jobs.get(jobId);
  if (job) {
    Object.assign(job, updates);
    console.log(`[Job ${jobId}] Status: ${job.status} ${job.message || ''}`);
  }
}

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

  // Create job and return immediately
  const jobId = createJobId();
  const job = {
    id: jobId,
    status: "queued",
    message: "Job created, waiting to start",
    createdAt: Date.now(),
    params: { basicurl, contverid, parentid, quality, scaleFactor }
  };

  jobs.set(jobId, job);
  console.log(`[Job ${jobId}] Created - ContentVersion: ${contverid}, quality: ${quality}%, scale: ${scaleFactor}%`);

  // Start processing in background
  setImmediate(() => processCompressionJob(jobId));

  // Return immediately
  res.json({
    success: true,
    jobId,
    message: "Compression job started",
    statusUrl: `/compress/status/${jobId}`
  });
});

app.get("/compress/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job not found"
    });
  }

  res.json({
    success: true,
    job: {
      id: job.id,
      status: job.status,
      message: job.message,
      progress: job.progress,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      result: job.result,
      error: job.error
    }
  });
});

async function processCompressionJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  const { basicurl, contverid, parentid, quality, scaleFactor } = job.params;

  try {
    updateJobStatus(jobId, {
      status: "downloading",
      message: "Downloading file from Salesforce",
      progress: 10
    });

    const [fileInfo, pdfBuffer] = await Promise.all([
      salesforce.getFileInfo(basicurl, contverid),
      salesforce.getFile(basicurl, contverid)
    ]);

    const originalSize = pdfBuffer.byteLength;
    console.log(`[Job ${jobId}] Original size: ${(originalSize / 1024).toFixed(1)} KB`);

    updateJobStatus(jobId, {
      status: "processing",
      message: `Processing PDF (${(originalSize / 1024).toFixed(1)} KB)`,
      progress: 30,
      originalSize
    });

    const compressedBytes = await compressPdf(
      new Uint8Array(pdfBuffer),
      quality / 100,
      scaleFactor / 100,
      (page, total) => {
        const progress = 30 + Math.floor((page / total) * 50);
        updateJobStatus(jobId, {
          progress,
          message: `Processing page ${page}/${total}`
        });
      }
    );

    const compressedSize = compressedBytes.length;
    const reductionPercent = ((1 - compressedSize / originalSize) * 100).toFixed(1);

    console.log(`[Job ${jobId}] Compressed: ${(compressedSize / 1024).toFixed(1)} KB (${reductionPercent}% reduction)`);

    updateJobStatus(jobId, {
      status: "uploading",
      message: "Uploading compressed file to Salesforce",
      progress: 85,
      compressedSize,
      reductionPercent: parseFloat(reductionPercent)
    });

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

    updateJobStatus(jobId, {
      status: "completed",
      message: "Compression completed successfully",
      progress: 100,
      completedAt: Date.now(),
      result: {
        originalSize,
        compressedSize,
        reductionPercent: parseFloat(reductionPercent),
        contentVersionId: saved.id
      }
    });

    // Clean up job after 1 hour
    setTimeout(() => jobs.delete(jobId), 60 * 60 * 1000);

  } catch (err) {
    console.error(`[Job ${jobId}] Error:`, err.message);
    updateJobStatus(jobId, {
      status: "failed",
      message: "Compression failed",
      error: err.message,
      completedAt: Date.now()
    });

    // Clean up failed job after 10 minutes
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
  }
}

async function compressPdf(pdfBytes, quality, scale, onProgress) {
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

    // Report progress
    if (onProgress) {
      onProgress(i, numPages);
    }
  }

  pdfDoc.destroy();
  return await newPdf.save({ useObjectStreams: true });
}

app.listen(port, '0.0.0.0', () => {
  console.log(`PDF Compression API running on port ${port}`);
  console.log(`  GET  /wakeup              — Health check & warm-up`);
  console.log(`  POST /compress            — Start compression job (async)`);
  console.log(`  GET  /compress/status/:id — Check job status`);
});
