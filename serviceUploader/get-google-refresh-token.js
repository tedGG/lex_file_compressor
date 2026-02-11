require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = 3000;

// Google OAuth configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback';

// Scopes - adjust based on what you need
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

// Step 1: Generate authorization URL
app.get('/auth', (req, res) => {
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${GOOGLE_CLIENT_ID}&` +
    `redirect_uri=${REDIRECT_URI}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(SCOPES)}&` +
    `access_type=offline&` +
    `prompt=consent`;
  
  console.log('Visit this URL to authorize:');
  console.log(authUrl);
  res.redirect(authUrl);
});

// Step 2: Handle OAuth callback and exchange code for tokens
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).send('No authorization code received');
  }

  try {
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    
    const params = new URLSearchParams();
    params.append('code', code);
    params.append('client_id', GOOGLE_CLIENT_ID);
    params.append('client_secret', GOOGLE_CLIENT_SECRET);
    params.append('redirect_uri', REDIRECT_URI);
    params.append('grant_type', 'authorization_code');

    const response = await axios.post(tokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token, refresh_token, expires_in, token_type } = response.data;

    console.log('\n=================================');
    console.log('✅ SUCCESS! Tokens received:');
    console.log('=================================');
    console.log('Access Token:', access_token);
    console.log('\nRefresh Token:', refresh_token);
    console.log('\nExpires in:', expires_in, 'seconds');
    console.log('Token Type:', token_type);
    console.log('=================================\n');
    console.log('⚠️  IMPORTANT: Save the refresh_token to your .env file!');
    console.log('Add this line to your .env file:');
    console.log(`GOOGLE_REFRESH_TOKEN=${refresh_token}`);
    console.log('=================================\n');

    res.send(`
      <html>
        <body>
          <h1>✅ Authorization Successful!</h1>
          <h2>Your Refresh Token:</h2>
          <p style="background: #f0f0f0; padding: 10px; word-break: break-all;">
            ${refresh_token}
          </p>
          <h3>Add this to your .env file:</h3>
          <pre style="background: #f0f0f0; padding: 10px;">
GOOGLE_REFRESH_TOKEN=${refresh_token}
          </pre>
          <p>Check your console for full details.</p>
          <p>You can close this window now.</p>
        </body>
      </html>
    `);

    // Automatically shutdown server after 5 seconds
    setTimeout(() => {
      console.log('Shutting down server...');
      process.exit(0);
    }, 5000);

  } catch (error) {
    console.error('Error getting tokens:', error.response?.data || error.message);
    res.status(500).send('Error getting tokens. Check console for details.');
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`\n📝 To get your refresh token:`);
  console.log(`   1. Visit: http://localhost:${PORT}/auth`);
  console.log(`   2. Authorize the application`);
  console.log(`   3. Copy the refresh_token to your .env file\n`);
});