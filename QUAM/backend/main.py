from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import yt_dlp
import whisper
import os
import uuid
import threading
from pydub import AudioSegment
from fastapi import UploadFile, File, Form
from fastapi.responses import JSONResponse
import requests
from fastapi.responses import StreamingResponse
from fastapi.responses import FileResponse
import tempfile
import subprocess

app = FastAPI()

# Allow CORS for all origins (for development)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For development, allows all origins. For production, use your frontend URL.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class VideoRequest(BaseModel):
    url: str
    lang: str = None
    model: str = "small"

# In-memory job store (for demo; use Redis or DB for production)
jobs = {}

def split_audio(audio_filename, chunk_length_ms=300000):  # 5 minutes
    audio = AudioSegment.from_file(audio_filename)
    chunks = []
    for i in range(0, len(audio), chunk_length_ms):
        chunk = audio[i:i+chunk_length_ms]
        chunk_filename = f"{audio_filename}_chunk_{i//chunk_length_ms}.mp3"
        chunk.export(chunk_filename, format="mp3")
        chunks.append(chunk_filename)
    return chunks

def transcribe_job(job_id, url, lang=None):
    print(f"Starting job {job_id} for URL: {url} with lang: {lang} and model: small")
    audio_filename = f"audio_{uuid.uuid4()}.mp3"
    try:
        ydl_opts = {
            'format': 'bestaudio/best',
            'outtmpl': audio_filename,
            'quiet': True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        print(f"Downloaded audio to {audio_filename}")

        model = whisper.load_model('small')
        print(f"Loaded Whisper model: small")

        # Split audio into chunks
        chunk_files = split_audio(audio_filename)
        jobs[job_id]["audio_filename"] = audio_filename
        jobs[job_id]["chunk_files"] = chunk_files

        partial_transcript = ""
        for idx, chunk_file in enumerate(chunk_files):
            if jobs[job_id].get("cancelled"):
                jobs[job_id] = {"status": "cancelled", "transcript": partial_transcript}
                print(f"Job {job_id} cancelled by user.")
                break
            print(f"Transcribing chunk {idx+1}/{len(chunk_files)}: {chunk_file}")

            # --- Language normalization ---
            if lang and lang.lower() in ["zh-hant", "zh-hans"]:
                lang = "zh"
            # ------------------------------

            result = model.transcribe(chunk_file, language=lang)
            partial_transcript += result["text"] + "\n"
            jobs[job_id].update({
                "status": "processing",
                "transcript": partial_transcript,
                "current_chunk": idx+1,
                "total_chunks": len(chunk_files)
            })
            os.remove(chunk_file)  # Clean up chunk file after use

        if not jobs[job_id].get("cancelled"):
            jobs[job_id] = {"status": "done", "transcript": partial_transcript}
            print(f"Job {job_id} done")
    except Exception as e:
        jobs[job_id] = {"status": "error", "error": str(e)}
        print(f"Job {job_id} error: {e}")
    finally:
        # Always clean up the main audio file
        if os.path.exists(audio_filename):
            os.remove(audio_filename)
            print(f"Cleaned up {audio_filename}")

@app.post("/transcribe-job")
async def start_transcription(req: VideoRequest):
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "processing", "cancelled": False}
    threading.Thread(target=transcribe_job, args=(job_id, req.url, req.lang), daemon=True).start()
    return {"job_id": job_id}

@app.post("/transcribe-job/{job_id}/cancel")
async def cancel_transcription(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job["cancelled"] = True
    # Clean up audio files if they exist
    audio_filename = job.get("audio_filename")
    if audio_filename and os.path.exists(audio_filename):
        os.remove(audio_filename)
        print(f"Cleaned up {audio_filename} (cancelled)")
    chunk_files = job.get("chunk_files", [])
    for chunk_file in chunk_files:
        if os.path.exists(chunk_file):
            os.remove(chunk_file)
            print(f"Cleaned up {chunk_file} (cancelled)")
    return {"status": "cancelled"}

@app.get("/transcribe-job/{job_id}")
async def get_transcription(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

# --- New: /transcribe-audio endpoint for direct audio file upload ---
# --- Utility: Convert webm to mp3 using ffmpeg ---
def convert_to_mp3(input_path, output_path):
    subprocess.run([
        "ffmpeg", "-y", "-i", input_path, output_path
    ], check=True)

@app.post("/transcribe-audio")
async def transcribe_audio(file: UploadFile = File(...), lang: str = Form(None)):
    temp_audio_filename = f"uploaded_{uuid.uuid4()}.mp3"
    try:
        # Save uploaded file
        with open(temp_audio_filename, "wb") as f:
            content = await file.read()
            f.write(content)
        print("Saved uploaded file")

        # If the file is .webm, convert to .mp3
        if file.filename.endswith('.webm'):
            mp3_path = temp_audio_filename.replace('.mp3', '_converted.mp3')
            convert_to_mp3(temp_audio_filename, mp3_path)
            audio_path = mp3_path
        else:
            audio_path = temp_audio_filename

        model = whisper.load_model('small')
        print("Before splitting audio")
        chunk_files = split_audio(audio_path)
        print("Splitting audio")
        partial_transcript = ""
        for idx, chunk_file in enumerate(chunk_files):
            # --- Language normalization ---
            lang_norm = lang
            if lang and lang.lower() in ["zh-hant", "zh-hans"]:
                lang_norm = "zh"
            # ------------------------------
            result = model.transcribe(chunk_file, language=lang_norm)
            partial_transcript += result["text"] + "\n"
            os.remove(chunk_file)  # Clean up chunk file after use
        print("Starting transcription")
        print("Finished transcription")

        return JSONResponse({"transcript": partial_transcript.strip()})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        if os.path.exists(temp_audio_filename):
            os.remove(temp_audio_filename)
        if file.filename.endswith('.webm'):
            if os.path.exists(mp3_path):
                os.remove(mp3_path)

@app.get("/proxy-audio")
def proxy_audio(url: str):
    print(f"Proxying audio from: {url}")
    headers = {
        "User-Agent": "Mozilla/5.0"
    }
    r = requests.get(url, headers=headers)
    print(f"Downloaded audio response: {r.status_code}")
    if r.status_code != 200:
        return JSONResponse({"error": "Failed to fetch audio"}, status_code=500)
    with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp:
        tmp.write(r.content)
        tmp_path = tmp.name
    return FileResponse(tmp_path, media_type="audio/webm") 