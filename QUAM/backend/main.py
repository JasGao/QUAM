from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import yt_dlp
import whisper
import os
import uuid
import threading
from pydub import AudioSegment

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