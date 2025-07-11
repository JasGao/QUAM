// QUAM Youtube Transcript App JS

import { API_KEYS } from './api-key.js';

function extractVideoId(url) {
  // Handles various YouTube URL formats
  const match = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/
  );
  return match ? match[1] : null;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

async function fetchWithKeyRotation(videoId, lang) {
  let lastError = null;
  for (let i = 0; i < API_KEYS.length; i++) {
    try {
      const response = await fetch(`https://youtube-transcriptor.p.rapidapi.com/transcript?video_id=${videoId}&lang=${lang}`, {
        method: 'GET',
        headers: {
          'x-rapidapi-host': 'youtube-transcriptor.p.rapidapi.com',
          'x-rapidapi-key': API_KEYS[i],
        },
      });
      if (response.status === 429) continue; // Try next key
      if (!response.ok) throw new Error(await response.text());
      return await response.json();
    } catch (err) {
      lastError = err;
      if (!err.message.includes('429')) break;
    }
  }
  throw lastError || new Error('All API keys exhausted or invalid.');
}

async function fetchWhisperTranscript(youtubeUrl, lang, transcriptBox) {
  transcriptBox.textContent = 'Transcribing audio with Whisper... (this may take a while)';
  try {
    // Start the job
    const startRes = await fetch('http://localhost:8000/transcribe-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: youtubeUrl, lang }),
    });
    if (!startRes.ok) {
      const error = await startRes.text();
      throw new Error(error);
    }
    const { job_id } = await startRes.json();
    // Poll for result
    let attempts = 0;
    let done = false;
    while (!done && attempts < 120) { // up to 10 minutes if polling every 5s
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await fetch(`http://localhost:8000/transcribe-job/${job_id}`);
      if (!pollRes.ok) {
        const error = await pollRes.text();
        throw new Error(error);
      }
      const job = await pollRes.json();
      console.log('Polled job status:', job);
      if (job.status === 'done') {
        transcriptBox.textContent = (job.transcript || 'No transcript found in audio.') + '\n\n(Transcribed by Whisper)';
        transcriptBox.style.color = '#222';
        done = true;
      } else if (job.status === 'error') {
        showToast('Whisper error: ' + (job.error || 'Unknown error'));
        transcriptBox.textContent = '';
        done = true;
      } else {
        transcriptBox.textContent = 'Transcribing audio with Whisper... (this may take a while)';
      }
      attempts++;
    }
    if (!done) {
      showToast('Whisper transcription timed out.');
      transcriptBox.textContent = '';
    }
  } catch (err) {
    showToast('Whisper error: ' + (err.message || err));
    transcriptBox.textContent = '';
  }
}

document.getElementById('transcript-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const url = document.getElementById('youtube-url').value.trim();
  const lang = document.getElementById('language-select').value;
  const transcriptBox = document.getElementById('transcript-box');
  transcriptBox.textContent = '';

  const videoId = extractVideoId(url);
  if (!videoId) {
    transcriptBox.textContent = 'Invalid YouTube URL.';
    transcriptBox.style.color = 'red';
    return;
  }

  transcriptBox.textContent = 'Loading...';
  transcriptBox.style.color = '#222';

  try {
    // 1. Try RapidAPI
    const data = await fetchWithKeyRotation(videoId, lang);
    console.log('API response:', data);
    if (Array.isArray(data) && data[0] && data[0].transcriptionAsText) {
      transcriptBox.textContent = data[0].transcriptionAsText;
      transcriptBox.style.color = '#222';
      return;
    }
    // 2. Fallback to Whisper if no transcript found
    await fetchWhisperTranscript(url, lang, transcriptBox);
  } catch (err) {
    // 2. Fallback to Whisper if RapidAPI fails
    await fetchWhisperTranscript(url, lang, transcriptBox);
  }
}); 