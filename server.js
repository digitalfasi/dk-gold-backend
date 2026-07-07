// server.js
// Full pipeline: reads Google Sheet → generates TTS audio → calls via Exotel → logs outcome back to Sheet
//
// SETUP:
// 1. npm install express googleapis @google-cloud/text-to-speech node-cron dotenv
// 2. Put service-account.json in this folder
// 3. Create a .env file (see .env.example) with your Exotel + Sheet details
// 4. Deploy this to a small server (Render/Railway/DigitalOcean) so it has a public URL
//    — Exotel needs to reach your /exotel/flow and /exotel/status-callback endpoints,
//    and the audio files need a public URL too. Localhost won't work for this part.
// 5. Run: node server.js

require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const textToSpeech = require('@google-cloud/text-to-speech');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/audio', express.static(path.join(__dirname, 'audio'))); // serves generated mp3s publicly

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL; // e.g. https://dkgold-console.onrender.com
const SHEET_ID = process.env.SHEET_ID;
const EXOTEL_SID = process.env.EXOTEL_SID;
const EXOTEL_API_KEY = process.env.EXOTEL_API_KEY;
const EXOTEL_API_TOKEN = process.env.EXOTEL_API_TOKEN;
const EXOPHONE = process.env.EXOPHONE;

if (!fs.existsSync(path.join(__dirname, 'audio'))) fs.mkdirSync(path.join(__dirname, 'audio'));

// ---------- GOOGLE SHEETS ----------
// On Vercel, credentials come from an env variable (not a file on disk)
const googleCredentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

async function getCustomers() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A2:D' // Name, Phone, Amount, Status
  });
  return (res.data.values || []).map((row, i) => ({
    rowNumber: i + 2,
    name: row[0],
    phone: row[1],
    amount: row[2],
    status: (row[3] || '').toLowerCase()
  }));
}

async function updateStatus(rowNumber, status, extraNote = '') {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Sheet1!D${rowNumber}:E${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status, extraNote]] }
  });
}

// ---------- TTS ----------
const ttsClient = new textToSpeech.TextToSpeechClient({ credentials: googleCredentials });

function amountToWords(amount) {
  const num = Number(amount);
  if (num >= 100000) return `${(num / 100000).toFixed(1).replace('.0', '')} lakh rupees`;
  if (num >= 1000) {
    const th = Math.floor(num / 1000), rem = num % 1000;
    return rem > 0 ? `${th} thousand ${rem} rupees` : `${th} thousand rupees`;
  }
  return `${num} rupees`;
}

async function generateAudio(customer) {
  const text = `Hi ${customer.name}, this is a reminder from D K Gold. Your outstanding balance is ${amountToWords(customer.amount)}. Please clear it at your earliest convenience. Thank you.`;
  const [response] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: 'en-IN', name: 'en-IN-Wavenet-B' },
    audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95 }
  });
  const fileName = `${customer.phone.replace(/\D/g, '')}-${Date.now()}.mp3`;
  fs.writeFileSync(path.join(__dirname, 'audio', fileName), response.audioContent, 'binary');
  return `${PUBLIC_URL}/audio/${fileName}`; // public URL Exotel will fetch
}

// ---------- EXOTEL ----------
async function placeCall(customer, audioUrl) {
  const res = await axios.post(
    `https://api.exotel.com/v1/Accounts/${EXOTEL_SID}/Calls/connect.json`,
    new URLSearchParams({
      From: EXOPHONE,
      To: customer.phone,
      CallerId: EXOPHONE,
      Url: `${PUBLIC_URL}/exotel/flow?audio=${encodeURIComponent(audioUrl)}`,
      StatusCallback: `${PUBLIC_URL}/exotel/status-callback`
    }),
    { auth: { username: EXOTEL_API_KEY, password: EXOTEL_API_TOKEN } }
  );
  return res.data.Call.Sid;
}

// Exotel hits this when the call connects — tells it to play the audio
app.get('/exotel/flow', (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Play>${req.query.audio}</Play><Hangup/></Response>`);
});

// Exotel posts the final call outcome here
app.post('/exotel/status-callback', async (req, res) => {
  const { To, Status } = req.body; // completed / no-answer / busy / failed
  console.log(`Call to ${To} ended with status: ${Status}`);
  try {
    const customers = await getCustomers();
    const match = customers.find(c => c.phone.replace(/\D/g, '') === (To || '').replace(/\D/g, ''));
    if (match) {
      const outcome = Status === 'completed' ? 'pending' : (Status === 'busy' || Status === 'failed' ? 'no-answer' : Status);
      await updateStatus(match.rowNumber, outcome, `Last called: ${new Date().toLocaleString()}`);
    }
  } catch (err) {
    console.error('Failed to update sheet:', err.message);
  }
  res.sendStatus(200);
});

// ---------- MAIN CYCLE ----------
async function runCallCycle() {
  console.log('--- Starting call cycle ---');
  const customers = await getCustomers();
  const pending = customers.filter(c => c.status === 'pending' || c.status === 'no-answer');

  for (const customer of pending) {
    try {
      console.log(`Calling ${customer.name} (${customer.phone})...`);
      const audioUrl = await generateAudio(customer);
      await placeCall(customer, audioUrl);
      await new Promise(r => setTimeout(r, 2000)); // small gap between calls
    } catch (err) {
      console.error(`Failed for ${customer.name}:`, err.message);
    }
  }
  console.log('--- Cycle complete ---');
}

// Manual trigger endpoint (for the dashboard's "Call all pending" button)
app.post('/api/call-all', async (req, res) => {
  runCallCycle(); // fire and forget, dashboard shows progress via polling /api/status separately
  res.json({ started: true });
});

// Demo-friendly endpoint: generates audio for a customer WITHOUT calling — just returns the audio URL to play
app.get('/api/preview-audio/:phone', async (req, res) => {
  try {
    const customers = await getCustomers();
    const match = customers.find(c => c.phone.replace(/\D/g, '') === req.params.phone.replace(/\D/g, ''));
    if (!match) return res.status(404).json({ error: 'Customer not found in sheet' });
    const audioUrl = await generateAudio(match);
    res.json({ name: match.name, amount: match.amount, audioUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers', async (req, res) => {
  res.json(await getCustomers());
});

// Automatic schedule — every 2 hours, only within call window (adjust to match Rules tab settings)
cron.schedule('0 */2 * * *', () => {
  const hour = new Date().getHours();
  if (hour >= 10 && hour < 19) runCallCycle();
});

app.listen(PORT, () => console.log(`DK Gold server running on port ${PORT}`));
