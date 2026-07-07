const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios");
const salesforce = require("../salesforce");

const htmlTemplate = fs.readFileSync(path.join(__dirname, "upload.html"), "utf8");

const MAX_FILE_SIZE_MB = 50;

// Upload a file to Salesforce as a ContentVersion linked to the given record.
// Mirrors the working portal-submissions upload: JSON body + base64, no OwnerId.
async function uploadContentVersion(basicUrl, title, fileBytes, { recordId, pathOnClient }) {
  const accessToken = await salesforce.getToken(basicUrl);
  const url = `${basicUrl}/services/data/v59.0/sobjects/ContentVersion`;

  const body = {
    Title: title,
    PathOnClient: pathOnClient || title,
    VersionData: Buffer.from(fileBytes).toString("base64"),
    ...(recordId ? { FirstPublishLocationId: recordId } : {})
  };

  const response = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    maxContentLength: 300 * 1024 * 1024,
    maxBodyLength: 300 * 1024 * 1024,
    timeout: 120000
  });

  return response.data;
}

// Session tokens issued at page load: token -> { recordid, ownerId }
const sessionTokens = new Map();

function createSessionToken(recordid, ownerId) {
  const token = crypto.randomBytes(24).toString("hex");
  sessionTokens.set(token, { recordid, ownerId });
  return token;
}

function consumeSessionToken(token) {
  return sessionTokens.get(token) || null;
}

function fundingUploadMiddleware(upload) {
  return upload.fields([
    { name: "driverLicense", maxCount: 1 },
    { name: "voidedCheck",   maxCount: 1 },
    { name: "miscDocs",      maxCount: 10 }
  ]);
}

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

function validateApiKey(key) {
  const expected = process.env.UPLOAD_API_KEY;
  return !expected || key === expected;
}

async function processFundingJob(jobId, jobs) {
  const job = jobs.get(jobId);
  if (!job) return;

  const { basicurl, recordid, originalName, extension } = job.params;

  try {
    const fileBytes = job.fileBytes;

    job.status = "uploading";
    job.message = `Uploading to Salesforce (${(fileBytes.length / 1024 / 1024).toFixed(1)} MB)`;
    job.progress = 50;
    console.log(`[funding][Job ${jobId}] Uploading "${originalName + extension}" to record ${recordid}`);

    const saved = await uploadContentVersion(basicurl, originalName, fileBytes, {
      recordId: recordid,
      pathOnClient: originalName + extension
    });

    job.fileBytes = null;
    job.status = "completed";
    job.message = "Upload completed successfully";
    job.progress = 100;
    job.completedAt = Date.now();
    job.result = {
      contentVersionId: saved.id,
      originalSize: job.originalSize,
      uploadSize: fileBytes.length
    };

    console.log(`[funding][Job ${jobId}] Completed: ${saved.id}`);
    setTimeout(() => jobs.delete(jobId), 60 * 60 * 1000);
  } catch (err) {
    job.fileBytes = null;
    job.status = "failed";
    job.message = "Upload failed";
    job.error = err.message;
    job.completedAt = Date.now();
    console.error(`[funding][Job ${jobId}] Failed: ${err.message}`, err.response?.data ? JSON.stringify(err.response.data) : '');
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
  }
}

function registerRoutes(app, { upload, jobs, createJobId }) {
  // Salesforce opens this page via POST, passing apiKey in the body
  app.post("/funding-documents-upload/:recordid", fundingUploadMiddleware(upload), async (req, res) => {
    // Page load: no files attached — Salesforce POSTs apiKey in body
    const labeled = collectFiles(req.files || {});
    if (labeled.length === 0) {
      const apiKey = req.body && req.body.apiKey;
      if (!validateApiKey(apiKey)) {
        return res.status(401).send("Unauthorized");
      }
      const ownerId = (req.body && req.body.ownerId) || "";
      const sessionToken = createSessionToken(req.params.recordid, ownerId);
      const html = htmlTemplate
        .replace("{{RECORD_ID}}", req.params.recordid)
        .replace("{{SESSION_TOKEN}}", sessionToken)
        .replace("{{OWNER_ID}}", ownerId);
      return res.send(html);
    }

    // File upload: validate short-lived session token from X-API-Key header
    const session = consumeSessionToken(req.headers["x-api-key"]);
    if (!session) {
      return res.status(401).json({ success: false, error: "Invalid or expired session" });
    }

    const basicurl = process.env.SF_BASE_URL;
    if (!basicurl) {
      return res.status(500).json({ success: false, error: "SF_BASE_URL environment variable is not configured" });
    }

    const recordid = session.recordid;
    const ownerId = session.ownerId;

    const oversized = labeled.filter(({ file }) => file.size > MAX_FILE_SIZE_MB * 1024 * 1024);
    if (oversized.length > 0) {
      return res.status(400).json({
        success: false,
        error: `File(s) exceed ${MAX_FILE_SIZE_MB} MB limit: ${oversized.map(({ file }) => file.originalname).join(", ")}`
      });
    }

    const totalSize = labeled.reduce((sum, { file }) => sum + file.size, 0);
    console.log(`[funding] Uploading ${labeled.length} file(s) (${(totalSize / 1024 / 1024).toFixed(1)} MB total) to record ${recordid}`);

    const results = [];
    for (const { file, label } of labeled) {
      const baseName = file.originalname.replace(/\.[^.]+$/, "");
      const extension = path.extname(file.originalname).toLowerCase();
      const originalName = label + "_" + baseName;
      const sizeMB = file.size / (1024 * 1024);

      const jobId = createJobId();
      const job = {
        id: jobId,
        type: "upload",
        status: "queued",
        message: "Queued for upload",
        progress: 0,
        createdAt: Date.now(),
        params: { basicurl, recordid, originalName, extension, ownerId },
        fileBytes: new Uint8Array(file.buffer),
        originalSize: file.size
      };
      jobs.set(jobId, job);

      console.log(`[funding][Job ${jobId}] [${label}] "${file.originalname}" (${sizeMB.toFixed(1)} MB)`);
      setImmediate(() => processFundingJob(jobId, jobs));

      results.push({
        success: true,
        fileName: file.originalname,
        label,
        jobId,
        statusUrl: `/funding-documents-upload/status/${jobId}`,
        originalSize: file.size
      });
    }

    res.json({ success: true, results });
  });

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
}

module.exports = { registerRoutes };
