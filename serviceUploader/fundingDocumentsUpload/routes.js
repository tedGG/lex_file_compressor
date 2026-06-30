const path = require("path");
const fs = require("fs");

const htmlTemplate = fs.readFileSync(path.join(__dirname, "upload.html"), "utf8");

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

  app.post("/funding-documents-upload/:recordid", upload.array("files", 10), async (req, res) => {
    const recordid = req.params.recordid;
    const basicurl = process.env.SF_BASE_URL;

    const expectedKey = process.env.UPLOAD_API_KEY;
    if (expectedKey && req.headers["x-api-key"] !== expectedKey) {
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

    const ownerId = req.headers["x-owner-id"] || "";

    console.log(`[funding-documents-upload] Uploading ${req.files.length} file(s) (${(totalSize / 1024 / 1024).toFixed(1)} MB total) to record ${recordid}`);

    const batchId = createJobId();
    const batch = { total: req.files.length, completed: 0, basicurl, recordid };
    batches.set(batchId, batch);

    const results = [];
    for (const file of req.files) {
      const originalName = file.originalname.replace(/\.[^.]+$/, "");
      const extension = path.extname(file.originalname).toLowerCase();
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

      console.log(`[funding-documents-upload][Job ${jobId}] "${file.originalname}" (${sizeMB.toFixed(1)} MB)${needsCompression ? " — will compress" : ""}`);
      setImmediate(() => processUploadJob(jobId));

      results.push({
        success: true,
        fileName: file.originalname,
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
