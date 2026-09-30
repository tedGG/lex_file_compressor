const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios");

const htmlTemplate = fs.readFileSync(path.join(__dirname, "upload.html"), "utf8");

const MAX_FILE_SIZE_MB = 50;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Renders the Misc Docs description block, or an empty string when none was provided.
function buildMiscDocsDescription(raw) {
  const text = (raw || "").trim();
  if (!text) return "";
  return `<div class="field-desc">${escapeHtml(text)}</div>`;
}

// Must be the My Domain host (*.my.salesforce.com), NOT the Lightning host —
// the OAuth token endpoint is only served on My Domain.
const SF_LOGIN_URL = process.env.SF_BASE_URL;

const OFFER_REDIRECT_BASE_URL = process.env.FUNDING_OFFER_URL || "";

// `offer` is echoed back exactly as received (encoded but not re-serialized).
function buildOfferRedirectUrl(recordId, offer) {
  if (!OFFER_REDIRECT_BASE_URL) return "";
  const sep = OFFER_REDIRECT_BASE_URL.includes("?") ? "&" : "?";
  let url = `${OFFER_REDIRECT_BASE_URL}${sep}id=${encodeURIComponent(recordId)}&uploaded=success`;
  if (offer) url += `&offer=${encodeURIComponent(offer)}`;
  return url;
}

// Returns { access_token, instance_url } — instance_url must be used for API calls.
async function getAccessToken() {
  const url = `${SF_LOGIN_URL}/services/oauth2/token`;

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", process.env.CLIENT_ID_SF);
  params.append("client_secret", process.env.CLIENT_SECRET_SF);

  const response = await axios.post(url, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  return response.data;
}

async function uploadContentVersion(title, fileBytes, { recordId, pathOnClient }) {
  const { access_token, instance_url } = await getAccessToken();
  const url = `${instance_url}/services/data/v59.0/sobjects/ContentVersion`;

  const body = {
    Title: title,
    PathOnClient: pathOnClient || title,
    VersionData: Buffer.from(fileBytes).toString("base64"),
    File_Section__c: "Closing Documents",
    ...(recordId ? { FirstPublishLocationId: recordId } : {})
  };

  const response = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json"
    },
    maxContentLength: 300 * 1024 * 1024,
    maxBodyLength: 300 * 1024 * 1024,
    timeout: 120000
  });

  return response.data;
}

const LINK_CHECK_ATTEMPTS = 5;
const LINK_CHECK_DELAY_MS = 1000;

function soqlString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// Looks the files up the same way the offer page's email does (files linked to the record),
// limited to the versions just uploaded. Returns the ContentVersion Ids found on the record.
async function findVersionsOnRecord(recordId, contentVersionIds) {
  const { access_token, instance_url } = await getAccessToken();
  const soql =
    "SELECT ContentDocument.LatestPublishedVersionId FROM ContentDocumentLink" +
    ` WHERE LinkedEntityId = ${soqlString(recordId)}` +
    ` AND ContentDocument.LatestPublishedVersionId IN (${contentVersionIds.map(soqlString).join(", ")})`;

  const response = await axios.get(`${instance_url}/services/data/v59.0/query`, {
    params: { q: soql },
    headers: { Authorization: `Bearer ${access_token}` },
    timeout: 30000
  });

  return new Set(response.data.records.map((r) => r.ContentDocument.LatestPublishedVersionId));
}

// Asks Salesforce until every uploaded file shows up on the record. Returns false if some
// still don't after LINK_CHECK_ATTEMPTS tries.
async function waitForFilesOnRecord(recordId, contentVersionIds) {
  for (let attempt = 1; attempt <= LINK_CHECK_ATTEMPTS; attempt++) {
    const found = await findVersionsOnRecord(recordId, contentVersionIds);
    const missing = contentVersionIds.filter((id) => !found.has(id));
    if (missing.length === 0) {
      console.log(`[funding] Salesforce confirms ${contentVersionIds.length} file(s) on record ${recordId} (check ${attempt})`);
      return true;
    }
    console.warn(`[funding] ${missing.length} file(s) not on record ${recordId} yet (check ${attempt}): ${missing.join(", ")}`);
    if (attempt < LINK_CHECK_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, LINK_CHECK_DELAY_MS));
    }
  }
  return false;
}

const sessionTokens = new Map();

