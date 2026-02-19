const express = require("express");
require("dotenv").config();

const path = require("path");
const crypto = require("crypto");

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
    console.log(`Original size: ${(originalSize / 1024).toFixed(1)} KB (${sizeMB.toFixed(1)} MB)`);

    // For files >= 20MB, use async processing
    if (sizeMB >= 20) {
      const jobId = createJobId();
      const job = {
        id: jobId,
        status: "queued",
        message: "Job created, waiting to start",
        createdAt: Date.now(),
        params: { basicurl, contverid, parentid, ownerid, quality, scaleFactor },
        fileInfo,
        pdfBuffer,
        originalSize
      };

      jobs.set(jobId, job);
      console.log(`[Job ${jobId}] Large file - using async processing`);

      // Start processing in background
      setImmediate(() => processCompressionJob(jobId));

      // Return immediately
      return res.json({
        success: true,
        jobId,
        message: "Large file - compression job started",
        statusUrl: `/compress/status/${jobId}`,
        async: true
      });
    }

    // For files < 20MB, process synchronously
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
  const { fileInfo, pdfBuffer, originalSize } = job;

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
  const fs = require("fs");
  const os = require("os");
  const { execFile } = require("child_process");

  const tmpDir = os.tmpdir();
  const timestamp = Date.now();
  const inputPath = path.join(tmpDir, `pdf_input_${timestamp}.pdf`);
  const outputPath = path.join(tmpDir, `pdf_output_${timestamp}.pdf`);

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

  console.log(`Ghostscript: preset=${pdfSettings}, imageDPI=${targetDpi}, jpegQuality=${jpegQuality}`);

  if (onProgress) onProgress(0, 1);

  return new Promise((resolve, reject) => {
    execFile("gs", [
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
      `-dMonoImageResolution=${targetDpi}`,
      `-dJPEGQ=${jpegQuality}`,
      `-sOutputFile=${outputPath}`,
      inputPath
    ], { timeout: 300000 }, (error) => {
      // Clean up input
      try { fs.unlinkSync(inputPath); } catch (_) {}

      if (error) {
        try { fs.unlinkSync(outputPath); } catch (_) {}
        reject(new Error(`Ghostscript failed: ${error.message}`));
        return;
      }

      try {
        const result = fs.readFileSync(outputPath);
        fs.unlinkSync(outputPath);
        if (onProgress) onProgress(1, 1);
        resolve(new Uint8Array(result));
      } catch (readErr) {
        reject(new Error(`Failed to read compressed PDF: ${readErr.message}`));
      }
    });
  });
}

app.listen(port, '0.0.0.0', () => {
  console.log(`PDF Compression API running on port: ${port}`);
  console.log(`  GET  /wakeup              — Health check & warm-up`);
  console.log(`  POST /compress            — Start compression job (async)`);
  console.log(`  GET  /compress/status/:id — Check job status`);
});
