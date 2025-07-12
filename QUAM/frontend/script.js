// QUAM Youtube Transcript App JS

import { API_KEYS } from './api-key.js';

function extractVideoId(url) {
  // Handles various YouTube URL formats including live
  const match = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/|live\/))([\w-]{11})/
  );
  return match ? match[1] : null;
}

function isLiveStream(url) {
  return url.includes('/live/');
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

let currentJobId = null;

async function fetchWhisperTranscript(youtubeUrl, lang, transcriptBox, model = 'small') {
  transcriptBox.textContent = 'Transcribing audio with Whisper... (this may take a while)';
  const cancelBtn = document.getElementById('cancel-btn');
  const progressDiv = document.getElementById('progress');
  const whisperLoading = document.getElementById('whisper-loading');
  const whisperProgressMsg = document.getElementById('whisper-progress-msg');
  if (whisperLoading) whisperLoading.style.display = 'inline-block';

  try {
    const startRes = await fetch('https://quamyo.duckdns.org/transcribe-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: youtubeUrl, lang, model }),
    });
    if (!startRes.ok) {
      const error = await startRes.text();
      if (whisperLoading) whisperLoading.style.display = 'none';
      if (whisperProgressMsg) whisperProgressMsg.textContent = '';
      throw new Error(error);
    }
    const { job_id } = await startRes.json();
    currentJobId = job_id;
    if (cancelBtn) cancelBtn.style.display = 'inline-block';

    let attempts = 0;
    let done = false;
    const maxAttempts = isLiveStream(youtubeUrl) ? 300 : 120;
    let lastTranscript = ""; // Track what has already been shown

    while (!done && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await fetch(`https://quamyo.duckdns.org/transcribe-job/${job_id}`);
      if (!pollRes.ok) {
        const error = await pollRes.text();
        if (whisperLoading) whisperLoading.style.display = 'none';
        if (whisperProgressMsg) whisperProgressMsg.textContent = '';
        throw new Error(error);
      }
      const job = await pollRes.json();
      console.log('Polled job status:', job);

      // --- Update the label progress message ---
      if (whisperProgressMsg && job.current_chunk && job.total_chunks) {
        whisperProgressMsg.textContent = `Whisper is working... (${job.current_chunk}/${job.total_chunks})`;
      }

      // Show new transcript as it arrives
      if (job.transcript && job.transcript.length > lastTranscript.length) {
        // Only append the new part
        const newText = job.transcript.substring(lastTranscript.length);
        transcriptBox.textContent += newText;
        lastTranscript = job.transcript;
      }

      if (job.status === 'done') {
        transcriptBox.textContent += '\n\n(Transcribed by Whisper)';
        transcriptBox.style.color = '#222';
        done = true;
        if (whisperLoading) whisperLoading.style.display = 'none';
        if (whisperProgressMsg) whisperProgressMsg.textContent = '';
      } else if (job.status === 'error') {
        showToast('Whisper error: ' + (job.error || 'Unknown error'));
        transcriptBox.textContent = '';
        done = true;
        if (whisperLoading) whisperLoading.style.display = 'none';
        if (whisperProgressMsg) whisperProgressMsg.textContent = '';
      } else if (job.status === 'cancelled') {
        showToast('Transcription cancelled.');
        transcriptBox.textContent = job.transcript || '';
        done = true;
        if (whisperLoading) whisperLoading.style.display = 'none';
        if (whisperProgressMsg) whisperProgressMsg.textContent = '';
      } else if (!job.transcript) {
        transcriptBox.textContent = 'Transcribing audio with Whisper... (this may take a while)';
      }
      attempts++;
    }
    if (whisperLoading) whisperLoading.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (progressDiv) progressDiv.textContent = '';
    currentJobId = null;
    if (!done) {
      showToast('Whisper transcription timed out.');
      transcriptBox.textContent = '';
      if (whisperLoading) whisperLoading.style.display = 'none';
      if (whisperProgressMsg) whisperProgressMsg.textContent = '';
    }
  } catch (err) {
    showToast('Whisper error: ' + (err.message || err));
    transcriptBox.textContent = '';
    if (whisperLoading) whisperLoading.style.display = 'none';
    if (whisperProgressMsg) whisperProgressMsg.textContent = '';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (progressDiv) progressDiv.textContent = '';
    currentJobId = null;
  }
}

document.getElementById('transcript-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const url = document.getElementById('youtube-url').value.trim();
  const lang = document.getElementById('language-select').value;
  const transcriptBox = document.getElementById('transcript-box');
  const progressDiv = document.getElementById('progress');
  const cancelBtn = document.getElementById('cancel-btn');

  if (currentJobId) {
    await fetch(`http://localhost:8000/transcribe-job/${currentJobId}/cancel`, { method: 'POST' });
    showToast('Previous transcription cancelled.');
    currentJobId = null;
  }

  transcriptBox.textContent = '';

  const videoId = extractVideoId(url);
  if (!videoId) {
    transcriptBox.textContent = 'Invalid YouTube URL.';
    transcriptBox.style.color = 'red';
    return;
  }

  transcriptBox.textContent = 'Loading...';
  transcriptBox.style.color = '#222';

  if (isLiveStream(url) && videoId) {
    showToast('Live stream detected. Using Whisper for transcription...');
    await fetchWhisperTranscript(url, lang, transcriptBox);
    return;
  }

  let rapidApiLang = lang;
  if (lang === 'zh-Hant') rapidApiLang = 'zh-HK';

  try {
    const data = await fetchWithKeyRotation(videoId, rapidApiLang);
    console.log('API response:', data);
    if (Array.isArray(data) && data[0] && data[0].transcriptionAsText) {
      transcriptBox.textContent = data[0].transcriptionAsText;
      transcriptBox.style.color = '#222';
      return;
    }
    await fetchWhisperTranscript(url, lang, transcriptBox);
  } catch (err) {
    await fetchWhisperTranscript(url, lang, transcriptBox);
  }
});

// Cancel button handler
document.getElementById('cancel-btn').onclick = async function() {
  if (currentJobId) {
    await fetch(`http://localhost:8000/transcribe-job/${currentJobId}/cancel`, { method: 'POST' });
    showToast('Cancel requested.');
  }
};

// Cancel any running job if the page is reloaded or closed
window.addEventListener('beforeunload', async function (e) {
  if (currentJobId) {
    // Use navigator.sendBeacon for reliability on unload
    navigator.sendBeacon(
      `http://localhost:8000/transcribe-job/${currentJobId}/cancel`
    );
    currentJobId = null;
  }
}); 