function createSessionToken(recordid, ownerId, offer) {
  const token = crypto.randomBytes(24).toString("hex");
  sessionTokens.set(token, { recordid, ownerId, offer });
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
    { field: "driverLicense", label: "Driver License" },
    { field: "voidedCheck",   label: "Voided Check"   },
    { field: "miscDocs",      label: "Misc Docs"      }
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

  const { recordid, originalName, extension } = job.params;

  try {
    const fileBytes = job.fileBytes;

    job.status = "uploading";
    job.message = `Uploading to Salesforce (${(fileBytes.length / 1024 / 1024).toFixed(1)} MB)`;
    job.progress = 50;
    console.log(`[funding][Job ${jobId}] Uploading "${originalName + extension}" to record ${recordid}`);

    const saved = await uploadContentVersion(originalName, fileBytes, {
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
  app.post("/funding-documents-upload/:recordid", fundingUploadMiddleware(upload), async (req, res) => {
    // Page load: Salesforce POSTs apiKey with no files. File upload: files present.
    const labeled = collectFiles(req.files || {});
    if (labeled.length === 0) {
      const apiKey = req.body && req.body.apiKey;
      if (!validateApiKey(apiKey)) {
        return res.status(401).send("Unauthorized");
      }
      const ownerId = (req.body && req.body.ownerId) || "";

      // `offer` is an opaque JSON string echoed back on redirect. Keep the raw
      // string; if it's missing or not valid JSON, just omit it (don't error).
      let offer = "";
      const rawOffer = req.body && req.body.offer;
      if (rawOffer) {
        try {
          JSON.parse(rawOffer);
          offer = rawOffer;
        } catch (_) {
          console.warn("[funding] Received offer that is not valid JSON — omitting from redirect");
        }
      }

      const miscDocsDescription = buildMiscDocsDescription(req.body && req.body.miscDocsDescription);

      const sessionToken = createSessionToken(req.params.recordid, ownerId, offer);
      const html = htmlTemplate
        .replace("{{RECORD_ID}}", req.params.recordid)
        .replace("{{SESSION_TOKEN}}", sessionToken)
        .replace("{{OWNER_ID}}", ownerId)
        .replace("{{OFFER_REDIRECT_URL}}", buildOfferRedirectUrl(req.params.recordid, offer))
        .replace("{{MISC_DOCS_DESCRIPTION}}", () => miscDocsDescription);
      return res.send(html);
    }

    const session = consumeSessionToken(req.headers["x-api-key"]);
    if (!session) {
      return res.status(401).json({ success: false, error: "Invalid or expired session" });
    }

    if (!process.env.CLIENT_ID_SF || !process.env.CLIENT_SECRET_SF) {
      return res.status(500).json({ success: false, error: "Salesforce credentials are not configured" });
    }

    const recordid = session.recordid;

    const oversized = labeled.filter(({ file }) => file.size > MAX_FILE_SIZE_MB * 1024 * 1024);
    if (oversized.length > 0) {
      return res.status(400).json({
        success: false,
        error: `File(s) exceed ${MAX_FILE_SIZE_MB} MB limit: ${oversized.map(({ file }) => file.originalname).join(", ")}`
      });
    }

    const totalSize = labeled.reduce((sum, { file }) => sum + file.size, 0);
    console.log(`[funding] Uploading ${labeled.length} file(s) (${(totalSize / 1024 / 1024).toFixed(1)} MB total) to record ${recordid}`);

    const queued = [];
    for (const { file, label } of labeled) {
      const baseName = file.originalname.replace(/\.[^.]+$/, "");
      const extension = path.extname(file.originalname).toLowerCase();
      const originalName = `[Funding Offer - ${label}] ${baseName}`;
      const sizeMB = file.size / (1024 * 1024);

      const jobId = createJobId();
      const job = {
        id: jobId,
        type: "upload",
        status: "queued",
        message: "Queued for upload",
        progress: 0,
        createdAt: Date.now(),
        params: { recordid, originalName, extension },
        fileBytes: new Uint8Array(file.buffer),
        originalSize: file.size
      };
      jobs.set(jobId, job);

      console.log(`[funding][Job ${jobId}] [${label}] "${file.originalname}" (${sizeMB.toFixed(1)} MB)`);
      queued.push({ job, file, label });
    }

    // Wait until every file is saved in Salesforce before responding, so the page only
    // redirects back to the offer (which accepts it) once all documents are there.
    const uploadStartedAt = Date.now();
    await Promise.all(queued.map(({ job }) => processFundingJob(job.id, jobs)));

    // Same order as the files were sent — the page relies on it to know which ones to retry.
    const results = queued.map(({ job, file, label }) => ({
      success: job.status === "completed",
      fileName: file.originalname,
      label,
      jobId: job.id,
      statusUrl: `/funding-documents-upload/status/${job.id}`,
      originalSize: file.size,
      ...(job.error ? { error: job.error } : {})
    }));

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      console.error(`[funding] ${failed.length} of ${results.length} file(s) failed for record ${recordid}`);
      return res.status(502).json({
        success: false,
        error: `Couldn't upload: ${failed.map((r) => r.fileName).join(", ")}. Please try again.`,
        results
      });
    }

    // Before redirecting (which accepts the offer and sends the email), confirm with Salesforce
    // that the files are on the record. If it can't be confirmed, redirect anyway: the files are
    // saved, and failing here would leave the merchant unable to accept the offer.
    const contentVersionIds = queued.map(({ job }) => job.result.contentVersionId);
    try {
      const confirmed = await waitForFilesOnRecord(recordid, contentVersionIds);
      if (!confirmed) {
        console.error(`[funding] Could not confirm all files on record ${recordid} — redirecting anyway`);
      }
    } catch (err) {
      console.error(`[funding] File check failed for record ${recordid}: ${err.message} — redirecting anyway`, err.response?.data ? JSON.stringify(err.response.data) : "");
    }

    console.log(`[funding] All ${results.length} file(s) saved in Salesforce for record ${recordid} in ${Date.now() - uploadStartedAt} ms — page will redirect now`);
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
