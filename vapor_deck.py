import sys
import os
import subprocess
import time
import argparse
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description="Vapor Deck CLI")
    parser.add_argument("path", help="Path to the project directory")
    args = parser.parse_args()

    project_path = Path(args.path).absolute()
    
    # 1. Initialize directory structure
    if not project_path.exists():
        print(f"[*] Creating project directory: {project_path}")
        project_path.mkdir(parents=True)
    
    (project_path / "assets").mkdir(exist_ok=True)
    (project_path / "slides").mkdir(exist_ok=True)

    print(f"[*] Project Path: {project_path}")

    # 2. Set environment variables for the backend
    os.environ["VAPOR_PROJECT_DIR"] = str(project_path)

    # 3. Start Backend (FastAPI)
    print("[*] Starting Backend (Port 8000)...")
    backend_proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"],
        cwd=Path(__file__).parent / "harness"
    )

    # 4. Start Frontend (Vite)
    print("[*] Starting Frontend...")
    frontend_proc = subprocess.Popen(
        ["npm.cmd", "run", "dev"],
        cwd=Path(__file__).parent / "front"
    )

    print("\n[!] Vapor Deck is running!")
    print("[!] Backend: http://localhost:8000")
    print("[!] Frontend: http://localhost:5173")
    print("[!] Press Ctrl+C to stop.\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[*] Shutting down...")
        backend_proc.terminate()
        frontend_proc.terminate()
        print("[*] Goodbye!")

if __name__ == "__main__":
    main()
