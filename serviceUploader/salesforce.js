require('dotenv').config();
const axios = require('axios');

class SalesforceConnection {

  async getToken(basicUrl){
    const url = basicUrl + '/services/oauth2/token';
    
    console.log('URL:', url);
    console.log('CLIENT_ID_SF:', process.env.CLIENT_ID_SF);
    console.log('CLIENT_SECRET_SF:', process.env.CLIENT_SECRET_SF ? '***exists***' : 'MISSING!');
  
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials'); 
    params.append('client_id', process.env.CLIENT_ID_SF);
    params.append('client_secret', process.env.CLIENT_SECRET_SF);
    
    try {
      const response = await axios.post(url, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      console.log('Access Token received ✅');
      return response.data.access_token;
    } catch (error) {
      console.error('Salesforce Error:', error.response?.data);
      throw error;
    }
  }

  // NEW METHOD: Get file size without downloading
  async getFileSize(basicUrl, contVerId) {
    console.log('Getting file size for ContentVersion:', contVerId);
    const accessToken = await this.getToken(basicUrl);
    
    const url = `${basicUrl}/services/data/v58.0/sobjects/ContentVersion/${contVerId}`;
    
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    
    const fileSize = response.data.ContentSize;
    console.log('File size:', (fileSize / (1024 * 1024)).toFixed(2), 'MB');
    return fileSize;
  }

  // MODIFIED METHOD: Get file as stream instead of buffer
  async getFileStream(basicUrl, contVerId) {
    console.log('Downloading file stream from Salesforce...');
    console.log('ContentVersion ID:', contVerId);
    
    const accessToken = await this.getToken(basicUrl);
    const url = `${basicUrl}/services/data/v58.0/sobjects/ContentVersion/${contVerId}/VersionData`;
    
    console.log('Download URL:', url);
    
    const response = await axios.get(url, {
      responseType: 'stream',  // ← Changed from 'arraybuffer' to 'stream'
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    
    console.log('File stream ready ✅');
    return response.data;  // Returns a readable stream
  }

  // KEEP OLD METHOD for backward compatibility if needed
  async getFile(basicUrl, contVerId) {
    console.log('Downloading file buffer from Salesforce...');
    const accessToken = await this.getToken(basicUrl);
    const url = `${basicUrl}/services/data/v58.0/sobjects/ContentVersion/${contVerId}/VersionData`;
    
    const response = await axios.get(url, {
      responseType: 'arraybuffer', 
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    
    console.log('File downloaded ✅');
    return response.data;
  }
}

module.exports = new SalesforceConnection();