// QUAM Youtube Transcript App JS

import { API_KEYS, AUDIO_API_KEYS } from './api-key.js';

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

// --- Add: RapidAPI audio download function ---
async function downloadAudioWithRapidAPI(videoId) {
  const RAPIDAPI_AUDIO_URL = 'https://youtube-video-fast-downloader-24-7.p.rapidapi.com/download_audio';
  let lastError = null;
  for (let i = 0; i < AUDIO_API_KEYS.length; i++) {
    try {
      // Build the full URL with videoId and quality
      const url = `${RAPIDAPI_AUDIO_URL}/${videoId}?quality=251`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-rapidapi-key': AUDIO_API_KEYS[i],
          'x-rapidapi-host': 'youtube-video-fast-downloader-24-7.p.rapidapi.com'
        }
      });
      if (response.status === 429) continue;
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      if (!data.file) throw new Error('No audio file URL in API response.');
      // Now fetch the audio file as a blob
      const audioRes = await fetch(`https://quamyo.duckdns.org/proxy-audio?url=${encodeURIComponent(data.file)}`);
      if (!audioRes.ok) throw new Error('Failed to download audio file.');
      const blob = await audioRes.blob();
      return blob;
    } catch (err) {
      lastError = err;
      if (!err.message.includes('429')) break;
    }
  }
  throw lastError || new Error('All audio API keys exhausted or invalid.');
}

// --- Add: Send audio to backend for Whisper transcription ---
async function transcribeAudioBlob(audioBlob, lang, transcriptBox) {
  transcriptBox.textContent = 'Uploading audio and transcribing with Whisper...';
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.mp3');
  formData.append('lang', lang);
  try {
    const response = await fetch('https://quamyo.duckdns.org/transcribe-audio', {
      method: 'POST',
      body: formData
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    if (data.transcript) {
      transcriptBox.textContent = data.transcript + '\n\n(Transcribed by Whisper)';
      transcriptBox.style.color = '#222';
    } else {
      showToast('No transcript returned.');
      transcriptBox.textContent = '';
    }
  } catch (err) {
    showToast('Audio transcription error: ' + (err.message || err));
    transcriptBox.textContent = '';
  }
}

// --- Add: Show/hide manual upload section ---
function showManualUploadSection(show) {
  const section = document.getElementById('manual-upload-section');
  if (section) section.style.display = show ? '' : 'none';
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
        let errorMsg = job.error || 'Unknown error';
        if (errorMsg.includes('Sign in to confirm you’re not a bot')) {
          showToast('Due to YouTube restrictions, you need to download the video manually and upload it here for transcription.');
        } else {
          showToast('Whisper error: ' + errorMsg);
        }
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
    let errorMsg = err.message || err;
    if (typeof errorMsg === 'string' && errorMsg.includes('Sign in to confirm you’re not a bot')) {
      showToast('Due to YouTube restrictions, you need to download the video manually and upload it here for transcription.');
    } else {
      showToast('Whisper error: ' + errorMsg);
    }
    transcriptBox.textContent = '';
    if (whisperLoading) whisperLoading.style.display = 'none';
    if (whisperProgressMsg) whisperProgressMsg.textContent = '';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (progressDiv) progressDiv.textContent = '';
    currentJobId = null;
  }
}

// --- Add: Main workflow update ---
document.getElementById('transcript-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const url = document.getElementById('youtube-url').value.trim();
  const lang = document.getElementById('language-select').value;
  const transcriptBox = document.getElementById('transcript-box');
  showManualUploadSection(false);
  transcriptBox.textContent = '';
  transcriptBox.style.color = '#222';

  const videoId = extractVideoId(url);
  if (!videoId) {
    transcriptBox.textContent = 'Invalid YouTube URL.';
    transcriptBox.style.color = 'red';
    return;
  }

  transcriptBox.textContent = 'Loading...';

  // 1. Try RapidAPI transcript
  let rapidApiLang = lang;
  if (lang === 'zh-Hant') rapidApiLang = 'zh-HK';
  try {
    const data = await fetchWithKeyRotation(videoId, rapidApiLang);
    if (Array.isArray(data) && data[0] && data[0].transcriptionAsText) {
      transcriptBox.textContent = data[0].transcriptionAsText;
      transcriptBox.style.color = '#222';
      return;
    }
  } catch (err) {
    // ignore, try next step
  }

  // 2. Try to download audio via RapidAPI and send to backend
  try {
    transcriptBox.textContent = 'Trying to download audio for Whisper transcription...';
    const audioBlob = await downloadAudioWithRapidAPI(videoId);
    await transcribeAudioBlob(audioBlob, lang, transcriptBox);
    return;
  } catch (err) {
    showToast('Automatic audio download failed: ' + (err.message || err));
    transcriptBox.textContent = '';
  }

  // 3. Show manual upload section
  showToast('Unable to get transcript or audio automatically. Please upload audio file for transcription.');
  showManualUploadSection(true);
});

// --- Add: Manual audio upload handler ---
document.getElementById('audio-upload-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const fileInput = document.getElementById('audio-file');
  const transcriptBox = document.getElementById('transcript-box');
  const lang = document.getElementById('language-select').value;
  if (!fileInput.files || !fileInput.files[0]) {
    showToast('Please select an audio file.');
    return;
  }
  const audioBlob = fileInput.files[0];
  await transcribeAudioBlob(audioBlob, lang, transcriptBox);
});

// Cancel button handler
document.getElementById('cancel-btn').onclick = async function() {
  if (currentJobId) {
    await fetch(`http://8.222.227.197:8000/transcribe-job/${currentJobId}/cancel`, { method: 'POST' });
    showToast('Cancel requested.');
  }
};

// Cancel any running job if the page is reloaded or closed
window.addEventListener('beforeunload', async function (e) {
  if (currentJobId) {
    // Use navigator.sendBeacon for reliability on unload
    navigator.sendBeacon(
      `http://8.222.227.197:8000/transcribe-job/${currentJobId}/cancel`
    );
    currentJobId = null;
  }
}); 
