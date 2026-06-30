const express = require("express");
require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const { PDFDocument } = require("pdf-lib");
const multer = require("multer");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024, files: 10 } });
app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: "100mb" }));
const port = process.env.PORT || 4000;

const fs = require("fs");
const salesforce = require("./salesforce");

let isServerReady = false;
let mupdfModule = null;

// Job queue for async processing
const jobs = new Map();
// Batch tracking for grouped upload jobs
const batches = new Map();

async function getPdfPageCount(pdfBuffer) {
  const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  return doc.getPageCount();
}

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
    const { execFile } = require("child_process");
    await new Promise((resolve, reject) => {
      execFile("gs", ["--version"], (error, stdout) => {
        if (error) {
          reject(new Error("Ghostscript (gs) not found. Install it to enable PDF compression."));
          return;
        }
        console.log(`✓ Ghostscript ${stdout.trim()} available`);
        resolve();
      });
    });

    // MuPDF (WASM) is optional — used only as a fallback when Ghostscript can't reduce
    try {
      mupdfModule = await import("mupdf");
      if (mupdfModule && mupdfModule.Document && mupdfModule.PDFDocument) {
        console.log(`✓ MuPDF (WASM) available`);
      } else {
        console.warn(`⚠ mupdf module loaded but API unexpected — fallback compression disabled`);
        mupdfModule = null;
      }
    } catch (mupdfErr) {
      console.warn(`⚠ MuPDF (WASM) not available: ${mupdfErr.message} — fallback compression disabled`);
      mupdfModule = null;
    }

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

  const { basicurl, contverid, parentid, ownerid, quality = 50, scaleFactor = 100 } = req.body;

  if (!basicurl || !contverid) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: basicurl, contverid"
    });
  }

  try {
    console.log(`Compressing PDF — ContentVersion: ${contverid}, quality: ${quality}%, scale: ${scaleFactor}%`);

    // Download file to check size
    const [fileInfo, pdfBuffer] = await Promise.all([
      salesforce.getFileInfo(basicurl, contverid),
      salesforce.getFile(basicurl, contverid)
    ]);

    const originalSize = pdfBuffer.byteLength;
    const sizeMB = originalSize / (1024 * 1024);
    const pageCount = await getPdfPageCount(pdfBuffer);
    console.log(`Original size: ${(originalSize / 1024).toFixed(1)} KB (${sizeMB.toFixed(1)} MB), ${pageCount} page(s)`);

    // For files >= 20MB or > 30 pages, use async processing
    if (sizeMB >= 20 || pageCount > 30) {
      const jobId = createJobId();
      const job = {
        id: jobId,
        status: "queued",
        message: "Job created, waiting to start",
        createdAt: Date.now(),
        params: { basicurl, contverid, parentid, ownerid, quality, scaleFactor },
        fileInfo,
        pdfBuffer,
        originalSize,
        pageCount
      };

      jobs.set(jobId, job);
      console.log(`[Job ${jobId}] Large file - using async processing`);

      // Start processing in background
      setImmediate(() => processCompressionJob(jobId));

      // Return immediately
      return res.json({
        success: true,
        jobId,
        pageCount,
        message: "Large file - compression job started",
        statusUrl: `/compress/status/${jobId}`,
        async: true
      });
    }

    // For files < 20MB and <= 30 pages, process synchronously
    console.log(`Small file - processing synchronously`);

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
        parentId: parentid,
        ownerId: ownerid,
        asyncCompression: false
      }
    );

    res.json({
      success: true,
      originalSize,
      compressedSize,
      pageCount,
      reductionPercent: parseFloat(reductionPercent),
      contentVersionId: saved.id,
      async: false
    });
  } catch (err) {
    console.error("Compression error:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
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

  const { basicurl, parentid, ownerid, quality, scaleFactor } = job.params;
  const { fileInfo, pdfBuffer, originalSize, pageCount } = job;

  try {

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
        parentId: parentid,
        ownerId: ownerid,
        asyncCompression: true
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
        pageCount,
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
  const os = require("os");

  const tmpDir = os.tmpdir();
  const timestamp = Date.now();
  const inputPath = path.join(tmpDir, `pdf_input_${timestamp}.pdf`);

  fs.writeFileSync(inputPath, Buffer.from(pdfBytes));

  // Map quality (0-1) to Ghostscript PDFSETTINGS preset
  let pdfSettings;
  if (quality <= 0.4) pdfSettings = "/screen";       // 72 DPI — smallest
  else if (quality <= 0.7) pdfSettings = "/ebook";    // 150 DPI — balanced
  else if (quality <= 0.85) pdfSettings = "/printer";  // 300 DPI — high quality
  else pdfSettings = "/prepress";                      // 300 DPI — max quality

  // Map scale (0-1) to target image DPI (base 150 DPI)
  const targetDpi = Math.max(36, Math.round(150 * scale));
  const jpegQuality = Math.round(quality * 100);

  if (onProgress) onProgress(0, 1);

  try {
    const originalSize = pdfBytes.length || pdfBytes.byteLength;

    // First pass: use the caller-requested preset/quality
    let compressed = await runGhostscript(inputPath, pdfSettings, targetDpi, jpegQuality);

    // If output is not smaller, retry once with the most aggressive settings
    const moreAggressive = pdfSettings !== "/screen" || targetDpi > 72 || jpegQuality > 40;
    if (compressed.length >= originalSize && moreAggressive) {
      console.log(`Output (${(compressed.length / 1024).toFixed(1)} KB) ≥ original (${(originalSize / 1024).toFixed(1)} KB) — retrying with /screen @ jpegQ 40`);
      const retry = await runGhostscript(inputPath, "/screen", 72, 40);
      if (retry.length < compressed.length) compressed = retry;
    }

    // If Ghostscript's reduction is small, also try MuPDF — handles JPEG2000/JBIG2 sources that Ghostscript bloats
    const FALLBACK_TRIGGER_REDUCTION = 0.15;
    const gsReduction = 1 - compressed.length / originalSize;
    if (gsReduction < FALLBACK_TRIGGER_REDUCTION) {
      const reasonMsg = compressed.length >= originalSize
        ? `≥ original`
        : `only ${(gsReduction * 100).toFixed(1)}% reduction (threshold ${FALLBACK_TRIGGER_REDUCTION * 100}%)`;
      console.log(`Ghostscript output (${(compressed.length / 1024).toFixed(1)} KB) ${reasonMsg} — trying MuPDF fallback`);
      try {
        const mupdfOut = await runMupdf(pdfBytes);
        if (mupdfOut.length < compressed.length) {
          console.log(`MuPDF result: ${(mupdfOut.length / 1024).toFixed(1)} KB`);
          compressed = mupdfOut;
        } else {
          console.log(`MuPDF output (${(mupdfOut.length / 1024).toFixed(1)} KB) did not beat best Ghostscript result`);
        }
      } catch (mupdfErr) {
        console.warn(`MuPDF fallback failed: ${mupdfErr.message}`);
      }
    }

    // Final escalation: if best result is still below threshold, run aggressive Ghostscript (lossy)
    const bestReduction = 1 - compressed.length / originalSize;
    if (bestReduction < FALLBACK_TRIGGER_REDUCTION) {
      console.log(`Best result (${(compressed.length / 1024).toFixed(1)} KB, ${(bestReduction * 100).toFixed(1)}% reduction) still below threshold — trying aggressive Ghostscript pass (color/gray DPI=150, mono DPI=300, jpegQ=35, forced DCTEncode)`);
      try {
        const aggressiveOut = await runGhostscript(inputPath, "/screen", 150, 35, 300, true);
        if (aggressiveOut.length < compressed.length) {
          console.log(`Aggressive Ghostscript result: ${(aggressiveOut.length / 1024).toFixed(1)} KB`);
          compressed = aggressiveOut;
        } else {
          console.log(`Aggressive Ghostscript output (${(aggressiveOut.length / 1024).toFixed(1)} KB) did not beat best result`);
        }
      } catch (aggErr) {
        console.warn(`Aggressive Ghostscript pass failed: ${aggErr.message}`);
      }
    }

    // If still not smaller than original, return the original bytes
    if (compressed.length >= originalSize) {
      console.log(`Compression cannot reduce this PDF further — keeping original (${(originalSize / 1024).toFixed(1)} KB)`);
      if (onProgress) onProgress(1, 1);
      return new Uint8Array(pdfBytes.buffer ? pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) : pdfBytes);
    }

    if (onProgress) onProgress(1, 1);
    return compressed;
  } finally {
    try { fs.unlinkSync(inputPath); } catch (_) {}
  }
}

async function runMupdf(pdfBytes) {
  if (!mupdfModule) {
    try {
      mupdfModule = await import("mupdf");
    } catch (err) {
      throw new Error(`mupdf module not available: ${err.message}`);
    }
  }

  const options = "compress,compress-images,compress-fonts,sanitize,garbage=deduplicate";
  console.log(`MuPDF (WASM): saveToBuffer with ${options}`);

  const doc = mupdfModule.Document.openDocument(Buffer.from(pdfBytes), "application/pdf");
  try {
    if (typeof doc.saveToBuffer !== "function") {
      throw new Error("opened document is not a PDFDocument");
    }
    const buf = doc.saveToBuffer(options);
    return new Uint8Array(buf.asUint8Array());
  } finally {
    if (typeof doc.destroy === "function") doc.destroy();
  }
}

function qualityToQFactor(quality) {
  // Ghostscript QFactor for DCTEncode: lower = better quality
  // Calibrated against GS defaults: /printer (Q~95)=0.15, /ebook (Q~75)=0.40, /screen (Q~50)=0.76
  if (quality >= 95) return 0.15;
  if (quality >= 85) return 0.25;
  if (quality >= 75) return 0.40;
  if (quality >= 65) return 0.55;
  if (quality >= 50) return 0.76;
  if (quality >= 35) return 1.0;
  if (quality >= 20) return 1.3;
  return 1.6;
}

function runGhostscript(inputPath, pdfSettings, targetDpi, jpegQuality, monoDpi = targetDpi, forceLossy = false) {
  const os = require("os");
  const { execFile } = require("child_process");

  const outputPath = path.join(os.tmpdir(), `pdf_output_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`);

  const qFactor = qualityToQFactor(jpegQuality);
  console.log(`Ghostscript: preset=${pdfSettings}, imageDPI=${targetDpi}, monoDPI=${monoDpi}, jpegQuality=${jpegQuality}${forceLossy ? ` (forced DCTEncode, QFactor=${qFactor})` : ""}`);

  const args = [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    `-dPDFSETTINGS=${pdfSettings}`,
    "-dNOPAUSE",
    "-dBATCH",
    "-dQUIET",
    "-dDownsampleColorImages=true",
    `-dColorImageResolution=${targetDpi}`,
    "-dColorImageDownsampleType=/Bicubic",
    "-dDownsampleGrayImages=true",
    `-dGrayImageResolution=${targetDpi}`,
    "-dGrayImageDownsampleType=/Bicubic",
    "-dDownsampleMonoImages=true",
    `-dMonoImageResolution=${monoDpi}`,
    `-dJPEGQ=${jpegQuality}`,
  ];

  args.push(`-sOutputFile=${outputPath}`);

  if (forceLossy) {
    // Use PostScript injection for image dict — more reliable than -dColorImageDict across GS versions
    const dict = `<< /QFactor ${qFactor} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
    const psCmd = `<< /AutoFilterColorImages false /ColorImageFilter /DCTEncode /ColorImageDict ${dict} /AutoFilterGrayImages false /GrayImageFilter /DCTEncode /GrayImageDict ${dict} >> setdistillerparams`;
    args.push("-c", psCmd, "-f", inputPath);
  } else {
    args.push(inputPath);
  }

  return new Promise((resolve, reject) => {
    execFile("gs", args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        try { fs.unlinkSync(outputPath); } catch (_) {}
        const stderrTail = stderr ? `\nstderr: ${stderr.toString().trim().slice(-800)}` : "";
        reject(new Error(`Ghostscript failed: ${error.message}${stderrTail}`));
        return;
      }

      try {
        const result = fs.readFileSync(outputPath);
        fs.unlinkSync(outputPath);
        resolve(new Uint8Array(result));
      } catch (readErr) {
        reject(new Error(`Failed to read compressed PDF: ${readErr.message}`));
      }
    });
  });
}

// --- Document Upload UI & API ---

const uploadHtmlTemplate = fs.readFileSync(path.join(__dirname, 'upload.html'), 'utf8');
const fundingDocumentsUpload = require('./fundingDocumentsUpload/routes');

app.get("/documents-upload/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ success: false, error: "Job not found" });
  }

  res.json({
    success: true,
    job: {
      id: job.id,
      type: job.type,
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

app.get("/documents-upload/:recordid", (req, res) => {
  const apiKey = req.query.apiKey;
  const expectedKey = process.env.UPLOAD_API_KEY;

  if (expectedKey && apiKey !== expectedKey) {
    return res.status(401).json({ success: false, error: "Invalid or missing API key" });
  }

  const ownerId = req.query.ownerId || '';

  const html = uploadHtmlTemplate
    .replace('{{RECORD_ID}}', req.params.recordid)
    .replace('{{API_KEY}}', apiKey || '')
    .replace('{{OWNER_ID}}', ownerId);
  res.send(html);
});

app.post("/documents-upload/:recordid", upload.array("files", 10), async (req, res) => {
  const recordid = req.params.recordid;
  const basicurl = process.env.SF_BASE_URL;

  const expectedKey = process.env.UPLOAD_API_KEY;
  if (expectedKey && req.headers['x-api-key'] !== expectedKey) {
    return res.status(401).json({ success: false, error: "Invalid or missing API key" });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, error: "No files provided" });
  }
  if (!basicurl) {
    return res.status(500).json({ success: false, error: "SF_BASE_URL environment variable is not configured" });
  }

  const totalSize = req.files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > 200 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: "Total file size exceeds 200 MB" });
  }

  const ownerId = req.headers['x-owner-id'] || '';

  console.log(`Uploading ${req.files.length} file(s) (${(totalSize / 1024 / 1024).toFixed(1)} MB total) to record ${recordid}`);

  // Create a batch to track all jobs from this upload request
  const batchId = createJobId();
  const batch = { total: req.files.length, completed: 0, basicurl, recordid };
  batches.set(batchId, batch);

  // Queue all files as background jobs — respond immediately
  const results = [];
  for (const file of req.files) {
    const originalName = file.originalname.replace(/\.[^.]+$/, '');
    const extension = path.extname(file.originalname).toLowerCase();
    const isPdf = extension === '.pdf';
    const sizeMB = file.size / (1024 * 1024);
    const needsCompression = isPdf && sizeMB > 5;

    const jobId = createJobId();
    const job = {
      id: jobId,
      type: 'upload',
      status: 'queued',
      message: needsCompression ? 'Queued for compression & upload' : 'Queued for upload',
      progress: 0,
      createdAt: Date.now(),
      batchId,
      params: { basicurl, recordid, originalName, extension, needsCompression, ownerId },
      fileBytes: new Uint8Array(file.buffer),
      originalSize: file.size
    };
    jobs.set(jobId, job);

    console.log(`[Job ${jobId}] "${file.originalname}" (${sizeMB.toFixed(1)} MB)${needsCompression ? ' — will compress' : ''}`);
    setImmediate(() => processUploadJob(jobId));

    results.push({
      success: true,
      fileName: file.originalname,
      jobId,
      statusUrl: `/documents-upload/status/${jobId}`,
      needsCompression,
      originalSize: file.size
    });
  }

  res.json({ success: true, results });
});

async function processUploadJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  const { basicurl, recordid, originalName, extension, needsCompression, ownerId } = job.params;

  try {
    let fileBytes = job.fileBytes;
    let wasCompressed = false;

    // Compress PDF if needed (>5MB)
    if (needsCompression) {
      if (!isServerReady) await warmUpServer();

      if (isServerReady) {
        updateJobStatus(jobId, {
          status: 'compressing',
          message: 'Compressing PDF...',
          progress: 10
        });

        try {
          const compressed = await compressPdf(fileBytes, 0.7, 1.0);
          const reduction = ((1 - compressed.length / fileBytes.length) * 100).toFixed(1);
          console.log(`[Job ${jobId}] Compressed: ${(fileBytes.length / 1024 / 1024).toFixed(1)} MB → ${(compressed.length / 1024 / 1024).toFixed(1)} MB (${reduction}% reduction)`);
          fileBytes = compressed;
          wasCompressed = true;
        } catch (compressErr) {
          console.error(`[Job ${jobId}] Compression failed, uploading original: ${compressErr.message}`);
        }
      }
    }

    updateJobStatus(jobId, {
      status: 'uploading',
      message: `Uploading to Salesforce (${(fileBytes.length / 1024 / 1024).toFixed(1)} MB)`,
      progress: 50
    });

    const saved = await salesforce.uploadFile(
      basicurl,
      originalName,
      fileBytes,
      {
        parentId: recordid,
        pathOnClient: originalName + extension,
        ownerId
      }
    );

    // Free memory
    job.fileBytes = null;

    updateJobStatus(jobId, {
      status: 'completed',
      message: 'Upload completed successfully',
      progress: 100,
      completedAt: Date.now(),
      result: {
        contentVersionId: saved.id,
        originalSize: job.originalSize,
        uploadSize: fileBytes.length,
        wasCompressed
      }
    });

    console.log(`[Job ${jobId}] Upload completed: ${saved.id}`);
    setTimeout(() => jobs.delete(jobId), 60 * 60 * 1000);
    await onUploadJobDone(job.batchId);
  } catch (err) {
    job.fileBytes = null;
    console.error(`[Job ${jobId}] Upload failed: ${err.message}`);
    updateJobStatus(jobId, {
      status: 'failed',
      message: 'Upload failed',
      error: err.message,
      completedAt: Date.now()
    });
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
    await onUploadJobDone(job.batchId);
  }
}

async function onUploadJobDone(batchId) {
  const batch = batches.get(batchId);
  if (!batch) return;

  batch.completed++;
  if (batch.completed < batch.total) return;

  // All jobs in this batch are done — update the record
  batches.delete(batchId);
  try {
    await salesforce.updateRecord(batch.basicurl, batch.recordid, {
      Send_Email_Notification__c: true
    });
    console.log(`[Batch ${batchId}] Set Send_Email_Notification__c on ${batch.recordid}`);
  } catch (err) {
    console.error(`[Batch ${batchId}] Failed to update record ${batch.recordid}: ${err.message}`);
  }
}

// --- Funding Documents Upload ---

fundingDocumentsUpload.registerRoutes(app, {
  upload,
  jobs,
  batches,
  createJobId,
  updateJobStatus,
  processUploadJob,
  onUploadJobDone
});

app.listen(port, '0.0.0.0', () => {
  console.log(`PDF Compression API running on port: ${port}`);
  console.log(`  GET  /wakeup              — Health check & warm-up`);
  console.log(`  POST /compress            — Start compression job (async)`);
  console.log(`  GET  /compress/status/:id — Check job status`);
});
