require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');

class SalesforceConnection {

  async getToken(basicUrl) {
    const url = basicUrl + '/services/oauth2/token';

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', process.env.CLIENT_ID_SF);
    params.append('client_secret', process.env.CLIENT_SECRET_SF);

    try {
      const response = await axios.post(url, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      console.log('Salesforce access token received');
      return response.data.access_token;
    } catch (error) {
      console.error('Salesforce auth error:', error.response?.data);
      throw error;
    }
  }

  async getFile(basicUrl, contVerId) {
    const accessToken = await this.getToken(basicUrl);
    const url = `${basicUrl}/services/data/v58.0/sobjects/ContentVersion/${contVerId}/VersionData`;

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      maxContentLength: 100 * 1024 * 1024, // 200MB
      maxBodyLength: 100 * 1024 * 1024,
      timeout: 30000 // 2 minutes for large files
    });

    console.log('File downloaded from Salesforce');
    return response.data;
  }

  async getFileInfo(basicUrl, contVerId) {
    const accessToken = await this.getToken(basicUrl);
    const url = `${basicUrl}/services/data/v58.0/sobjects/ContentVersion/${contVerId}?fields=Title,ContentDocumentId`;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    return response.data;
  }

  async saveFile(basicUrl, title, pdfBytes, { contentDocumentId, parentId, ownerId, asyncCompression = false, pathOnClient }) {
    const accessToken = await this.getToken(basicUrl);
    const url = `${basicUrl}/services/data/v58.0/sobjects/ContentVersion`;

    const base64Data = Buffer.from(pdfBytes).toString('base64');

    const body = {
      Title: title,
      PathOnClient: pathOnClient || title + '.pdf',
      VersionData: base64Data,
      Async_Comression__c: asyncCompression
    };

    if (parentId) {
      body.FirstPublishLocationId = parentId;
    } else if (contentDocumentId) {
      body.ContentDocumentId = contentDocumentId;
    }

    if (ownerId) {
      body.OwnerId = ownerId;
    }

    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      maxContentLength: 300 * 1024 * 1024, // 300MB (base64 inflates ~33%)
      maxBodyLength: 300 * 1024 * 1024,
      timeout: 120000 // 2 minutes for large files
    });

    console.log('File saved to Salesforce:', response.data.id);
    return response.data;
  }

  async updateRecord(basicUrl, recordId, fields) {
    const accessToken = await this.getToken(basicUrl);

    // Detect sObject type from Salesforce ID prefix
    const prefixMap = { '00Q': 'Lead', '006': 'Opportunity' };
    const prefix = recordId.substring(0, 3);
    const sObjectType = prefixMap[prefix];
    if (!sObjectType) {
      throw new Error(`Unknown sObject type for ID prefix: ${prefix}`);
    }

    const url = `${basicUrl}/services/data/v58.0/sobjects/${sObjectType}/${recordId}`;
    await axios.patch(url, fields, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`Updated ${sObjectType} ${recordId}:`, fields);
  }

  async uploadFile(basicUrl, title, fileBytes, { parentId, pathOnClient, ownerId }) {
    const accessToken = await this.getToken(basicUrl);
    const url = `${basicUrl}/services/data/v58.0/sobjects/ContentVersion`;

    const metadata = { Title: title, PathOnClient: pathOnClient || title };
    if (parentId) {
      metadata.FirstPublishLocationId = parentId;
    }
    if (ownerId) {
      metadata.OwnerId = ownerId;
    }

    const form = new FormData();
    form.append('entity_content', JSON.stringify(metadata), {
      contentType: 'application/json'
    });
    form.append('VersionData', Buffer.from(fileBytes), {
      filename: pathOnClient || title,
      contentType: 'application/octet-stream'
    });

    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${accessToken}`
      },
      maxContentLength: 300 * 1024 * 1024,
      maxBodyLength: 300 * 1024 * 1024,
      timeout: 120000
    });

    console.log('File uploaded to Salesforce:', response.data.id);
    return response.data;
  }
}

module.exports = new SalesforceConnection();
