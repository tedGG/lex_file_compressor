const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

class GoogleDriveConnection {
    async getAccessToken() {
        const url = 'https://oauth2.googleapis.com/token';

        const params = new URLSearchParams();
        params.append('client_id', process.env.GOOGLE_CLIENT_ID);
        params.append('client_secret', process.env.GOOGLE_CLIENT_SECRET);
        params.append('refresh_token', process.env.GOOGLE_REFRESH_TOKEN);
        params.append('grant_type', 'refresh_token');

        try {
            const response = await axios.post(url, params);
            console.log('Google Drive access token received ✅');
            return response.data.access_token;
        } catch (error) {
            console.error('Failed to get Google Drive access token:', error.response?.data || error.message);
            throw error;
        }
    }

    // NEW METHOD: Upload file using stream (memory efficient)
    async uploadFileStream(fileStream, fileSize, accessToken, fileName, folderId) {
        try {
            const fileSizeInMB = fileSize / (1024 * 1024);
            console.log(`Uploading file to Google Drive (streaming)...`);
            console.log(`File size: ${fileSizeInMB.toFixed(2)} MB`);
            
            // Create metadata
            const metadata = {
                name: fileName,
                mimeType: 'application/pdf'
            };

            if (folderId) {
                metadata.parents = [folderId];
            }

            // Step 1: Initiate resumable upload
            console.log('Initiating resumable upload...');
            const initResponse = await axios.post(
                'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
                metadata,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'X-Upload-Content-Type': 'application/pdf',
                        'X-Upload-Content-Length': fileSize
                    }
                }
            );

            const uploadUrl = initResponse.headers.location;
            console.log('Upload session created ✅');

            // Step 2: Stream upload file content
            console.log('Streaming file content to Google Drive...');
            const uploadResponse = await axios.put(
                uploadUrl,
                fileStream,  // Stream the file
                {
                    headers: {
                        'Content-Type': 'application/pdf',
                        'Content-Length': fileSize
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    timeout: 600000,  // 10 minutes
                    onUploadProgress: (progressEvent) => {
                        const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                        if (percentCompleted % 10 === 0) {  // Log every 10%
                            console.log(`Upload progress: ${percentCompleted}%`);
                        }
                    }
                }
            );

            console.log('File uploaded successfully ✅');
            console.log('File ID:', uploadResponse.data.id);
            console.log('File Name:', uploadResponse.data.name);
            
            return uploadResponse.data;
        } catch (error) {
            console.error('Failed to upload file to Google Drive ❌');
            console.error('Error:', error.response?.data || error.message);
            throw error;
        }
    }

    // KEEP OLD METHOD for backward compatibility
    async uploadFile(file, accessToken, fileName, folderId) {
        try {
            const fileSizeInMB = file.length / (1024 * 1024);
            console.log(`Uploading file to Google Drive...`);
            console.log(`File size: ${fileSizeInMB.toFixed(2)} MB`);
            
            const metadata = {
                name: fileName,
                mimeType: 'application/pdf'
            };

            if (folderId) {
                metadata.parents = [folderId];
            }

            const boundary = '-------314159265358979323846';
            const delimiter = "\r\n--" + boundary + "\r\n";
            const close_delim = "\r\n--" + boundary + "--";

            const multipartRequestBody =
                delimiter +
                'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                'Content-Type: application/pdf\r\n' +
                'Content-Transfer-Encoding: base64\r\n\r\n' +
                file.toString('base64') +
                close_delim;

            const response = await axios.post(
                'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
                multipartRequestBody,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': `multipart/related; boundary=${boundary}`
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                }
            );

            console.log('File uploaded successfully ✅');
            return response.data;
        } catch (error) {
            console.error('Failed to upload file to Google Drive ❌:', error.response?.data || error.message);
            throw error;
        }
    }
}

module.exports = new GoogleDriveConnection();