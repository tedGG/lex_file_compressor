const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();


class SharepointConnection {
    async  getAccessToken() {
        const url = `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`;

        const params = new URLSearchParams();
        params.append('client_id', process.env.CLIENT_ID);
        params.append('client_secret', process.env.CLIENT_SECRET);
        params.append('scope', 'https://graph.microsoft.com/.default');
        params.append('grant_type', 'client_credentials');

        try {
            const response = await axios.post(url, params);
            console.log('Access token received ✅');
            return response.data.access_token;
        } catch (error) {
            console.error('Failed to get access token:', error.response?.data || error.message);
        }
    }

    async  createFile(file, accesstoken, endPoint) {
        //const endPoint = 'https://graph.microsoft.com/v1.0/sites/solarruhrcom.sharepoint.com,55f6599e-d8f6-43f5-9958-ab3de7461207,16082a3b-8f44-450e-b45d-469a054ec9bd/drives/b!nln2VfbY9UOZWKs950YSBzsqCBZEjw5FtF1GmgVOyb2UApmG3M6BTK8B14BRa6A3/items/01MX7ZES7BSD3SQBXIZNDI27HQZ5VYC474:/00000401__ServDok_V9_1760611423510310.pdf:/content';
        try {
            console.log('Uploading file to SharePoint...');
            
            const response = await fetch(endPoint, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${accesstoken}`,
                    'Content-Type': 'application/pdf',
                },
                body: file, 
            });
const data = await response.json();
            console.log('response:', data);

        } catch (error) {
            console.error('Failed to upload file to SharePoint ❌:', error.message);
            throw error;
        }
    }


    
}

module.exports =  new SharepointConnection();