import json, os, sys, wave
import numpy as np
from faster_whisper import WhisperModel

model_name = os.environ.get("WHISPER_MODEL", "small")
lang = os.environ.get("WHISPER_LANG") or None
print(json.dumps({"status": "loading", "model": model_name}), flush=True)
model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=min(8, os.cpu_count() or 4))
print(json.dumps({"status": "ready"}), flush=True)

for line in sys.stdin:
    path = line.strip()
    if not path:
        continue
    try:
        with wave.open(path, 'rb') as w:
            audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        segs, _ = model.transcribe(audio, language=lang, beam_size=1, vad_filter=True, condition_on_previous_text=False)
        print(json.dumps({"text": " ".join(s.text.strip() for s in segs).strip()}, ensure_ascii=False), flush=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
    finally:
        try: os.remove(path)
        except OSError: pass
