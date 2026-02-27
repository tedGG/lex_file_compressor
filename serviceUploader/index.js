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

const salesforce = require("./salesforce");

let isServerReady = false;

// Job queue for async processing
const jobs = new Map();

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

// --- Document Upload UI & API ---

app.get("/documents-upload/:recordid", (req, res) => {
  const recordid = req.params.recordid;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Upload Document</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #fff; border-radius: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 8px 30px rgba(0,0,0,0.07); padding: 20px 25px; max-width: 480px; width: 100%; text-align: center; }
    .logo { margin-bottom: 6px; }
    .logo img { max-height: 220px; }
    h1 { font-size: 20px; color: #111; margin-bottom: 24px; font-weight: 600; letter-spacing: -0.3px; }
    .drop-zone { border: 2px dashed #ccc; border-radius: 12px; padding: 48px 24px; cursor: pointer; transition: all 0.25s ease; position: relative; margin-bottom: 8px; }
    .drop-zone:hover { border-color: #999; background: #fafafa; }
    .drop-zone.dragover { border-color: #333; background: #f5f5f5; transform: scale(1.01); }
    .drop-zone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .drop-icon { width: 48px; height: 48px; margin: 0 auto 14px; background: #f0f0f0; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
    .drop-icon svg { width: 24px; height: 24px; color: #555; }
    .drop-zone p { color: #999; font-size: 14px; line-height: 1.5; }
    .drop-zone p b { color: #111; font-weight: 500; }
    .drop-zone .hint { font-size: 12px; color: #bbb; margin-top: 8px; }
    .file-list { margin-bottom: 20px; }
    .file-item { display: flex; align-items: center; gap: 10px; text-align: left; padding: 10px 12px; background: #fafafa; border: 1px solid #eee; border-radius: 10px; margin-top: 8px; }
    .file-item .fi-icon { width: 34px; height: 34px; background: #f0f0f0; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .file-item .fi-icon svg { width: 18px; height: 18px; color: #555; }
    .file-item .fi-details { overflow: hidden; flex: 1; }
    .file-item .fi-name { font-size: 13px; font-weight: 500; color: #111; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .file-item .fi-size { font-size: 11px; color: #999; margin-top: 1px; }
    .file-item .fi-remove { background: none; border: none; cursor: pointer; color: #bbb; padding: 4px; flex-shrink: 0; display: flex; align-items: center; }
    .file-item .fi-remove:hover { color: #e00; }
    .btn { width: 100%; padding: 14px; background: #111; color: #fff; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.2s; letter-spacing: 0.2px; }
    .btn:hover { background: #333; }
    .btn:disabled { background: #ccc; cursor: not-allowed; }
    .status { margin-top: 16px; padding: 12px 16px; border-radius: 10px; font-size: 13px; display: none; text-align: left; }
    .status.success { display: block; background: #f0faf0; color: #1a7a1a; }
    .status.error { display: block; background: #fef2f2; color: #b91c1c; }
    .status.loading { display: block; background: #f5f5f5; color: #333; }
    .spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid #ddd; border-top-color: #333; border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="logo"><img src="/logo.png" alt="Company Logo"></div>
  <div class="card">
    <h1>Upload Documents</h1>
    <form id="uploadForm">
      <div class="drop-zone" id="dropZone">
        <div class="drop-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.338-2.32 3.75 3.75 0 013.578 4.788A4.5 4.5 0 0118 19.5H6.75z"/></svg></div>
        <p>Drag & drop files here<br>or <b>browse</b></p>
        <div class="hint">Up to 10 files, 200 MB total</div>
        <input type="file" id="fileInput" multiple>
      </div>
      <div class="file-list" id="fileList"></div>
      <button type="submit" class="btn" id="submitBtn" disabled>Upload</button>
    </form>
    <div class="status" id="status"></div>
  </div>
  <script>
    const MAX_FILES = 10;
    const MAX_TOTAL = 200 * 1024 * 1024;
    const recordid = '${recordid}';
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const fileList = document.getElementById('fileList');
    const form = document.getElementById('uploadForm');
    const statusEl = document.getElementById('status');
    const submitBtn = document.getElementById('submitBtn');
    let selectedFiles = [];

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function totalSize() {
      return selectedFiles.reduce((sum, f) => sum + f.size, 0);
    }

    function addFiles(newFiles) {
      for (const f of newFiles) {
        if (selectedFiles.length >= MAX_FILES) break;
        if (selectedFiles.some(s => s.name === f.name && s.size === f.size)) continue;
        selectedFiles.push(f);
      }
      if (totalSize() > MAX_TOTAL) {
        statusEl.className = 'status error';
        statusEl.textContent = 'Total file size exceeds 200 MB. Remove some files.';
      } else {
        statusEl.style.display = 'none';
      }
      renderFiles();
    }

    function removeFile(index) {
      selectedFiles.splice(index, 1);
      if (totalSize() <= MAX_TOTAL) statusEl.style.display = 'none';
      renderFiles();
    }

    function renderFiles() {
      fileList.innerHTML = '';
      selectedFiles.forEach((f, i) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML =
          '<div class="fi-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg></div>' +
          '<div class="fi-details"><div class="fi-name">' + f.name + '</div><div class="fi-size">' + formatSize(f.size) + '</div></div>' +
          '<button type="button" class="fi-remove" data-idx="' + i + '"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></button>';
        fileList.appendChild(item);
      });
      fileList.querySelectorAll('.fi-remove').forEach(btn => {
        btn.addEventListener('click', () => removeFile(parseInt(btn.dataset.idx)));
      });
      submitBtn.disabled = selectedFiles.length === 0 || totalSize() > MAX_TOTAL;
    }

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!selectedFiles.length) return;

      submitBtn.disabled = true;
      statusEl.className = 'status loading';
      statusEl.innerHTML = '<span class="spinner"></span> Uploading ' + selectedFiles.length + ' file(s)...';

      const fd = new FormData();
      selectedFiles.forEach(f => fd.append('files', f));

      try {
        const res = await fetch('/documents-upload/' + recordid, { method: 'POST', body: fd });
        const data = await res.json();
        if (data.success) {
          const count = data.results.filter(r => r.success).length;
          const failed = data.results.filter(r => !r.success).length;
          statusEl.className = 'status success';
          statusEl.textContent = count + ' file(s) uploaded successfully.' + (failed ? ' ' + failed + ' failed.' : '');
          selectedFiles = [];
          renderFiles();
        } else {
          statusEl.className = 'status error';
          statusEl.textContent = data.error || 'Upload failed.';
          submitBtn.disabled = false;
        }
      } catch (err) {
        statusEl.className = 'status error';
        statusEl.textContent = 'Network error: ' + err.message;
        submitBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`);
});

app.post("/documents-upload/:recordid", upload.array("files", 10), async (req, res) => {
  const recordid = req.params.recordid;
  const basicurl = process.env.SF_BASE_URL;

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

  console.log(`Uploading ${req.files.length} file(s) (${(totalSize / 1024 / 1024).toFixed(1)} MB total) to record ${recordid}`);

  const results = [];
  for (const file of req.files) {
    try {
      const originalName = file.originalname.replace(/\.[^.]+$/, '');
      const extension = path.extname(file.originalname);

      const saved = await salesforce.saveFile(
        basicurl,
        originalName,
        new Uint8Array(file.buffer),
        {
          parentId: recordid,
          pathOnClient: originalName + extension
        }
      );

      console.log(`Uploaded "${file.originalname}": ${saved.id}`);
      results.push({ success: true, fileName: file.originalname, contentVersionId: saved.id });
    } catch (err) {
      console.error(`Failed "${file.originalname}": ${err.message}`);
      results.push({ success: false, fileName: file.originalname, error: err.message });
    }
  }

  res.json({ success: true, results });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`PDF Compression API running on port: ${port}`);
  console.log(`  GET  /wakeup              — Health check & warm-up`);
  console.log(`  POST /compress            — Start compression job (async)`);
  console.log(`  GET  /compress/status/:id — Check job status`);
});
