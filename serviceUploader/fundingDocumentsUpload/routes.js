const path = require("path");
const fs = require("fs");

const htmlTemplate = fs.readFileSync(path.join(__dirname, "upload.html"), "utf8");

// multer middleware that accepts the three named fields from the funding upload form
function fundingUploadMiddleware(upload) {
  return upload.fields([
    { name: "driverLicense", maxCount: 1 },
    { name: "voidedCheck",   maxCount: 1 },
    { name: "miscDocs",      maxCount: 10 }
  ]);
}

// Flatten the three field buckets into a labeled list: [{ file, label }]
function collectFiles(reqFiles) {
  const labeled = [];
  const buckets = [
    { field: "driverLicense", label: "Drivers_License" },
    { field: "voidedCheck",   label: "Voided_Check"    },
    { field: "miscDocs",      label: "Misc"             }
  ];
  for (const { field, label } of buckets) {
    for (const file of (reqFiles[field] || [])) {
      labeled.push({ file, label });
    }
  }
  return labeled;
}

function registerRoutes(app, { upload, jobs, batches, createJobId, updateJobStatus, processUploadJob, onUploadJobDone }) {
  app.get("/funding-documents-upload/status/:jobId", (req, res) => {
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

  app.get("/funding-documents-upload/:recordid", (req, res) => {
    const apiKey = req.query.apiKey;
    const expectedKey = process.env.UPLOAD_API_KEY;

    if (expectedKey && apiKey !== expectedKey) {
      return res.status(401).json({ success: false, error: "Invalid or missing API key" });
    }

    const ownerId = req.query.ownerId || "";

    const html = htmlTemplate
      .replace("{{RECORD_ID}}", req.params.recordid)
      .replace("{{API_KEY}}", apiKey || "")
      .replace("{{OWNER_ID}}", ownerId);
    res.send(html);
  });

  app.post("/funding-documents-upload/:recordid", fundingUploadMiddleware(upload), async (req, res) => {
    const recordid = req.params.recordid;
    const basicurl = process.env.SF_BASE_URL;

    const expectedKey = process.env.UPLOAD_API_KEY;
    if (expectedKey && req.headers["x-api-key"] !== expectedKey) {
      return res.status(401).json({ success: false, error: "Invalid or missing API key" });
    }

    const labeled = collectFiles(req.files || {});
    if (labeled.length === 0) {
      return res.status(400).json({ success: false, error: "No files provided" });
    }
    if (!basicurl) {
      return res.status(500).json({ success: false, error: "SF_BASE_URL environment variable is not configured" });
    }

    const totalSize = labeled.reduce((sum, { file }) => sum + file.size, 0);
    if (totalSize > 200 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: "Total file size exceeds 200 MB" });
    }

    const ownerId = req.headers["x-owner-id"] || "";

    console.log(`[funding-documents-upload] Uploading ${labeled.length} file(s) (${(totalSize / 1024 / 1024).toFixed(1)} MB total) to record ${recordid}`);

    const batchId = createJobId();
    const batch = { total: labeled.length, completed: 0, basicurl, recordid };
    batches.set(batchId, batch);

    const results = [];
    for (const { file, label } of labeled) {
      const baseName = file.originalname.replace(/\.[^.]+$/, "");
      const extension = path.extname(file.originalname).toLowerCase();
      const originalName = label + "_" + baseName;
      const isPdf = extension === ".pdf";
      const sizeMB = file.size / (1024 * 1024);
      const needsCompression = isPdf && sizeMB > 5;

      const jobId = createJobId();
      const job = {
        id: jobId,
        type: "upload",
        status: "queued",
        message: needsCompression ? "Queued for compression & upload" : "Queued for upload",
        progress: 0,
        createdAt: Date.now(),
        batchId,
        params: { basicurl, recordid, originalName, extension, needsCompression, ownerId },
        fileBytes: new Uint8Array(file.buffer),
        originalSize: file.size
      };
      jobs.set(jobId, job);

      console.log(`[funding-documents-upload][Job ${jobId}] [${label}] "${file.originalname}" (${sizeMB.toFixed(1)} MB)${needsCompression ? " — will compress" : ""}`);
      setImmediate(() => processUploadJob(jobId));

      results.push({
        success: true,
        fileName: file.originalname,
        label,
        jobId,
        statusUrl: `/funding-documents-upload/status/${jobId}`,
        needsCompression,
        originalSize: file.size
      });
    }

    res.json({ success: true, results });
  });
}

module.exports = { registerRoutes };
